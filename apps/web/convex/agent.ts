import { v } from "convex/values";
import { JOB_LEASE_MS } from "@automoney/shared";
import { internal } from "./_generated/api";
import { ingestGeneratedJob } from "./content";
import { ingestReadbackJob, recordPublishedPost } from "./analytics";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { sha256Hex } from "./lib/crypto";

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
  const r = await ctx.runMutation(internal.agent.completeJob, {
    jobId,
    deviceId: dev.deviceId,
    status: body.status,
    result: body.result,
    errorCode: typeof body.errorCode === "string" ? body.errorCode.slice(0, 60) : undefined,
    errorMessage: typeof body.errorMessage === "string" ? body.errorMessage.slice(0, 1000) : undefined,
    spaceUpdate: body.spaceUpdate,
  });
  if (!r.ok) return err("CONFLICT", r.reason ?? "job not active", 409);
  return json({ success: true, data: r });
}

/** /agent/jobs/:id/heartbeat | /agent/jobs/:id/complete */
export const jobsRouter = httpAction(async (ctx, request) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/heartbeat")) return handleHeartbeat(ctx, request);
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
      await ctx.db.patch(j._id, { status: "RUNNING", claimedByDeviceId: args.deviceId, leaseUntil: now + JOB_LEASE_MS, heartbeatAt: now, stage: "claimed", updatedAt: now });
      const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
      return { id: j._id, jobType: j.jobType, payload: j.payload, spaceId: j.spaceId ?? null, space: space ? { _id: space._id, platform: space.platform, name: space.name, handle: space.handle ?? null, pinned: space.pinned } : null, leaseMs: JOB_LEASE_MS };
    }
    return null;
  },
});

export const heartbeatJob = internalMutation({
  args: { jobId: v.id("agentJobs"), deviceId: v.id("devices"), stage: v.optional(v.string()), progress: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.deviceId, { lastSeenAt: now });
    const j = await ctx.db.get(args.jobId);
    if (!j || j.status !== "RUNNING" || j.claimedByDeviceId !== args.deviceId) return { active: false, cancelRequested: false };
    await ctx.db.patch(j._id, { leaseUntil: now + JOB_LEASE_MS, heartbeatAt: now, stage: args.stage ?? j.stage, progress: args.progress ?? j.progress, updatedAt: now });
    return { active: true, cancelRequested: j.cancelRequested };
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
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const j = await ctx.db.get(args.jobId);
    if (!j || j.status !== "RUNNING" || j.claimedByDeviceId !== args.deviceId) return { ok: false as const, reason: "JOB_NOT_ACTIVE" };
    const cancelled = j.cancelRequested && args.errorCode === "JOB_CANCELLED";
    await ctx.db.patch(j._id, {
      status: cancelled ? "CANCELLED" : args.status,
      result: args.result,
      errorCode: args.status === "FAILED" ? args.errorCode ?? "INTERNAL" : undefined,
      errorMessage: args.status === "FAILED" ? args.errorMessage : undefined,
      finishedAt: now,
      updatedAt: now,
      stage: "done",
      progress: 100,
    });
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
