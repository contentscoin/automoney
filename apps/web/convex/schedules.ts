import type { Doc } from "./_generated/dataModel";
import { v, type ObjectType } from "convex/values";
import { computeNextRunAt, kstDayKey, parseTimeOfDay, validatePublishPayload, type PublishPayload } from "@automoney/shared";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireUser, roleOf } from "./lib/rbac";
import { consumePiece } from "./lib/pieces";
import { enqueueJob } from "./jobs";

const kindValidator = v.union(v.literal("ONE_SHOT"), v.literal("DAILY"), v.literal("WEEKLY"));

const upsertArgs = {
    id: v.optional(v.id("schedules")),
    spaceId: v.id("spaces"),
    kind: kindValidator,
    timeOfDay: v.string(),
    daysOfWeek: v.array(v.number()),
    runDate: v.optional(v.string()),
    jitterMinutes: v.number(),
    text: v.string(),
    mediaUrls: v.array(v.string()),
    linkId: v.optional(v.id("marketingLinks")),
    pieceId: v.optional(v.id("contentPieces")),
    autoApprove: v.boolean(),
  };

export async function upsertScheduleFor(ctx: MutationCtx, user: Doc<"users">, args: ObjectType<typeof upsertArgs>) {
  if (args.pieceId) {
    const piece = await consumePiece(ctx, user._id, args.pieceId, roleOf(user));
    if (!args.text.trim()) args.text = piece.text;
    if (args.mediaUrls.length === 0) args.mediaUrls = piece.mediaUrls;
  }
  const space = await ctx.db.get(args.spaceId);
  if (!space || space.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
  if (!parseTimeOfDay(args.timeOfDay)) fail("INVALID_ARGUMENT", "시간은 HH:MM 형식입니다.");
  if (args.kind === "WEEKLY" && args.daysOfWeek.length === 0) fail("INVALID_ARGUMENT", "요일을 선택하세요.");
  if (args.kind === "ONE_SHOT" && !args.runDate) fail("INVALID_ARGUMENT", "실행 일자를 입력하세요.");
  if (args.jitterMinutes < 0 || args.jitterMinutes > 120) fail("INVALID_ARGUMENT", "지터는 0~120분입니다.");
  if (args.linkId) {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.userId !== user._id) fail("NOT_FOUND", "링크를 찾을 수 없습니다.");
  }
  const err = validatePublishPayload({ spaceId: space._id, platform: space.platform, text: args.text, mediaUrls: args.mediaUrls, linkUrl: args.linkId ? "https://x/r/XXXXXXX" : null });
  if (err) fail("INVALID_ARGUMENT", `발행 내용 오류: ${err}`);
  const { id, ...fields } = args;
  const seed = id ?? `${space._id}:${Date.now()}`;
  const nextRunAt = computeNextRunAt({ kind: args.kind, timeOfDay: args.timeOfDay, daysOfWeek: args.daysOfWeek, jitterMinutes: args.jitterMinutes, runDate: args.runDate ?? null }, Date.now(), seed) ?? undefined;
  const doc = { ...fields, userId: user._id, enabled: true, nextRunAt };
  const scheduleId = id ? (await ctx.db.patch(id, doc), id) : await ctx.db.insert("schedules", { ...doc, createdAt: Date.now() });
  await audit(ctx, { actorUserId: user._id, action: "schedule.upsert", metadata: { scheduleId, kind: args.kind, nextRunAt: nextRunAt ?? null } });
  return { scheduleId, nextRunAt: nextRunAt ?? null };
}

export const upsert = mutation({
  args: upsertArgs,
  handler: async (ctx, args) => {
    return await upsertScheduleFor(ctx, await requireUser(ctx), args);
  },
});

