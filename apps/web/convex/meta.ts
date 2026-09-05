import { v } from "convex/values";
import { generateCode, okResult, errorResult, type PublishPayload } from "@automoney/shared";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { decryptField, encryptField } from "./lib/crypto";
import { fail } from "./lib/errors";
import { getMetaAdapter, metaMode, metaTokenKey, MetaApiError, type MetaPlatform } from "./lib/meta";
import { requireUser } from "./lib/rbac";
import { enqueueJob } from "./jobs";
import { recordPublishedPost } from "./analytics";

const platformValidator = v.union(v.literal("THREADS"), v.literal("INSTAGRAM"));
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_BEFORE_MS = 7 * 24 * 3600_000;

function redirectUri(): string {
  const base = process.env.META_REDIRECT_URI ?? `${process.env.CONVEX_SITE_URL ?? ""}/meta/callback`;
  return base;
}

// ───────────────────────────── 연결(OAuth) ─────────────────────────────

/** 대시보드 "Meta 로 연결": state 발급 → 인가 URL. mock 모드는 콜백으로 바로 돌아온다. */
export const connectStart = mutation({
  args: { platform: platformValidator },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!metaTokenKey()) fail("CONFIG_MISSING", "META_TOKEN_ENC_KEY(또는 KYC_ENC_KEY) 가 설정되지 않았습니다.");
    const state = generateCode(32);
    await ctx.db.insert("metaOauthStates", { userId: user._id, platform: args.platform, state, expiresAt: Date.now() + STATE_TTL_MS });
    await audit(ctx, { actorUserId: user._id, action: "meta.connect.start", metadata: { platform: args.platform, mode: metaMode() } });
    return { url: getMetaAdapter().authorizeUrl(args.platform, redirectUri(), state), mode: metaMode() };
  },
});

export const consumeState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("metaOauthStates").withIndex("by_state", (q) => q.eq("state", args.state)).unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt < Date.now()) return null;
    return { userId: row.userId, platform: row.platform };
  },
});

export const saveAccount = internalMutation({
  args: { userId: v.id("users"), platform: platformValidator, providerUserId: v.string(), username: v.optional(v.string()), tokenEnc: v.string(), tokenExpiresAt: v.number(), scopes: v.array(v.string()), mode: v.union(v.literal("mock"), v.literal("graph")) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = (await ctx.db.query("snsAccounts").withIndex("by_user", (q) => q.eq("userId", args.userId).eq("platform", args.platform)).collect()).find((a) => a.providerUserId === args.providerUserId);
    let accountId: Id<"snsAccounts">;
    if (existing) {
      accountId = existing._id;
      await ctx.db.patch(accountId, { tokenEnc: args.tokenEnc, tokenExpiresAt: args.tokenExpiresAt, scopes: args.scopes, status: "ACTIVE", username: args.username, mode: args.mode, lastError: undefined, lastRefreshedAt: now });
    } else {
      accountId = await ctx.db.insert("snsAccounts", { ...args, status: "ACTIVE", createdAt: now, lastRefreshedAt: now });
    }
    // 스페이스: 기존 연결 스페이스가 있으면 재사용, 없으면 API 전용 스페이스 생성(디바이스 불필요)
    let space = existing?.spaceId ? await ctx.db.get(existing.spaceId) : null;
    if (!space) {
      const spaceId = await ctx.db.insert("spaces", {
        userId: args.userId,
        platform: args.platform,
        name: `${args.platform === "THREADS" ? "스레드" : "인스타"} API${args.username ? ` @${args.username}` : ""}`.slice(0, 40),
        handle: args.username,
        pinned: false,
        sessionState: "HEALTHY",
        dailyPostLimit: args.platform === "THREADS" ? 5 : 3,
        authMode: "META_API",
        snsAccountId: accountId,
        lastCheckedAt: now,
        createdAt: now,
      });
      space = await ctx.db.get(spaceId);
    } else {
      await ctx.db.patch(space._id, { authMode: "META_API", snsAccountId: accountId, sessionState: "HEALTHY", handle: args.username ?? space.handle, lastError: undefined, lastCheckedAt: now });
    }
    await ctx.db.patch(accountId, { spaceId: space!._id });
    await audit(ctx, { actorUserId: args.userId, action: "meta.connect.done", metadata: { accountId, platform: args.platform, spaceId: space!._id, mode: args.mode } });
    return { accountId, spaceId: space!._id };
  },
});

