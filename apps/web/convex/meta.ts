import { v } from "convex/values";
import { generateCode, okResult, errorResult, type PublishPayload } from "@automoney/shared";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { decryptField, encryptField } from "./lib/crypto";
import { fail } from "./lib/errors";
import { getMetaAdapter, metaLivePublishAvailable, metaMode, metaTokenKey, MetaApiError, type MetaPlatform } from "./lib/meta";
import { requireUser } from "./lib/rbac";
import { enqueueJob } from "./jobs";
import { recordPublishedPost } from "./analytics";
import { publishReceiptUrl } from "./lib/publishReceipt";
import { normalizedHandle } from "./lib/publishIdentity";
import { livePublishEnabled } from "./lib/publishPolicy";
import { validatePublishAttemptPolicy } from "./lib/publishAttempt";

const platformValidator = v.union(v.literal("THREADS"), v.literal("INSTAGRAM"));
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_BEFORE_MS = 7 * 24 * 3600_000;
const REFRESH_BATCH_SIZE = 25;

class MetaPrecommitDenied extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

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
    if (livePublishEnabled() && !metaLivePublishAvailable()) fail("CONFIG_MISSING", "실게시 활성 환경에서는 META_MODE=graph와 Meta 앱 자격증명이 필요합니다. Mock 연결은 허용되지 않습니다.");
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
    const username = args.username?.trim().replace(/^@/, "").toLowerCase() || undefined;
    const providerAccounts = await ctx.db
      .query("snsAccounts")
      .withIndex("by_provider", (q) => q.eq("platform", args.platform).eq("providerUserId", args.providerUserId))
      .collect();
    if (providerAccounts.some((account) => account.userId !== args.userId))
      fail("CONFLICT", "이 SNS 계정은 이미 다른 Automoney 사용자에게 연결되어 있습니다.");
    const existing = providerAccounts.find((account) => account.userId === args.userId)
      ?? (await ctx.db.query("snsAccounts").withIndex("by_user", (q) => q.eq("userId", args.userId).eq("platform", args.platform)).collect()).find((a) => a.providerUserId === args.providerUserId);
    let accountId: Id<"snsAccounts">;
    if (existing) {
      accountId = existing._id;
      await ctx.db.patch(accountId, { tokenEnc: args.tokenEnc, tokenExpiresAt: args.tokenExpiresAt, scopes: args.scopes, status: "ACTIVE", username, mode: args.mode, lastError: undefined, lastRefreshedAt: now });
    } else {
      accountId = await ctx.db.insert("snsAccounts", { ...args, username, status: "ACTIVE", createdAt: now, lastRefreshedAt: now });
    }
    // 스페이스: 기존 연결 스페이스가 있으면 재사용, 없으면 API 전용 스페이스 생성(디바이스 불필요)
    let space = existing?.spaceId ? await ctx.db.get(existing.spaceId) : null;
    if (!space) {
      const spaceId = await ctx.db.insert("spaces", {
        userId: args.userId,
        platform: args.platform,
        name: `${args.platform === "THREADS" ? "스레드" : "인스타"} API${username ? ` @${username}` : ""}`.slice(0, 40),
        handle: username,
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
      await ctx.db.patch(space._id, { authMode: "META_API", snsAccountId: accountId, sessionState: "HEALTHY", handle: username ?? space.handle, lastError: undefined, lastCheckedAt: now });
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
      accounts: rows.map((a) => ({ _id: a._id, platform: a.platform, username: a.username ?? null, status: a.status, tokenExpiresAt: a.tokenExpiresAt, spaceId: a.spaceId ?? null, fallbackSpaceId: a.fallbackSpaceId ?? null, lastError: a.lastError ?? null, mode: a.mode, createdAt: a.createdAt })),
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

export const setFallbackSpace = mutation({
  args: { accountId: v.id("snsAccounts"), fallbackSpaceId: v.optional(v.id("spaces")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== user._id) fail("NOT_FOUND", "계정을 찾을 수 없습니다.");
    if (!args.fallbackSpaceId) {
      await ctx.db.patch(account._id, { fallbackSpaceId: undefined });
      return { ok: true as const };
    }
    const target = await ctx.db.get(args.fallbackSpaceId);
    if (!target || target.userId !== user._id) fail("NOT_FOUND", "폴백 스페이스를 찾을 수 없습니다.");
    if (target.platform !== account.platform || !target.deviceId || target.authMode === "META_API" || target.sessionState !== "HEALTHY") fail("INVALID_ARGUMENT", "같은 플랫폼의 정상 브라우저 스페이스만 폴백으로 지정할 수 있습니다.");
    if (!account.username || !target.handle || account.username.toLowerCase() !== target.handle.toLowerCase()) fail("INVALID_ARGUMENT", "검증된 동일 계정의 스페이스만 폴백으로 지정할 수 있습니다.");
    await ctx.db.patch(account._id, { fallbackSpaceId: target._id });
    return { ok: true as const };
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
    await ctx.db.patch(j._id, { status: "RUNNING", stage: args.stage, progress: 20, heartbeatAt: now, leaseUntil: now + 5 * 60_000, publishAttemptedAt: undefined, updatedAt: now });
    return true;
  },
});

export const markCloudPublishAttempted = internalMutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = await ctx.db.get(args.jobId);
    if (!job) return false;
    const policy = await validatePublishAttemptPolicy(ctx, job, now);
    if (!policy.ok) return false;
    await ctx.db.patch(job._id, { publishAttemptedAt: now, stage: "meta_publish_attempted", updatedAt: now });
    return true;
  },
});

