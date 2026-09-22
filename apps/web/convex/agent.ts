import { v } from "convex/values";
import { APPROVAL_TTL_MS, CHANNEL_PLATFORM, JOB_LEASE_MS, kstDayKey, type PublishPayload } from "@automoney/shared";
import { internal } from "./_generated/api";
import { ingestGeneratedJob } from "./content";
import { ingestReadbackJob, recordPublishedPost } from "./analytics";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { sha256Hex } from "./lib/crypto";
import { canonicalJson } from "./jobs";

/** 데스크톱 에이전트 HTTP 계약 (blogautomcp remote-agent 계승). 인증: Authorization: Bearer <deviceToken>. */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const err = (code: string, message: string, status: number) => json({ success: false, error: { code, message } }, status);

async function authDevice(ctx: { runQuery: (ref: typeof internal.devices.authenticate, args: { tokenHash: string }) => Promise<{ deviceId: Id<"devices">; userId: Id<"users"> } | null> }, request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!/^[A-Z2-9]{43}$/.test(token)) return null;
  return await ctx.runQuery(internal.devices.authenticate, { tokenHash: await sha256Hex(token) });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const t = await request.text();
    if (t.length > 512_000) return null;
    const v = t ? JSON.parse(t) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const claim = httpAction(async (ctx, request) => {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const body = (await readJson(request)) ?? {};
  const job = await ctx.runMutation(internal.agent.claimJob, {
    deviceId: dev.deviceId,
    userId: dev.userId,
    appVersion: typeof body.appVersion === "string" ? body.appVersion : undefined,
    snapshot: body.status ?? undefined,
  });
  return json({ success: true, data: job });
});

async function handleHeartbeat(ctx: ActionCtx, request: Request): Promise<Response> {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const url = new URL(request.url);
  const jobId = url.pathname.split("/").filter(Boolean).at(-2) as Id<"agentJobs"> | undefined;
  if (!jobId) return err("INVALID_ARGUMENT", "job id missing", 400);
  const body = (await readJson(request)) ?? {};
  const r = await ctx.runMutation(internal.agent.heartbeatJob, {
    jobId,
    deviceId: dev.deviceId,
    attemptNo: typeof body.attemptNo === "number" ? body.attemptNo : undefined,
    leaseTokenHash: typeof body.leaseToken === "string" ? await sha256Hex(body.leaseToken) : undefined,
    stage: typeof body.stage === "string" ? body.stage.slice(0, 80) : undefined,
    progress: typeof body.progress === "number" ? body.progress : undefined,
  });
  return json({ success: true, data: r });
}

async function handleComplete(ctx: ActionCtx, request: Request): Promise<Response> {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const url = new URL(request.url);
  const jobId = url.pathname.split("/").filter(Boolean).at(-2) as Id<"agentJobs"> | undefined;
  if (!jobId) return err("INVALID_ARGUMENT", "job id missing", 400);
  const body = await readJson(request);
  if (!body || (body.status !== "SUCCEEDED" && body.status !== "FAILED")) return err("INVALID_ARGUMENT", "status must be SUCCEEDED|FAILED", 400);
  const completionInput = { status: body.status, result: body.result, errorCode: body.errorCode, errorMessage: body.errorMessage, spaceUpdate: body.spaceUpdate };
  const r = await ctx.runMutation(internal.agent.completeJob, {
    jobId,
    deviceId: dev.deviceId,
    status: body.status,
    result: body.result,
    errorCode: typeof body.errorCode === "string" ? body.errorCode.slice(0, 60) : undefined,
    errorMessage: typeof body.errorMessage === "string" ? body.errorMessage.slice(0, 1000) : undefined,
    spaceUpdate: body.spaceUpdate,
    attemptNo: typeof body.attemptNo === "number" ? body.attemptNo : undefined,
    leaseTokenHash: typeof body.leaseToken === "string" ? await sha256Hex(body.leaseToken) : undefined,
    completionId: typeof body.completionId === "string" ? body.completionId.slice(0, 100) : undefined,
    completionHash: await sha256Hex(canonicalJson(completionInput)),
  });
  if (!r.ok) return err("CONFLICT", r.reason ?? "job not active", 409);
  return json({ success: true, data: r });
}

