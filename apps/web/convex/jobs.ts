import { v, type ObjectType } from "convex/values";
import { APPROVAL_TTL_MS, JOB_LEASE_MS, validatePublishPayload, type JobType, type PublishPayload } from "@automoney/shared";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireUser, roleOf } from "./lib/rbac";
import { consumePiece } from "./lib/pieces";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/crypto";

export const jobTypeValidator = v.union(
  v.literal("post.publish"),
  v.literal("space.create"),
  v.literal("space.login"),
  v.literal("space.verify"),
  v.literal("codex.login"),
  v.literal("content.generate"),
  v.literal("post.readback"),
  v.literal("meta.token_refresh"),
);
const sourceValidator = v.union(v.literal("WEB"), v.literal("SCHEDULE"), v.literal("TELEGRAM"), v.literal("MCP"), v.literal("SYSTEM"));

export interface EnqueueInput {
  userId: Id<"users">;
  jobType: JobType;
  payload: Record<string, unknown>;
  spaceId?: Id<"spaces">;
  scheduleId?: Id<"schedules">;
  source: "WEB" | "SCHEDULE" | "TELEGRAM" | "MCP" | "SYSTEM";
  executor?: "DESKTOP" | "CLOUD";
  fallbackFromJobId?: Id<"agentJobs">;
  needsApproval?: boolean;
  runAfter?: number;
  idempotencyKey?: string;
  requestKey?: string;
  rootJobId?: Id<"agentJobs">;
  expiresAt?: number;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
}

/** 플랫폼·계정·본문·미디어·링크·콘텐츠 버전을 포함한 승인 결합 해시. */
export async function hashJobPayload(jobType: JobType, payload: Record<string, unknown>): Promise<string> {
  return await sha256Hex(canonicalJson({ jobType, payload }));
}

