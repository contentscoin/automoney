import { v } from "convex/values";
import { APPROVAL_TTL_MS, JOB_LEASE_MS, validatePublishPayload, type JobType, type PublishPayload } from "@automoney/shared";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireUser, roleOf } from "./lib/rbac";
import { consumePiece } from "./lib/pieces";
import { internal } from "./_generated/api";

export const jobTypeValidator = v.union(
  v.literal("post.publish"),
  v.literal("space.create"),
  v.literal("space.login"),
  v.literal("space.verify"),
  v.literal("codex.login"), v.literal("content.generate"),
);
const sourceValidator = v.union(v.literal("WEB"), v.literal("SCHEDULE"), v.literal("TELEGRAM"), v.literal("MCP"), v.literal("SYSTEM"));

export interface EnqueueInput {
  userId: Id<"users">;
  jobType: JobType;
  payload: Record<string, unknown>;
  spaceId?: Id<"spaces">;
  scheduleId?: Id<"schedules">;
  source: "WEB" | "SCHEDULE" | "TELEGRAM" | "MCP" | "SYSTEM";
  needsApproval?: boolean;
  runAfter?: number;
  idempotencyKey?: string;
}

/** 공통 enqueue. 멱등키 중복은 기존 잡 반환. */
export async function enqueueJob(ctx: MutationCtx, input: EnqueueInput): Promise<Id<"agentJobs">> {
  if (input.idempotencyKey) {
    const dup = await ctx.db.query("agentJobs").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", input.idempotencyKey!)).unique();
    if (dup) return dup._id;
  }
  if (input.jobType === "post.publish") {
    const err = validatePublishPayload(input.payload as unknown as PublishPayload);
    if (err) fail("INVALID_ARGUMENT", `발행 내용 오류: ${err}`);
  }
  const now = Date.now();
  return await ctx.db.insert("agentJobs", {
    userId: input.userId,
    spaceId: input.spaceId,
    scheduleId: input.scheduleId,
    jobType: input.jobType,
    payload: input.payload,
    status: input.needsApproval ? "NEEDS_APPROVAL" : "QUEUED",
    runAfter: input.runAfter ?? now,
    idempotencyKey: input.idempotencyKey,
    cancelRequested: false,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  });
}

async function ownSpace(ctx: MutationCtx, userId: Id<"users">, spaceId: Id<"spaces">): Promise<Doc<"spaces">> {
  const s = await ctx.db.get(spaceId);
  if (!s || s.userId !== userId) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
  return s;
}

/** 유저: 즉시 발행 잡 (웹) */
export const enqueuePublish = mutation({
  args: {
    spaceId: v.id("spaces"),
    text: v.string(),
    mediaUrls: v.array(v.string()),
    linkId: v.optional(v.id("marketingLinks")),
    pieceId: v.optional(v.id("contentPieces")),
    requireApproval: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
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
    const id = await enqueueJob(ctx, { userId: user._id, jobType: "post.publish", payload: payload as unknown as Record<string, unknown>, spaceId: space._id, source: "WEB", needsApproval: args.requireApproval ?? false });
    await audit(ctx, { actorUserId: user._id, action: "job.enqueuePublish", metadata: { jobId: id, spaceId: space._id, pieceId: args.pieceId ?? null } });
    return id;
  },
});

export const listMine = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
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
  },
});

export const approve = mutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const j = await ctx.db.get(args.jobId);
    if (!j || j.userId !== user._id) fail("NOT_FOUND", "작업을 찾을 수 없습니다.");
    if (j.status !== "NEEDS_APPROVAL") fail("CONFLICT", "승인 대기 상태가 아닙니다.");
    await ctx.db.patch(j._id, { status: "QUEUED", runAfter: Date.now(), updatedAt: Date.now() });
    await audit(ctx, { actorUserId: user._id, action: "job.approve", metadata: { jobId: j._id } });
  },
});

export const cancel = mutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const j = await ctx.db.get(args.jobId);
    if (!j || j.userId !== user._id) fail("NOT_FOUND", "작업을 찾을 수 없습니다.");
    const now = Date.now();
    if (j.status === "QUEUED" || j.status === "NEEDS_APPROVAL") {
      await ctx.db.patch(j._id, { status: "CANCELLED", finishedAt: now, updatedAt: now, errorCode: "JOB_CANCELLED" });
    } else if (j.status === "RUNNING") {
      await ctx.db.patch(j._id, { cancelRequested: true, updatedAt: now });
    } else fail("CONFLICT", "이미 종료된 작업입니다.");
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
        await ctx.db.patch(j._id, { status: "FAILED", errorCode: "AGENT_LOST_UNCERTAIN", errorMessage: "에이전트 응답이 끊겨 게시 여부를 확인할 수 없습니다.", finishedAt: now, updatedAt: now });
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
  args: { userId: v.id("users"), jobType: jobTypeValidator, payload: v.any(), spaceId: v.optional(v.id("spaces")), source: sourceValidator, needsApproval: v.optional(v.boolean()), idempotencyKey: v.optional(v.string()) },
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