async function handlePreflight(ctx: ActionCtx, request: Request): Promise<Response> {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const url = new URL(request.url);
  const jobId = url.pathname.split("/").filter(Boolean).at(-2) as Id<"agentJobs"> | undefined;
  if (!jobId) return err("INVALID_ARGUMENT", "job id missing", 400);
  const body = (await readJson(request)) ?? {};
  const result = await ctx.runMutation(internal.agent.preflightJob, {
    jobId,
    deviceId: dev.deviceId,
    attemptNo: typeof body.attemptNo === "number" ? body.attemptNo : undefined,
    leaseTokenHash: typeof body.leaseToken === "string" ? await sha256Hex(body.leaseToken) : undefined,
  });
  if (!result.ok) return err(result.reason, result.message, 409);
  return json({ success: true, data: result });
}

/** /agent/jobs/:id/heartbeat | /agent/jobs/:id/complete */
export const jobsRouter = httpAction(async (ctx, request) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/heartbeat")) return handleHeartbeat(ctx, request);
  if (path.endsWith("/preflight")) return handlePreflight(ctx, request);
  if (path.endsWith("/complete")) return handleComplete(ctx, request);
  return err("NOT_FOUND", "unknown agent route", 404);
});

/** 에이전트가 로컬 스페이스 상태(세션 검증 결과 등)를 보고 */
export const spacesSync = httpAction(async (ctx, request) => {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const body = await readJson(request);
  const updates = Array.isArray(body?.spaces) ? (body!.spaces as unknown[]) : [];
  const r = await ctx.runMutation(internal.agent.syncSpaces, { deviceId: dev.deviceId, updates });
  return json({ success: true, data: r });
});

export const config = httpAction(async (ctx, request) => {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const data = await ctx.runQuery(internal.agent.deviceConfig, { deviceId: dev.deviceId });
  return json({ success: true, data });
});

// ─────────────────────────────── internal ───────────────────────────────

export const claimJob = internalMutation({
  args: { deviceId: v.id("devices"), userId: v.id("users"), appVersion: v.optional(v.string()), snapshot: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.deviceId, { lastSeenAt: now, ...(args.appVersion ? { appVersion: args.appVersion } : {}), ...(args.snapshot !== undefined ? { snapshot: args.snapshot } : {}) });
    const candidates = await ctx.db
      .query("agentJobs")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId).eq("status", "QUEUED").lte("runAfter", now))
      .order("asc")
      .take(20);
    for (const j of candidates) {
      if (j.executor === "CLOUD") continue;
      if (j.spaceId) {
        const s = await ctx.db.get(j.spaceId);
        if (!s) {
          await ctx.db.patch(j._id, { status: "FAILED", errorCode: "SPACE_NOT_FOUND", errorMessage: "스페이스가 삭제되었습니다.", finishedAt: now, updatedAt: now });
          continue;
        }
        if (s.lockJobId && s.lockJobId !== j._id) continue; // 다른 잡이 스페이스 사용 중
        if (s.deviceId !== args.deviceId) continue; // 다른 디바이스의 스페이스
        await ctx.db.patch(s._id, { lockJobId: j._id, sessionState: s.sessionState === "HEALTHY" ? "RUNNING" : s.sessionState });
      }
      const attemptNo = (j.attemptNo ?? 0) + 1;
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const leaseToken = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const leaseTokenHash = await sha256Hex(leaseToken);
      await ctx.db.patch(j._id, { status: "RUNNING", claimedByDeviceId: args.deviceId, leaseUntil: now + JOB_LEASE_MS, heartbeatAt: now, stage: "claimed", attemptNo, leaseTokenHash, protocolVersion: 2, ...(j.jobType === "post.publish" ? { publishPhase: "PREPARING" as const } : {}), updatedAt: now });
      const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
      return { id: j._id, jobType: j.jobType, payload: j.payload, spaceId: j.spaceId ?? null, space: space ? { _id: space._id, platform: space.platform, name: space.name, handle: space.handle ?? null, pinned: space.pinned } : null, leaseMs: JOB_LEASE_MS, protocolVersion: 2, attemptNo, leaseToken, leaseExpiresAt: now + JOB_LEASE_MS };
    }
    return null;
  },
});