/** 공통 enqueue. 멱등키는 사용자 tenant 안에서만 유효하며 다른 payload 재사용은 충돌이다. */
export async function enqueueJob(ctx: MutationCtx, input: EnqueueInput): Promise<Id<"agentJobs">> {
  const requestKey = input.requestKey ?? input.idempotencyKey;
  const payloadHash = await hashJobPayload(input.jobType, input.payload);
  if (requestKey) {
    const dup = await ctx.db.query("agentJobs").withIndex("by_user_requestKey", (q) => q.eq("userId", input.userId).eq("requestKey", requestKey)).unique();
    if (dup) {
      if (dup.payloadHash && dup.payloadHash !== payloadHash) fail("CONFLICT", "IDEMPOTENCY_CONFLICT");
      return dup._id;
    }
  }
  if (input.jobType === "post.publish") {
    const err = validatePublishPayload(input.payload as unknown as PublishPayload);
    if (err) fail("INVALID_ARGUMENT", `발행 내용 오류: ${err}`);
  }
  const now = Date.now();
  // 실행 주체: Meta API 로 연결된 스페이스의 발행·토큰 갱신은 클라우드(Convex 액션), 나머지는 데스크톱 에이전트 (ADR-0004)
  let executor: "DESKTOP" | "CLOUD" = input.executor ?? "DESKTOP";
  if (!input.executor && input.jobType === "post.publish" && input.spaceId) {
    const space = await ctx.db.get(input.spaceId);
    if (space?.authMode === "META_API" && space.snsAccountId) {
      const acct = await ctx.db.get(space.snsAccountId);
      if (acct?.status === "ACTIVE") executor = "CLOUD";
    }
  }
  if (input.jobType === "meta.token_refresh") executor = "CLOUD";
  const status = input.needsApproval ? "NEEDS_APPROVAL" : "QUEUED";
  const id = await ctx.db.insert("agentJobs", {
    userId: input.userId,
    spaceId: input.spaceId,
    scheduleId: input.scheduleId,
    jobType: input.jobType,
    payload: input.payload,
    status,
    executor,
    fallbackFromJobId: input.fallbackFromJobId,
    runAfter: input.runAfter ?? now,
    idempotencyKey: input.idempotencyKey,
    requestKey,
    payloadHash,
    approvalRequired: input.jobType === "post.publish" ? input.needsApproval !== false : false,
    protocolVersion: 2,
    expiresAt: input.expiresAt,
    cancelRequested: false,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(id, { rootJobId: input.rootJobId ?? id });
  if (executor === "CLOUD" && status === "QUEUED") await ctx.scheduler.runAfter(Math.max(0, (input.runAfter ?? now) - now), internal.meta.runCloudJob, { jobId: id });
  return id;
}

async function ownSpace(ctx: MutationCtx, userId: Id<"users">, spaceId: Id<"spaces">): Promise<Doc<"spaces">> {
  const s = await ctx.db.get(spaceId);
  if (!s || s.userId !== userId) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
  return s;
}

/** 유저: 즉시 발행 잡 (웹) */
const enqueuePublishArgs = {
    spaceId: v.id("spaces"),
    text: v.string(),
    mediaUrls: v.array(v.string()),
    linkId: v.optional(v.id("marketingLinks")),
    pieceId: v.optional(v.id("contentPieces")),
    requireApproval: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
  };

export async function enqueuePublishFor(ctx: MutationCtx, user: Doc<"users">, args: ObjectType<typeof enqueuePublishArgs>, source: "WEB" | "MCP" = "WEB") {
  const space = await ownSpace(ctx, user._id, args.spaceId);
  let text = args.text;
  let mediaUrls = args.mediaUrls;
  if (args.pieceId) {
    const piece = await consumePiece(ctx, user._id, args.pieceId, roleOf(user));
    if (!text.trim()) text = piece.text;
    if (mediaUrls.length === 0) mediaUrls = piece.mediaUrls;
  }
  let linkUrl: string | null = null;
  if (args.linkId) {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.userId !== user._id) fail("NOT_FOUND", "링크를 찾을 수 없습니다.");
    linkUrl = `${process.env.SITE_URL ?? ""}/r/${link.shortCode}`;
  }
  const payload: PublishPayload & { pieceId?: string } = { spaceId: space._id, platform: space.platform, text, mediaUrls, linkUrl, dryRun: args.dryRun ?? false, ...(args.pieceId ? { pieceId: args.pieceId } : {}) };
  const id = await enqueueJob(ctx, { userId: user._id, jobType: "post.publish", payload: payload as unknown as Record<string, unknown>, spaceId: space._id, source, needsApproval: args.requireApproval ?? true });
  await audit(ctx, { actorUserId: user._id, action: "job.enqueuePublish", metadata: { jobId: id, spaceId: space._id, pieceId: args.pieceId ?? null } });
  return id;
}

export const enqueuePublish = mutation({
  args: enqueuePublishArgs,
  handler: async (ctx, args) => {
    return await enqueuePublishFor(ctx, await requireUser(ctx), args);
  },
});

const listMineArgs = { limit: v.optional(v.number()) };

export async function listJobsFor(ctx: QueryCtx, user: Doc<"users">, args: ObjectType<typeof listMineArgs>) {
  const rows = await ctx.db.query("agentJobs").withIndex("by_user", (q) => q.eq("userId", user._id)).order("desc").take(Math.min(args.limit ?? 50, 200));
  const out = [];
  for (const j of rows) {
    const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
    out.push({
      _id: j._id,
      jobType: j.jobType,
      status: j.status,
      stage: j.stage ?? null,
      progress: j.progress ?? null,
      source: j.source,
      spaceName: space?.name ?? null,
      platform: space?.platform ?? null,
      preview: typeof j.payload?.text === "string" ? String(j.payload.text).slice(0, 80) : null,
      errorCode: j.errorCode ?? null,
      errorMessage: j.errorMessage ?? null,
      result: j.result ?? null,
      runAfter: j.runAfter,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt ?? null,
    });
  }
  return out;
}

export const listMine = query({
  args: listMineArgs,
  handler: async (ctx, args) => {
    return await listJobsFor(ctx, await requireUser(ctx), args);
  },
});

export const approve = mutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const j = await ctx.db.get(args.jobId);
    if (!j || j.userId !== user._id) fail("NOT_FOUND", "작업을 찾을 수 없습니다.");
    if (j.status !== "NEEDS_APPROVAL") fail("CONFLICT", "승인 대기 상태가 아닙니다.");
    const payloadHash = await hashJobPayload(j.jobType, j.payload as Record<string, unknown>);
    if (j.payloadHash && j.payloadHash !== payloadHash) fail("CONFLICT", "승인할 내용이 변경되었습니다. 다시 등록하세요.");
    const now = Date.now();
    await ctx.db.patch(j._id, { status: "QUEUED", runAfter: now, payloadHash, approval: { actorUserId: user._id, approvedAt: now, payloadHash }, updatedAt: now });
    if (j.executor === "CLOUD") await ctx.scheduler.runAfter(0, internal.meta.runCloudJob, { jobId: j._id });
    await audit(ctx, { actorUserId: user._id, action: "job.approve", metadata: { jobId: j._id } });
  },
});