export const syncPublishingIdentity = internalMutation({
  args: { accountId: v.id("snsAccounts"), spaceId: v.id("spaces"), providerUserId: v.string(), username: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    const space = await ctx.db.get(args.spaceId);
    if (!account || !space || space.snsAccountId !== account._id || account.spaceId !== space._id) return false;
    if (account.providerUserId !== args.providerUserId) return false;
    const username = args.username?.trim().replace(/^@/, "").toLowerCase() || undefined;
    await ctx.db.patch(account._id, { ...(username ? { username } : {}), lastRefreshedAt: Date.now() });
    if (username) await ctx.db.patch(space._id, { handle: username, lastCheckedAt: Date.now() });
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
    if (j.jobType === "post.publish" && j.cancelRequested && !j.publishAttemptedAt) {
      await ctx.db.patch(j._id, {
        status: "CANCELLED",
        publishPhase: "PREPARING",
        errorCode: "JOB_CANCELLED",
        errorMessage: "게시 API 호출 전에 사용자가 작업을 취소했습니다.",
        finishedAt: now,
        updatedAt: now,
        stage: "done",
        progress: 100,
      });
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", j.rootJobId ?? j._id)).unique();
      if (reservation && reservation.state !== "COMMITTED") await ctx.db.patch(reservation._id, { state: "RELEASED" });
      const cancelledSpace = j.spaceId ? await ctx.db.get(j.spaceId) : null;
      if (cancelledSpace?.snsAccountId && args.accountStatus) {
        await ctx.db.patch(cancelledSpace.snsAccountId, { status: args.accountStatus, lastError: args.errorMessage });
        await ctx.db.patch(cancelledSpace._id, { lastError: args.errorMessage?.slice(0, 300), sessionState: cancelledSpace.deviceId ? "LOGIN_REQUIRED" : "EXPIRED" });
      }
      await ctx.scheduler.runAfter(0, internal.telegram.notifyJob, { jobId: j._id });
      return { ok: true as const, fallbackJobId: null };
    }
    if (args.status === "SUCCEEDED" && j.jobType === "post.publish") {
      const payload = j.payload as PublishPayload;
      const intent = j.publishIntentId ? await ctx.db.get(j.publishIntentId) : null;
      const validPreflight = j.publishPhase === "INTENT_RECORDED"
        && !!j.payloadHash
        && j.publishPreflightPayloadHash === j.payloadHash
        && (payload.dryRun === true || (
          !!intent
          && intent.rootJobId === (j.rootJobId ?? j._id)
          && intent.state === "RESERVED"
          && intent.expiresAt >= now
        ));
      if (!validPreflight) {
        await ctx.db.patch(j._id, {
          status: "FAILED",
          publishPhase: "UNCERTAIN",
          errorCode: "PREFLIGHT_REQUIRED",
          errorMessage: "서버 게시 사전검증을 확인할 수 없어 성공 결과를 확정하지 않았습니다.",
          finishedAt: now,
          updatedAt: now,
          stage: "done",
          progress: 100,
        });
        if (intent && intent.state !== "COMMITTED") await ctx.db.patch(intent._id, { state: "UNCERTAIN" });
        await ctx.scheduler.runAfter(0, internal.telegram.notifyJob, { jobId: j._id });
        return { ok: false as const, reason: "PREFLIGHT_REQUIRED" };
      }
    }
    const publishPayload = j.jobType === "post.publish" ? j.payload as PublishPayload : null;
    const attemptMarkerMissing = publishPayload !== null
      && args.status === "SUCCEEDED"
      && publishPayload.dryRun !== true
      && !j.publishAttemptedAt;
    const receiptMissing = publishPayload !== null
      && args.status === "SUCCEEDED"
      && publishPayload.dryRun !== true
      // The canonical permalink was fetched from the provider using the
      // verified provider account id. A username rename must not change the
      // immutable account target.
      && !publishReceiptUrl(publishPayload.platform, args.result);
    const effectiveStatus = receiptMissing || attemptMarkerMissing ? "FAILED" as const : args.status;
    let effectiveErrorCode = attemptMarkerMissing ? "PUBLISH_ATTEMPT_MISSING" : receiptMissing ? "PUBLISH_RECEIPT_MISSING" : args.errorCode;
    let effectiveErrorMessage = attemptMarkerMissing
      ? "Meta 게시 API 호출 직전 서버 승인 기록이 없어 성공 결과를 확정할 수 없습니다. 계정에서 직접 확인하세요."
      : receiptMissing
        ? "Meta 게시 결과에 검증 가능한 게시물 URL이 없어 성공을 확정할 수 없습니다. 계정에서 직접 확인하세요."
        : args.errorMessage;
    const attemptedFailure = j.jobType === "post.publish" && args.status === "FAILED" && !!j.publishAttemptedAt;
    if (attemptedFailure) {
      effectiveErrorCode = "PUBLISH_RESULT_UNCERTAIN";
      effectiveErrorMessage = "게시 API 요청을 전송한 뒤 결과를 확인하지 못했습니다. 자동 재게시하지 않으니 SNS에서 직접 확인하세요.";
    }
    const publishUncertain = receiptMissing || attemptMarkerMissing || attemptedFailure;
    await ctx.db.patch(j._id, { status: effectiveStatus, result: args.result, errorCode: effectiveStatus === "FAILED" ? effectiveErrorCode ?? "INTERNAL" : undefined, errorMessage: effectiveStatus === "FAILED" ? effectiveErrorMessage : undefined, finishedAt: now, updatedAt: now, stage: "done", progress: 100, ...(j.jobType === "post.publish" ? { publishPhase: effectiveStatus === "SUCCEEDED" ? "CONFIRMED" as const : publishUncertain ? "UNCERTAIN" as const : "PREPARING" as const } : {}) });
    if (j.jobType === "post.publish") {
      const rootJobId = j.rootJobId ?? j._id;
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", rootJobId)).unique();
      if (reservation) {
        await ctx.db.patch(reservation._id, effectiveStatus === "SUCCEEDED" ? { state: "COMMITTED", committedAt: now } : publishUncertain ? { state: "UNCERTAIN" } : { state: "RELEASED" });
      }
    }
    const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
    if (space?.snsAccountId && args.accountStatus) {
      await ctx.db.patch(space.snsAccountId, { status: args.accountStatus, lastError: args.errorMessage });
      await ctx.db.patch(space._id, { lastError: args.errorMessage?.slice(0, 300), sessionState: space.deviceId ? "LOGIN_REQUIRED" : "EXPIRED" });
    }
    let fallbackJobId: Id<"agentJobs"> | null = null;
    const account = space?.snsAccountId ? await ctx.db.get(space.snsAccountId) : null;
    const fallbackSpace = account?.fallbackSpaceId ? await ctx.db.get(account.fallbackSpaceId) : null;
    const fallbackIdentityMatches = !!account
      && !!fallbackSpace
      && normalizedHandle(account.username) !== null
      && normalizedHandle(account.username) === normalizedHandle(fallbackSpace.handle);
    if (args.fallback && account?.fallbackSpaceId && !fallbackIdentityMatches) {
      await ctx.db.patch(account._id, {
        fallbackSpaceId: undefined,
        lastError: "브라우저 폴백 계정 식별자가 변경되어 연결을 해제했습니다. 동일 계정을 다시 확인하세요.",
      });
      await audit(ctx, { actorUserId: j.userId, action: "meta.fallback.unlinked", metadata: { accountId: account._id, fallbackSpaceId: account.fallbackSpaceId, reason: "IDENTITY_MISMATCH" } });
    }
    if (args.fallback && !j.cancelRequested && !j.publishAttemptedAt && (!j.expiresAt || j.expiresAt > now) && j.jobType === "post.publish" && fallbackIdentityMatches && fallbackSpace?.deviceId && fallbackSpace.userId === j.userId && fallbackSpace.platform === space?.platform && fallbackSpace.sessionState === "HEALTHY") {
      const fallbackPayload = { ...(j.payload as PublishPayload), spaceId: fallbackSpace._id, platform: fallbackSpace.platform };
      fallbackJobId = await enqueueJob(ctx, { userId: j.userId, jobType: "post.publish", payload: fallbackPayload as unknown as Record<string, unknown>, spaceId: fallbackSpace._id, scheduleId: j.scheduleId, source: j.source, executor: "DESKTOP", fallbackFromJobId: j._id, rootJobId: j.rootJobId ?? j._id, needsApproval: j.approvalRequired !== false, expiresAt: j.expiresAt });
      await audit(ctx, { actorUserId: j.userId, action: "meta.fallback", metadata: { fromJobId: j._id, toJobId: fallbackJobId, reason: args.errorCode } });
      if (j.approvalRequired !== false) await ctx.scheduler.runAfter(0, internal.telegram.notifyApproval, { jobId: fallbackJobId });
    }
    if (effectiveStatus === "SUCCEEDED" && j.jobType === "post.publish") await recordPublishedPost(ctx, (await ctx.db.get(j._id))!);
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
    // A live publish must not reserve its idempotency slot until the provider
    // container is ready and the adapter is immediately about to commit it.
    // Dry-runs never call the adapter, so they still need their preflight here.
    if (job.jobType === "post.publish" && (job.payload as PublishPayload).dryRun === true) {
      const preflight = await ctx.runMutation(internal.agent.preflightJob, { jobId: job._id });
      if (!preflight.ok) {
        await finish({ status: "FAILED", errorCode: preflight.reason, errorMessage: preflight.message, result: errorResult(job.jobType, preflight.reason as never, preflight.message) });
        return;
      }
    }
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
      if (!metaLivePublishAvailable(account.mode)) {
        await finish({ status: "FAILED", errorCode: "META_CONFIG", errorMessage: "Mock Meta 연결은 실게시에 사용할 수 없습니다.", result: errorResult(job.jobType, "META_CONFIG", "Graph Meta configuration required"), fallback: hasDevice });
        return;
      }
      const profile = await adapter.me(account.platform, token);
      if (profile.providerUserId !== account.providerUserId || !(await ctx.runMutation(internal.meta.syncPublishingIdentity, {
        accountId: account._id,
        spaceId: space._id,
        providerUserId: profile.providerUserId,
        username: profile.username ?? undefined,
      }))) {
        throw new MetaPrecommitDenied("SPACE_ACCOUNT_MISMATCH", "연결된 Meta 계정과 현재 토큰의 계정이 다릅니다. 계정을 다시 연결하세요.");
      }
      const published = await adapter.publish(
        token,
        profile,
        { platform: account.platform as MetaPlatform, contentChannel: p.contentChannel, text: p.text, mediaUrls: p.mediaUrls, linkUrl: p.linkUrl ?? null },
        async () => {
          const fresh = await ctx.runMutation(internal.agent.preflightJob, { jobId: job._id });
          if (!fresh.ok) throw new MetaPrecommitDenied(fresh.reason, fresh.message);
          if (!(await ctx.runMutation(internal.meta.markCloudPublishAttempted, { jobId: job._id })))
            throw new MetaPrecommitDenied("PREFLIGHT_REQUIRED", "게시 시도 직전 서버 의도를 기록하지 못했습니다.");
        },
      );
      await finish({ status: "SUCCEEDED", result: okResult("post.publish", `Meta API 게시 완료 (${account.platform})`, { postUrl: published.postUrl, externalPostId: published.externalPostId, authMode: "META_API", mode: adapter.mode }) });
    } catch (e) {
      if (e instanceof MetaPrecommitDenied) {
        await finish({
          status: "FAILED",
          errorCode: e.reason,
          errorMessage: e.message,
          result: errorResult(job.jobType, e.reason as never, e.message),
        });
        return;
      }
      const err = e instanceof MetaApiError ? e : new MetaApiError("META_PUBLISH_FAILED", (e as Error).message);
      const tokenProblem = err.code === "META_TOKEN_EXPIRED" || err.code === "META_PERMISSION";
      await finish({
        status: "FAILED",
        errorCode: err.code,
        errorMessage: err.message,
        result: errorResult(job.jobType, err.code, err.message),
        accountStatus: tokenProblem ? "EXPIRED" : undefined,
        fallback: job.jobType === "post.publish" && hasDevice && err.code === "META_TOKEN_EXPIRED",
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
  args: { now: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    // Keep the daily mutation finite; remaining accounts are picked up by the
    // continuation cursor instead of causing one oversized rollback.
    const page = await ctx.db.query("snsAccounts")
      .withIndex("by_status_expiry", (q) => q.eq("status", "ACTIVE").lte("tokenExpiresAt", now + REFRESH_BEFORE_MS))
      .paginate({ cursor: args.cursor ?? null, numItems: REFRESH_BATCH_SIZE });
    const due = page.page;
    let created = 0;
    for (const a of due) {
      if (!a.spaceId) continue;
      await enqueueJob(ctx, { userId: a.userId, jobType: "meta.token_refresh", payload: { accountId: a._id, platform: a.platform }, spaceId: a.spaceId, source: "SYSTEM", executor: "CLOUD", idempotencyKey: `meta.refresh:${a._id}:${Math.floor(now / 86_400_000)}` });
      created++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.meta.scheduleRefreshes, { now, cursor: page.continueCursor });
    }
    return { created, due: due.length, batchLimited: !page.isDone };
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