export const heartbeatJob = internalMutation({
  args: { jobId: v.id("agentJobs"), deviceId: v.id("devices"), attemptNo: v.optional(v.number()), leaseTokenHash: v.optional(v.string()), stage: v.optional(v.string()), progress: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.deviceId, { lastSeenAt: now });
    const j = await ctx.db.get(args.jobId);
    if (!j || j.status !== "RUNNING" || j.claimedByDeviceId !== args.deviceId) return { active: false, cancelRequested: false };
    if (args.attemptNo !== undefined && (args.attemptNo !== j.attemptNo || args.leaseTokenHash !== j.leaseTokenHash)) return { active: false, cancelRequested: false, staleAttempt: true };
    await ctx.db.patch(j._id, { leaseUntil: now + JOB_LEASE_MS, heartbeatAt: now, stage: args.stage ?? j.stage, progress: args.progress ?? j.progress, updatedAt: now });
    return { active: true, cancelRequested: j.cancelRequested };
  },
});

export const preflightJob = internalMutation({
  args: { jobId: v.id("agentJobs"), deviceId: v.optional(v.id("devices")), attemptNo: v.optional(v.number()), leaseTokenHash: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const j = await ctx.db.get(args.jobId);
    const deny = (reason: string, message: string) => ({ ok: false as const, reason, message });
    if (!j || j.jobType !== "post.publish" || j.status !== "RUNNING") return deny("JOB_NOT_ACTIVE", "발행 작업이 실행 상태가 아닙니다.");
    if (args.deviceId && j.claimedByDeviceId !== args.deviceId) return deny("STALE_ATTEMPT", "다른 실행 주체가 소유한 작업입니다.");
    if (args.attemptNo !== undefined && (args.attemptNo !== j.attemptNo || args.leaseTokenHash !== j.leaseTokenHash)) return deny("STALE_ATTEMPT", "만료된 실행 시도입니다.");
    if ((j.leaseUntil ?? 0) < now) return deny("LEASE_EXPIRED", "작업 lease가 만료되었습니다.");
    if (j.cancelRequested) return deny("JOB_CANCELLED", "취소된 작업입니다.");
    if (j.expiresAt && j.expiresAt < now) return deny("SCHEDULE_EXPIRED", "예약 실행 허용 시간이 지났습니다.");
    const user = await ctx.db.get(j.userId);
    if (!user || (user.status ?? "ACTIVE") !== "ACTIVE") return deny("USER_SUSPENDED", "사용자 계정이 활성 상태가 아닙니다.");
    const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
    if (!space || space.userId !== j.userId) return deny("SPACE_NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    if (!["HEALTHY", "RUNNING"].includes(space.sessionState)) return deny("SPACE_NOT_READY", "스페이스가 게시 가능한 상태가 아닙니다.");
    const payload = j.payload as PublishPayload;
    const piece = payload.pieceId ? await ctx.db.get(payload.pieceId as Id<"contentPieces">) : null;
    if (payload.pieceId && (!piece || piece.status !== "APPROVED")) return deny("CONTENT_UNAVAILABLE", "승인된 콘텐츠를 찾을 수 없습니다.");
    if (piece && CHANNEL_PLATFORM[piece.channel as keyof typeof CHANNEL_PLATFORM] !== space.platform) return deny("CONTENT_PLATFORM_MISMATCH", "콘텐츠 채널과 게시 계정 플랫폼이 일치하지 않습니다.");
    const link = payload.linkId ? await ctx.db.get(payload.linkId as Id<"marketingLinks">) : null;
    if (payload.linkId && (!link || link.userId !== j.userId)) return deny("LINK_NOT_FOUND", "마케팅 링크를 찾을 수 없습니다.");
    if (link?.status !== undefined && link.status !== "ACTIVE") return deny("LINK_INACTIVE", "비활성 마케팅 링크는 게시할 수 없습니다.");
    if (piece?.productId && link && piece.productId !== link.productId) return deny("CONTENT_LINK_PRODUCT_MISMATCH", "콘텐츠 상품과 마케팅 링크 상품이 일치하지 않습니다.");
    const currentHash = await sha256Hex(canonicalJson({ jobType: j.jobType, payload: j.payload }));
    if (j.payloadHash && currentHash !== j.payloadHash) return deny("STALE_APPROVAL", "발행 내용이 변경되었습니다.");
    if (j.approvalRequired !== false) {
      if (!j.approval || j.approval.payloadHash !== currentHash) return deny("APPROVAL_REQUIRED", "현재 발행 내용의 승인이 필요합니다.");
      if (now - j.approval.approvedAt > APPROVAL_TTL_MS) return deny("APPROVAL_EXPIRED", "발행 승인이 만료되었습니다.");
    }
    if (payload.dryRun) return { ok: true as const, dryRun: true, publishIntentId: null };
    const rootJobId = j.rootJobId ?? j._id;
    const existing = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", rootJobId)).unique();
    if (existing && existing.state !== "RELEASED") {
      await ctx.db.patch(j._id, { publishPhase: "INTENT_RECORDED", updatedAt: now });
      return { ok: true as const, dryRun: false, publishIntentId: existing._id };
    }
    const day = kstDayKey(now);
    const reservations = await ctx.db.query("publishReservations").withIndex("by_space_day", (q) => q.eq("spaceId", space._id).eq("kstDay", day)).collect();
    const active = reservations.filter((r) => r.state !== "RELEASED");
    if (active.length >= space.dailyPostLimit) return deny("DAILY_LIMIT", "오늘의 게시 한도에 도달했습니다.");
    const recent = active.filter((r) => r.state === "COMMITTED" && (r.committedAt ?? 0) > now - 15 * 60_000);
    if (recent.length > 0) return deny("MIN_INTERVAL", "최근 게시 후 15분이 지나지 않았습니다.");
    const publishIntentId = existing
      ? (await ctx.db.patch(existing._id, { userId: j.userId, spaceId: space._id, kstDay: day, state: "RESERVED", reservedAt: now, expiresAt: now + 2 * 60 * 60_000, committedAt: undefined }), existing._id)
      : await ctx.db.insert("publishReservations", { userId: j.userId, spaceId: space._id, rootJobId, kstDay: day, state: "RESERVED", reservedAt: now, expiresAt: now + 2 * 60 * 60_000 });
    await ctx.db.patch(j._id, { publishPhase: "INTENT_RECORDED", updatedAt: now });
    return { ok: true as const, dryRun: false, publishIntentId };
  },
});

export const completeJob = internalMutation({
  args: {
    jobId: v.id("agentJobs"),
    deviceId: v.id("devices"),
    status: v.union(v.literal("SUCCEEDED"), v.literal("FAILED")),
    result: v.optional(v.any()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    spaceUpdate: v.optional(v.any()),
    attemptNo: v.optional(v.number()),
    leaseTokenHash: v.optional(v.string()),
    completionId: v.optional(v.string()),
    completionHash: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const j = await ctx.db.get(args.jobId);
    if (j && args.completionId && j.completionId === args.completionId) {
      return j.completionHash === args.completionHash ? { ok: true as const, duplicate: true as const } : { ok: false as const, reason: "COMPLETION_CONFLICT" };
    }
    if (!j || j.status !== "RUNNING" || j.claimedByDeviceId !== args.deviceId) return { ok: false as const, reason: "JOB_NOT_ACTIVE" };
    if (args.attemptNo !== undefined && (args.attemptNo !== j.attemptNo || args.leaseTokenHash !== j.leaseTokenHash)) return { ok: false as const, reason: "STALE_ATTEMPT" };
    const cancelled = j.cancelRequested && args.errorCode === "JOB_CANCELLED";
    const publishUncertain = args.status === "FAILED" && ["AGENT_LOST_UNCERTAIN", "META_PUBLISH_TIMEOUT", "PUBLISH_RESULT_UNCERTAIN"].includes(args.errorCode ?? "");
    await ctx.db.patch(j._id, {
      status: cancelled ? "CANCELLED" : args.status,
      result: args.result,
      errorCode: args.status === "FAILED" ? args.errorCode ?? "INTERNAL" : undefined,
      errorMessage: args.status === "FAILED" ? args.errorMessage : undefined,
      finishedAt: now,
      updatedAt: now,
      stage: "done",
      progress: 100,
      completionId: args.completionId,
      completionHash: args.completionId ? args.completionHash : undefined,
      ...(j.jobType === "post.publish" ? { publishPhase: args.status === "SUCCEEDED" ? "CONFIRMED" as const : publishUncertain ? "UNCERTAIN" as const : "PREPARING" as const } : {}),
    });
    if (j.jobType === "post.publish") {
      const rootJobId = j.rootJobId ?? j._id;
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", rootJobId)).unique();
      if (reservation) {
        await ctx.db.patch(reservation._id, args.status === "SUCCEEDED" ? { state: "COMMITTED", committedAt: now } : publishUncertain ? { state: "UNCERTAIN" } : { state: "RELEASED" });
      }
    }
    if (j.spaceId) {
      const s = await ctx.db.get(j.spaceId);
      if (s) {
        const upd = (args.spaceUpdate ?? {}) as { sessionState?: string; handle?: string; fingerprint?: unknown; lastError?: string };
        const allowed = ["CREATED", "LOGIN_REQUIRED", "HEALTHY", "EXPIRED", "RESTRICTED"];
        const nextState = upd.sessionState && allowed.includes(upd.sessionState) ? (upd.sessionState as typeof s.sessionState) : s.sessionState === "RUNNING" ? "HEALTHY" : s.sessionState;
        await ctx.db.patch(s._id, {
          lockJobId: s.lockJobId === j._id ? undefined : s.lockJobId,
          sessionState: nextState,
          lastCheckedAt: now,
          ...(typeof upd.handle === "string" ? { handle: upd.handle.replace(/^@/, "").slice(0, 60) } : {}),
          ...(upd.fingerprint !== undefined ? { fingerprint: upd.fingerprint } : {}),
          lastError: args.status === "FAILED" ? (args.errorMessage ?? args.errorCode ?? "").slice(0, 300) : undefined,
        });
      }
    }
    if (j.jobType === "content.generate" && args.status === "SUCCEEDED" && !cancelled) await ingestGeneratedJob(ctx, j._id);
    if (args.status === "SUCCEEDED" && !cancelled) {
      const done = (await ctx.db.get(j._id))!;
      if (j.jobType === "post.publish") await recordPublishedPost(ctx, done);
      if (j.jobType === "post.readback") await ingestReadbackJob(ctx, done);
    }
    await ctx.scheduler.runAfter(0, internal.telegram.notifyJob, { jobId: j._id });
    return { ok: true as const };
  },
});

export const syncSpaces = internalMutation({
  args: { deviceId: v.id("devices"), updates: v.array(v.any()) },
  handler: async (ctx, args) => {
    let applied = 0;
    const allowed = new Set(["CREATED", "LOGIN_REQUIRED", "HEALTHY", "EXPIRED", "RESTRICTED"]);
    for (const u of args.updates as { spaceId?: string; sessionState?: string; handle?: string }[]) {
      if (!u.spaceId) continue;
      const s = await ctx.db.get(u.spaceId as Id<"spaces">);
      if (!s || s.deviceId !== args.deviceId) continue;
      if (s.lockJobId) continue;
      await ctx.db.patch(s._id, {
        ...(u.sessionState && allowed.has(u.sessionState) ? { sessionState: u.sessionState as typeof s.sessionState } : {}),
        ...(typeof u.handle === "string" ? { handle: u.handle.replace(/^@/, "").slice(0, 60) } : {}),
        lastCheckedAt: Date.now(),
      });
      applied++;
    }
    await ctx.db.patch(args.deviceId, { lastSeenAt: Date.now() });
    return { applied };
  },
});

export const deviceConfig = internalQuery({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deviceId);
    if (!d) return null;
    const user = await ctx.db.get(d.userId);
    const spaces = await ctx.db.query("spaces").withIndex("by_device", (q) => q.eq("deviceId", d._id)).collect();
    return {
      deviceId: d._id,
      userEmail: user?.email ?? "",
      minAppVersion: process.env.MIN_DESKTOP_VERSION ?? "0.1.0",
      spaces: spaces.map((s) => ({ _id: s._id, platform: s.platform, name: s.name, handle: s.handle ?? null, pinned: s.pinned, sessionState: s.sessionState })),
    };
  },
});