const cancelArgs = { jobId: v.id("agentJobs") };

export async function cancelJobFor(ctx: MutationCtx, user: Doc<"users">, args: ObjectType<typeof cancelArgs>) {
  const j = await ctx.db.get(args.jobId);
  if (!j || j.userId !== user._id) fail("NOT_FOUND", "작업을 찾을 수 없습니다.");
  const now = Date.now();
  if (j.status === "QUEUED" || j.status === "NEEDS_APPROVAL") {
    await ctx.db.patch(j._id, { status: "CANCELLED", finishedAt: now, updatedAt: now, errorCode: "JOB_CANCELLED" });
  } else if (j.status === "RUNNING") {
    await ctx.db.patch(j._id, { cancelRequested: true, updatedAt: now });
  } else fail("CONFLICT", "이미 종료된 작업입니다.");
}

export const cancel = mutation({
  args: cancelArgs,
  handler: async (ctx, args) => {
    return await cancelJobFor(ctx, await requireUser(ctx), args);
  },
});

/** 크론(1분): lease 만료 잡 회수. 발행 잡은 부수효과 불확실 → AGENT_LOST_UNCERTAIN 으로 실패 처리. 승인 대기 24h 초과 → 취소. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const running = await ctx.db.query("agentJobs").withIndex("by_status", (q) => q.eq("status", "RUNNING")).collect();
    let requeued = 0;
    let lost = 0;
    for (const j of running) {
      if ((j.leaseUntil ?? 0) >= now) continue;
      if (j.jobType === "post.publish") {
        await ctx.db.patch(j._id, { status: "FAILED", publishPhase: "UNCERTAIN", errorCode: "AGENT_LOST_UNCERTAIN", errorMessage: "에이전트 응답이 끊겨 게시 여부를 확인할 수 없습니다.", finishedAt: now, updatedAt: now });
        const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", j.rootJobId ?? j._id)).unique();
        if (reservation) await ctx.db.patch(reservation._id, { state: "UNCERTAIN" });
        lost++;
      } else {
        await ctx.db.patch(j._id, { status: "QUEUED", claimedByDeviceId: undefined, leaseUntil: undefined, stage: "requeued:lease_expired", updatedAt: now });
        requeued++;
      }
      if (j.spaceId) {
        const s = await ctx.db.get(j.spaceId);
        if (s?.lockJobId === j._id) await ctx.db.patch(s._id, { lockJobId: undefined, sessionState: s.sessionState === "RUNNING" ? "HEALTHY" : s.sessionState });
      }
    }
    const pending = await ctx.db.query("agentJobs").withIndex("by_status", (q) => q.eq("status", "NEEDS_APPROVAL")).collect();
    let expired = 0;
    for (const j of pending) {
      if (now - j.createdAt > APPROVAL_TTL_MS) {
        await ctx.db.patch(j._id, { status: "CANCELLED", errorCode: "JOB_CANCELLED", errorMessage: "승인 시한(24시간) 초과", finishedAt: now, updatedAt: now });
        expired++;
      }
    }
    return { requeued, lost, expired };
  },
});

/** 텔레그램 등 내부 호출용 */
export const enqueueInternal = internalMutation({
  args: { userId: v.id("users"), jobType: jobTypeValidator, payload: v.any(), spaceId: v.optional(v.id("spaces")), source: sourceValidator, needsApproval: v.optional(v.boolean()), idempotencyKey: v.optional(v.string()), requestKey: v.optional(v.string()) },
  handler: async (ctx, args) => enqueueJob(ctx, { ...args, payload: args.payload as Record<string, unknown> }),
});

export const finalizeFromSchedule = internalMutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const j = await ctx.db.get(args.jobId);
    if (!j) return;
    await ctx.scheduler.runAfter(0, internal.telegram.notifyJob, { jobId: j._id });
  },
});

export const JOB_LEASE = JOB_LEASE_MS;