/** GET /meta/callback?code=&state= */
export const callback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const site = process.env.SITE_URL ?? "";
  const back = (q: string) => new Response(null, { status: 302, headers: { location: `${site}/dashboard/spaces?meta=${q}` } });
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code) return back("error_missing");
  const st = await ctx.runMutation(internal.meta.consumeState, { state });
  if (!st) return back("error_state");
  const key = metaTokenKey();
  if (!key) return back("error_config");
  try {
    const adapter = getMetaAdapter();
    const tokens = await adapter.exchangeCode(st.platform, code, redirectUri());
    const me = await adapter.me(st.platform, tokens.accessToken);
    await ctx.runMutation(internal.meta.saveAccount, {
      userId: st.userId,
      platform: st.platform,
      providerUserId: me.providerUserId,
      username: me.username ?? undefined,
      tokenEnc: await encryptField(key, tokens.accessToken),
      tokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      mode: adapter.mode,
    });
    return back("connected");
  } catch (e) {
    return back(`error_${(e as MetaApiError).code ?? "exchange"}`);
  }
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const rows = await ctx.db.query("snsAccounts").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    return {
      mode: metaMode(),
      accounts: rows.map((a) => ({ _id: a._id, platform: a.platform, username: a.username ?? null, status: a.status, tokenExpiresAt: a.tokenExpiresAt, spaceId: a.spaceId ?? null, lastError: a.lastError ?? null, mode: a.mode, createdAt: a.createdAt })),
    };
  },
});

export const disconnect = mutation({
  args: { accountId: v.id("snsAccounts") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const a = await ctx.db.get(args.accountId);
    if (!a || a.userId !== user._id) fail("NOT_FOUND", "계정을 찾을 수 없습니다.");
    await ctx.db.patch(a._id, { status: "REVOKED", tokenEnc: "" });
    if (a.spaceId) {
      const s = await ctx.db.get(a.spaceId);
      if (s) await ctx.db.patch(s._id, { authMode: s.deviceId ? "BROWSER" : undefined, snsAccountId: undefined, sessionState: s.deviceId ? "LOGIN_REQUIRED" : "PAUSED" });
    }
    await audit(ctx, { actorUserId: user._id, action: "meta.disconnect", metadata: { accountId: a._id } });
  },
});

// ───────────────────────────── 클라우드 잡 실행 (발행 · 토큰 갱신) ─────────────────────────────

export const loadCloudJob = internalQuery({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const space = job.spaceId ? await ctx.db.get(job.spaceId) : null;
    const account = space?.snsAccountId ? await ctx.db.get(space.snsAccountId) : null;
    const user = await ctx.db.get(job.userId);
    const device = (await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", job.userId).eq("status", "ACTIVE")).collect())[0] ?? null;
    return { job, space, account, hasDevice: !!device, userEmail: user?.email ?? null };
  },
});

export const markRunning = internalMutation({
  args: { jobId: v.id("agentJobs"), stage: v.string() },
  handler: async (ctx, args) => {
    const j = await ctx.db.get(args.jobId);
    if (!j || j.status !== "QUEUED") return false;
    const now = Date.now();
    await ctx.db.patch(j._id, { status: "RUNNING", stage: args.stage, progress: 20, heartbeatAt: now, leaseUntil: now + 5 * 60_000, updatedAt: now });
    return true;
  },
});

/** 클라우드 잡 종료: 성공/실패 기록, 토큰 만료 시 계정 상태 갱신 + 브라우저 폴백 잡, 텔레그램 알림, readback 등록 */
export const completeCloudJob = internalMutation({
  args: { jobId: v.id("agentJobs"), status: v.union(v.literal("SUCCEEDED"), v.literal("FAILED")), result: v.optional(v.any()), errorCode: v.optional(v.string()), errorMessage: v.optional(v.string()), accountStatus: v.optional(v.union(v.literal("EXPIRED"), v.literal("REVOKED"))), fallback: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const j = await ctx.db.get(args.jobId);
    if (!j || j.status !== "RUNNING") return { ok: false as const };
    const now = Date.now();
    await ctx.db.patch(j._id, { status: args.status, result: args.result, errorCode: args.status === "FAILED" ? args.errorCode ?? "INTERNAL" : undefined, errorMessage: args.status === "FAILED" ? args.errorMessage : undefined, finishedAt: now, updatedAt: now, stage: "done", progress: 100 });
    const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
    if (space?.snsAccountId && args.accountStatus) {
      await ctx.db.patch(space.snsAccountId, { status: args.accountStatus, lastError: args.errorMessage });
      await ctx.db.patch(space._id, { lastError: args.errorMessage?.slice(0, 300), sessionState: space.deviceId ? "LOGIN_REQUIRED" : "EXPIRED" });
    }
    let fallbackJobId: Id<"agentJobs"> | null = null;
    if (args.fallback && j.jobType === "post.publish" && space?.deviceId) {
      // ADR-0004: 동일 페이로드로 브라우저 스페이스 경로 재큐
      fallbackJobId = await enqueueJob(ctx, { userId: j.userId, jobType: "post.publish", payload: j.payload as PublishPayload as unknown as Record<string, unknown>, spaceId: space._id, scheduleId: j.scheduleId, source: j.source, executor: "DESKTOP", fallbackFromJobId: j._id, needsApproval: false });
      await audit(ctx, { actorUserId: j.userId, action: "meta.fallback", metadata: { fromJobId: j._id, toJobId: fallbackJobId, reason: args.errorCode } });
    }
    if (args.status === "SUCCEEDED" && j.jobType === "post.publish") await recordPublishedPost(ctx, (await ctx.db.get(j._id))!);
    await ctx.scheduler.runAfter(0, internal.telegram.notifyJob, { jobId: j._id });
    return { ok: true as const, fallbackJobId };
  },
});