export async function listSchedulesFor(ctx: QueryCtx, user: Doc<"users">) {
  const rows = await ctx.db.query("schedules").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
  const out = [];
  for (const s of rows) {
    const space = await ctx.db.get(s.spaceId);
    out.push({ ...s, spaceName: space?.name ?? "(삭제됨)", platform: space?.platform ?? null, nextRunAt: s.nextRunAt ?? null, lastRunAt: s.lastRunAt ?? null });
  }
  return out.sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    return await listSchedulesFor(ctx, await requireUser(ctx));
  },
});

export const setEnabled = mutation({
  args: { id: v.id("schedules"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.id);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "예약을 찾을 수 없습니다.");
    const nextRunAt = args.enabled
      ? computeNextRunAt({ kind: s.kind, timeOfDay: s.timeOfDay, daysOfWeek: s.daysOfWeek, jitterMinutes: s.jitterMinutes, runDate: s.runDate ?? null }, Date.now(), s._id) ?? undefined
      : undefined;
    await ctx.db.patch(s._id, { enabled: args.enabled, nextRunAt });
  },
});

export const remove = mutation({
  args: { id: v.id("schedules") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.id);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "예약을 찾을 수 없습니다.");
    await ctx.db.delete(s._id);
  },
});

/**
 * 크론(5분): 도래한 예약 → post.publish 잡 생성(autoApprove 아니면 NEEDS_APPROVAL) → 다음 실행 시각 계산.
 * 스페이스 일일 한도 초과 시 잡을 만들지 않고 다음 슬롯으로 넘긴다.
 */
export const tick = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const due = await ctx.db.query("schedules").withIndex("by_enabled_next", (q) => q.eq("enabled", true).lte("nextRunAt", now)).collect();
    let created = 0;
    let skipped = 0;
    for (const s of due) {
      if (s.nextRunAt === undefined) continue;
      const space = await ctx.db.get(s.spaceId);
      const spec = { kind: s.kind, timeOfDay: s.timeOfDay, daysOfWeek: s.daysOfWeek, jitterMinutes: s.jitterMinutes, runDate: s.runDate ?? null };
      const next = computeNextRunAt(spec, now, s._id) ?? undefined;
      if (!space || ["PAUSED", "RESTRICTED"].includes(space.sessionState)) {
        await ctx.db.patch(s._id, { nextRunAt: next, enabled: next !== undefined });
        skipped++;
        continue;
      }
      // 일일 한도: 같은 KST 일자에 생성된 발행 잡 수
      const dayKey = kstDayKey(now);
      const todays = (await ctx.db.query("agentJobs").withIndex("by_space", (q) => q.eq("spaceId", space._id)).order("desc").take(50)).filter(
        (j) => j.jobType === "post.publish" && kstDayKey(j.createdAt) === dayKey && j.status !== "CANCELLED",
      );
      if (todays.length >= space.dailyPostLimit) {
        await ctx.db.patch(s._id, { nextRunAt: next, enabled: next !== undefined });
        skipped++;
        continue;
      }
      let linkUrl: string | null = null;
      if (s.linkId) {
        const link = await ctx.db.get(s.linkId);
        if (link) linkUrl = `${process.env.SITE_URL ?? ""}/r/${link.shortCode}`;
      }
      const payload: PublishPayload = { spaceId: space._id, platform: space.platform, text: s.text, mediaUrls: s.mediaUrls, linkUrl };
      const jobId = await enqueueJob(ctx, {
        userId: s.userId,
        jobType: "post.publish",
        payload: payload as unknown as Record<string, unknown>,
        spaceId: space._id,
        scheduleId: s._id,
        source: "SCHEDULE",
        needsApproval: !s.autoApprove,
        idempotencyKey: `schedule:${s._id}:${s.nextRunAt}`,
      });
      await ctx.db.patch(s._id, { lastRunAt: now, lastJobId: jobId, nextRunAt: next, enabled: next !== undefined });
      if (!s.autoApprove) await ctx.scheduler.runAfter(0, internal.telegram.notifyApproval, { jobId });
      created++;
    }
    return { created, skipped };
  },
});