export const runCloudJob = internalAction({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.meta.loadCloudJob, { jobId: args.jobId });
    if (!loaded || loaded.job.status !== "QUEUED") return;
    const { job, space, account, hasDevice } = loaded;
    if (!(await ctx.runMutation(internal.meta.markRunning, { jobId: job._id, stage: job.jobType === "post.publish" ? "meta_publishing" : "meta_refreshing" }))) return;
    const key = metaTokenKey();
    const adapter = getMetaAdapter();
    type Finish = { status: "SUCCEEDED" | "FAILED"; result?: unknown; errorCode?: string; errorMessage?: string; accountStatus?: "EXPIRED" | "REVOKED"; fallback?: boolean };
    const finish = (input: Finish) => ctx.runMutation(internal.meta.completeCloudJob, { jobId: job._id, ...input });
    if (!account || !space || !key) {
      await finish({ status: "FAILED", errorCode: "META_NOT_CONNECTED", errorMessage: "Meta 계정이 연결되어 있지 않습니다.", result: errorResult(job.jobType, "META_NOT_CONNECTED", "not connected"), fallback: hasDevice });
      return;
    }
    let token: string;
    try {
      token = await decryptField(key, account.tokenEnc);
    } catch {
      await finish({ status: "FAILED", errorCode: "META_TOKEN_EXPIRED", errorMessage: "토큰 복호화 실패", accountStatus: "REVOKED", fallback: hasDevice });
      return;
    }
    try {
      if (job.jobType === "meta.token_refresh") {
        const t = await adapter.refreshLongLived(account.platform, token);
        await ctx.runMutation(internal.meta.storeRefreshedToken, { accountId: account._id, tokenEnc: await encryptField(key, t.accessToken), tokenExpiresAt: t.expiresAt });
        await finish({ status: "SUCCEEDED", result: okResult("meta.token_refresh", "토큰 갱신", { expiresAt: t.expiresAt }) });
        return;
      }
      const p = job.payload as PublishPayload & { dryRun?: boolean };
      if (p.dryRun) {
        await finish({ status: "SUCCEEDED", result: okResult("post.publish", "드라이런(Meta API) — 게시하지 않음", { dryRun: true, authMode: "META_API" }) });
        return;
      }
      const profile = await adapter.me(account.platform, token);
      const published = await adapter.publish(token, profile, { platform: account.platform as MetaPlatform, text: p.text, mediaUrls: p.mediaUrls, linkUrl: p.linkUrl ?? null });
      await finish({ status: "SUCCEEDED", result: okResult("post.publish", `Meta API 게시 완료 (${account.platform})`, { postUrl: published.postUrl, externalPostId: published.externalPostId, authMode: "META_API", mode: adapter.mode }) });
    } catch (e) {
      const err = e instanceof MetaApiError ? e : new MetaApiError("META_PUBLISH_FAILED", (e as Error).message);
      const tokenProblem = err.code === "META_TOKEN_EXPIRED" || err.code === "META_PERMISSION";
      await finish({
        status: "FAILED",
        errorCode: err.code,
        errorMessage: err.message,
        result: errorResult(job.jobType, err.code, err.message),
        accountStatus: tokenProblem ? "EXPIRED" : undefined,
        fallback: job.jobType === "post.publish" && hasDevice && (tokenProblem || !err.retryable),
      });
    }
  },
});

export const storeRefreshedToken = internalMutation({
  args: { accountId: v.id("snsAccounts"), tokenEnc: v.string(), tokenExpiresAt: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, { tokenEnc: args.tokenEnc, tokenExpiresAt: args.tokenExpiresAt, status: "ACTIVE", lastRefreshedAt: Date.now(), lastError: undefined });
  },
});

/** 크론(일 1회): 만료 7일 전 계정에 meta.token_refresh 잡 */
export const scheduleRefreshes = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const due = await ctx.db.query("snsAccounts").withIndex("by_status_expiry", (q) => q.eq("status", "ACTIVE").lte("tokenExpiresAt", now + REFRESH_BEFORE_MS)).collect();
    let created = 0;
    for (const a of due) {
      if (!a.spaceId) continue;
      await enqueueJob(ctx, { userId: a.userId, jobType: "meta.token_refresh", payload: { accountId: a._id, platform: a.platform }, spaceId: a.spaceId, source: "SYSTEM", executor: "CLOUD", idempotencyKey: `meta.refresh:${a._id}:${Math.floor(now / 86_400_000)}` });
      created++;
    }
    return { created, due: due.length };
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return { mode: metaMode(), appConfigured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET), redirectUri: redirectUri() };
  },
});

export type SnsAccountDoc = Doc<"snsAccounts">;
