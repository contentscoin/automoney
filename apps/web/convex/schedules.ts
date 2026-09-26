import type { Doc, Id } from "./_generated/dataModel";
import { v, type ObjectType } from "convex/values";
import { CHANNEL_PLATFORM, computeNextRunAt, kstDayKey, parseTimeOfDay, validatePublishPayload, type PublishPayload } from "@automoney/shared";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireUser } from "./lib/rbac";
import { consumePiece, contentPieceEvidenceRunId, contentPieceHasOperatorSupplyLineage, contentPieceProductAvailable, contentPiecePublishOutputHash, contentPieceText, hashPiecePublishSnapshot, operatorSupplySourceAvailable, workflowReviewEvidence } from "./lib/pieces";
import { livePublishEnabled } from "./lib/publishPolicy";
import { marketingRedirectUrl } from "./lib/publicUrl";
import { canonicalJson, enqueueJob, validateExecutorPublishContract } from "./jobs";
import { sha256Hex } from "./lib/crypto";
import { publicationIdentity } from "./lib/publishIdentity";
import { metaLivePublishAvailable } from "./lib/meta";

const kindValidator = v.union(v.literal("ONE_SHOT"), v.literal("DAILY"), v.literal("WEEKLY"));
const SCHEDULE_TICK_BATCH_SIZE = 25;

async function invalidateScheduledJobs(ctx: MutationCtx, scheduleId: Id<"schedules">, now = Date.now()) {
  let cancelled = 0;
  for (const status of ["QUEUED", "NEEDS_APPROVAL", "RUNNING"] as const) {
    const jobs = await ctx.db.query("agentJobs").withIndex("by_schedule_status", (q) => q.eq("scheduleId", scheduleId).eq("status", status)).collect();
    for (const job of jobs) {
      if (status === "RUNNING") {
        await ctx.db.patch(job._id, { cancelRequested: true, updatedAt: now });
      } else {
        await ctx.db.patch(job._id, {
          status: "CANCELLED",
          errorCode: "JOB_CANCELLED",
          errorMessage: "예약이 변경되거나 중지되어 실행을 취소했습니다.",
          finishedAt: now,
          updatedAt: now,
        });
      }
      cancelled++;
    }
  }
  return cancelled;
}

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
    contentChannel: v.optional(v.union(v.literal("INSTAGRAM_FEED"), v.literal("INSTAGRAM_REEL"), v.literal("THREADS"), v.literal("X"), v.literal("TIKTOK"), v.literal("BLOG"))),
    autoApprove: v.boolean(),
    clientRequestId: v.optional(v.string()),
  };

export async function upsertScheduleFor(ctx: MutationCtx, user: Doc<"users">, args: ObjectType<typeof upsertArgs>) {
  if (args.clientRequestId !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(args.clientRequestId))
    fail("INVALID_ARGUMENT", "예약 요청 식별자가 올바르지 않습니다.");
  const requestKey = args.clientRequestId ? `schedule-request:${user._id}:${args.clientRequestId}` : undefined;
  // 수정 요청은 새 대상(space/piece)을 소비하기 전에 기존 예약 자체의 소유권부터 확인한다.
  // 존재하지 않는 id와 타인의 id를 같은 NOT_FOUND로 처리해 예약 존재 여부도 노출하지 않는다.
  if (args.id) {
    const existing = await ctx.db.get(args.id);
    if (!existing || existing.userId !== user._id) fail("NOT_FOUND", "예약을 찾을 수 없습니다.");
  }
  const space = await ctx.db.get(args.spaceId);
  if (!space || space.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
  if (space.sessionState !== "HEALTHY") fail("CONFLICT", "상태 확인이 완료된 정상 게시 계정만 예약할 수 있습니다.");
  const targetIdentity = await publicationIdentity(ctx, space);
  if (!targetIdentity) fail("CONFLICT", "예약할 게시 계정 식별 정보를 확인할 수 없습니다.");
  let text = args.text;
  let mediaUrls = args.mediaUrls;
  let contentProductId: Doc<"contentPieces">["productId"];
  let contentChannel: PublishPayload["contentChannel"] = args.contentChannel;
  let workflowPiece: Awaited<ReturnType<typeof consumePiece>> | null = null;
  if (args.pieceId) {
    const piece = await consumePiece(ctx, user._id, args.pieceId);
    if (args.contentChannel && args.contentChannel !== piece.channel) fail("CONFLICT", "명시한 게시 형식과 콘텐츠 채널이 일치하지 않습니다.");
    if (CHANNEL_PLATFORM[piece.channel as keyof typeof CHANNEL_PLATFORM] !== space.platform) fail("INVALID_ARGUMENT", "콘텐츠 채널과 게시 계정 플랫폼이 일치하지 않습니다.");
    contentProductId = piece.productId;
    contentChannel = piece.channel as PublishPayload["contentChannel"];
    if (text.trim() && text.trim() !== piece.text.trim()) fail("CONFLICT", "콘텐츠 본문은 승인된 revision과 같아야 합니다.");
    if (mediaUrls.length > 0 && JSON.stringify(mediaUrls) !== JSON.stringify(piece.mediaUrls)) fail("CONFLICT", "콘텐츠 미디어는 승인된 revision과 같아야 합니다.");
    text = piece.text;
    mediaUrls = piece.mediaUrls;
    workflowPiece = piece;
  }
  if (contentChannel && CHANNEL_PLATFORM[contentChannel] !== space.platform) fail("INVALID_ARGUMENT", "게시 형식과 게시 계정 플랫폼이 일치하지 않습니다.");
  if (!parseTimeOfDay(args.timeOfDay)) fail("INVALID_ARGUMENT", "시간은 HH:MM 형식입니다.");
  if (args.kind === "WEEKLY" && args.daysOfWeek.length === 0) fail("INVALID_ARGUMENT", "요일을 선택하세요.");
  if (args.kind === "ONE_SHOT" && !args.runDate) fail("INVALID_ARGUMENT", "실행 일자를 입력하세요.");
  if (args.jitterMinutes < 0 || args.jitterMinutes > 120) fail("INVALID_ARGUMENT", "지터는 0~120분입니다.");
  const link = args.linkId ? await ctx.db.get(args.linkId) : null;
  if (args.linkId) {
    if (!link || link.userId !== user._id) fail("NOT_FOUND", "링크를 찾을 수 없습니다.");
    if (link.status !== "ACTIVE") fail("CONFLICT", "활성 상태의 링크만 예약에 사용할 수 있습니다.");
    if (contentProductId && link.productId !== contentProductId) fail("INVALID_ARGUMENT", "콘텐츠 상품과 마케팅 링크 상품이 일치하지 않습니다.");
  }
  if (workflowPiece?.productId && !args.linkId) fail("INVALID_ARGUMENT", "제작 워크플로 콘텐츠에는 같은 상품의 활성 마케팅 링크가 필요합니다.");
  const linkUrl = link ? marketingRedirectUrl(link.shortCode) : null;
  if (link && !linkUrl) fail("CONFIG_MISSING", "SITE_URL은 공개 HTTPS 주소로 설정해야 합니다.");
  const candidatePayload: PublishPayload = { spaceId: space._id, platform: space.platform, contentChannel, text, mediaUrls, linkUrl };
  const err = validatePublishPayload(candidatePayload);
  if (err) fail("INVALID_ARGUMENT", `발행 내용 오류: ${err}`);
  const executorError = validateExecutorPublishContract(space, candidatePayload);
  if (executorError) fail("INVALID_ARGUMENT", executorError);
  const { id, ...fields } = args;
  delete fields.clientRequestId;
  const seed = id ?? `${space._id}:${Date.now()}`;
  const nextRunAt = computeNextRunAt({ kind: args.kind, timeOfDay: args.timeOfDay, daysOfWeek: args.daysOfWeek, jitterMinutes: args.jitterMinutes, runDate: args.runDate ?? null }, Date.now(), seed) ?? undefined;
  const existing = id ? await ctx.db.get(id) : null;
  const workflowSnapshot = workflowPiece && args.pieceId ? {
    pieceOutputHash: workflowPiece.outputHash,
    pieceSnapshotHash: await hashPiecePublishSnapshot({
      pieceId: args.pieceId,
      outputHash: workflowPiece.outputHash,
      text,
      mediaUrls,
      linkId: args.linkId,
      linkUrl,
    }),
  } : { pieceOutputHash: undefined, pieceSnapshotHash: undefined };
  const targetSnapshot = {
    targetPublicationKey: targetIdentity.publicationKey,
    targetHandle: targetIdentity.normalizedHandle ?? undefined,
  };
  const payloadHash = await sha256Hex(canonicalJson({ ...fields, text, mediaUrls, ...workflowSnapshot, ...targetSnapshot }));
  if (requestKey) {
    const duplicate = await ctx.db.query("schedules").withIndex("by_user_requestKey", (q) => q.eq("userId", user._id).eq("requestKey", requestKey)).unique();
    if (duplicate && duplicate._id !== id) {
      if (duplicate.payloadHash !== payloadHash) fail("CONFLICT", "IDEMPOTENCY_CONFLICT");
      return { scheduleId: duplicate._id, nextRunAt: duplicate.nextRunAt ?? null };
    }
  }
  const doc = { ...fields, text, mediaUrls, ...workflowSnapshot, ...targetSnapshot, userId: user._id, requestKey, payloadHash, enabled: true, nextRunAt, revision: (existing?.revision ?? 0) + 1 };
  const scheduleId = id ? (await ctx.db.patch(id, doc), id) : await ctx.db.insert("schedules", { ...doc, createdAt: Date.now() });
  if (existing) await invalidateScheduledJobs(ctx, scheduleId);
  await audit(ctx, { actorUserId: user._id, action: "schedule.upsert", metadata: { scheduleId, kind: args.kind, nextRunAt: nextRunAt ?? null } });
  return { scheduleId, nextRunAt: nextRunAt ?? null };
}

export const upsert = mutation({
  args: upsertArgs,
  handler: async (ctx, args) => {
    // Public browser/devtools callers cannot create recurring no-approval
    // publishing. MCP reaches the helper only after its separate confirmation
    // hash and confirmAutoApprove gate.
    return await upsertScheduleFor(ctx, await requireUser(ctx), { ...args, autoApprove: false });
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
    await ctx.db.patch(s._id, { enabled: args.enabled, nextRunAt, revision: (s.revision ?? 0) + 1 });
    await invalidateScheduledJobs(ctx, s._id);
  },
});

export const remove = mutation({
  args: { id: v.id("schedules") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.id);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "예약을 찾을 수 없습니다.");
    await invalidateScheduledJobs(ctx, s._id);
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
    // Bound every cron transaction. A large overdue backlog is drained over
    // subsequent 5-minute ticks instead of rolling back the entire scheduler.
    const due = await ctx.db.query("schedules")
      .withIndex("by_enabled_next", (q) => q.eq("enabled", true).lte("nextRunAt", now))
      .take(SCHEDULE_TICK_BATCH_SIZE);
    let created = 0;
    let skipped = 0;
    for (const s of due) {
      if (s.nextRunAt === undefined) continue;
      const space = await ctx.db.get(s.spaceId);
      const spec = { kind: s.kind, timeOfDay: s.timeOfDay, daysOfWeek: s.daysOfWeek, jitterMinutes: s.jitterMinutes, runDate: s.runDate ?? null };
      const next = computeNextRunAt(spec, now, s._id) ?? undefined;
      if (!livePublishEnabled()) {
        await ctx.db.patch(s._id, { nextRunAt: next, enabled: next !== undefined, lastSkipReason: "LIVE_PUBLISH_DISABLED", lastSkippedAt: now });
        skipped++;
        continue;
      }
      if (!space || space.sessionState !== "HEALTHY") {
        await ctx.db.patch(s._id, {
          nextRunAt: next,
          enabled: next !== undefined,
          lastSkipReason: !space ? "SPACE_NOT_FOUND" : `SPACE_${space.sessionState}`,
          lastSkippedAt: now,
        });
        skipped++;
        continue;
      }
      const currentTarget = await publicationIdentity(ctx, space);
      if (!s.targetPublicationKey || !currentTarget || currentTarget.publicationKey !== s.targetPublicationKey) {
        await ctx.db.patch(s._id, {
          nextRunAt: undefined,
          enabled: false,
          lastSkipReason: !s.targetPublicationKey ? "TARGET_IDENTITY_REVIEW_REQUIRED" : "TARGET_IDENTITY_CHANGED",
          lastSkippedAt: now,
        });
        skipped++;
        continue;
      }
      const piece = s.pieceId ? await ctx.db.get(s.pieceId) : null;
      const pieceEvidenceRunId = piece ? contentPieceEvidenceRunId(piece) : undefined;
      const pieceProductAvailable = piece ? await contentPieceProductAvailable(ctx, piece) : true;
      const link = s.linkId ? await ctx.db.get(s.linkId) : null;
      const invalidAssociation =
        (s.pieceId && (!piece || piece.status !== "APPROVED")) ? "CONTENT_UNAVAILABLE"
          : piece && CHANNEL_PLATFORM[piece.channel as keyof typeof CHANNEL_PLATFORM] !== space.platform ? "CONTENT_PLATFORM_MISMATCH"
            : !pieceProductAvailable ? "CONTENT_PRODUCT_INACTIVE"
              : s.linkId && (!link || link.userId !== s.userId) ? "LINK_NOT_FOUND"
                : link && link.status !== "ACTIVE" ? "LINK_INACTIVE"
                  : pieceEvidenceRunId && piece?.productId && !link ? "CONTENT_LINK_REQUIRED"
                    : piece?.productId && link && piece.productId !== link.productId ? "CONTENT_LINK_PRODUCT_MISMATCH"
                    : null;
      if (invalidAssociation) {
        await ctx.db.patch(s._id, {
          nextRunAt: next,
          enabled: next !== undefined,
          lastSkipReason: invalidAssociation,
          lastSkippedAt: now,
        });
        skipped++;
        continue;
      }
      // 일일 한도: 같은 KST 일자에 생성된 발행 잡 수
      const dayKey = kstDayKey(now);
      const todays = (await ctx.db.query("agentJobs").withIndex("by_space", (q) => q.eq("spaceId", space._id)).order("desc").take(50)).filter(
        (j) => j.jobType === "post.publish" && kstDayKey(j.createdAt) === dayKey && j.status !== "CANCELLED",
      );
      if (todays.length >= space.dailyPostLimit) {
        await ctx.db.patch(s._id, {
          nextRunAt: next,
          enabled: next !== undefined,
          lastSkipReason: "DAILY_POST_LIMIT",
          lastSkippedAt: now,
        });
        skipped++;
        continue;
      }
      let linkUrl: string | null = null;
      if (link) {
        linkUrl = marketingRedirectUrl(link.shortCode);
        if (!linkUrl) {
          await ctx.db.patch(s._id, { nextRunAt: next, enabled: next !== undefined, lastSkipReason: "PUBLIC_SITE_URL_INVALID", lastSkippedAt: now });
          skipped++;
          continue;
        }
      }
      let text = s.text;
      let mediaUrls = s.mediaUrls;
      let pieceOutputHash: string | undefined;
      let pieceSnapshotHash: string | undefined;
      if (piece && s.pieceId) {
        const run = pieceEvidenceRunId ? await ctx.db.get(pieceEvidenceRunId) : null;
        const outputHash = await contentPiecePublishOutputHash(piece);
        const standardPassed = !pieceEvidenceRunId || (piece.productionMeta as { standardPassed?: boolean } | undefined)?.standardPassed === true;
        const review = pieceEvidenceRunId ? await workflowReviewEvidence(ctx, piece) : { ok: true as const };
        const supplyAvailable = await operatorSupplySourceAvailable(ctx, piece);
        const canonicalText = contentPieceText(piece);
        const currentSnapshot = outputHash ? await hashPiecePublishSnapshot({ pieceId: s.pieceId, outputHash, text: canonicalText, mediaUrls: piece.mediaUrls, linkId: s.linkId, linkUrl }) : null;
        const staleReason = !supplyAvailable
          ? "CONTENT_UNAVAILABLE"
          : !standardPassed || (pieceEvidenceRunId && !contentPieceHasOperatorSupplyLineage(piece) && run?.status !== "COMPLETED") || !review.ok
          ? "CONTENT_REVIEW_REQUIRED"
          : !s.pieceOutputHash || !s.pieceSnapshotHash
            ? "CONTENT_SNAPSHOT_MISSING"
            : outputHash !== s.pieceOutputHash || currentSnapshot !== s.pieceSnapshotHash
              ? "CONTENT_REVISION_CHANGED"
              : null;
        if (staleReason) {
          await ctx.db.patch(s._id, { nextRunAt: next, enabled: next !== undefined, lastSkipReason: staleReason, lastSkippedAt: now });
          skipped++;
          continue;
        }
        text = canonicalText;
        mediaUrls = piece.mediaUrls;
        pieceOutputHash = outputHash!;
        pieceSnapshotHash = currentSnapshot!;
      }
      const payload: PublishPayload = {
        spaceId: space._id,
        platform: space.platform,
        targetPublicationKey: s.targetPublicationKey,
        ...(s.targetHandle ? { targetHandle: s.targetHandle } : {}),
        scheduleRevision: s.revision ?? 0,
        ...((piece?.channel ?? s.contentChannel) ? { contentChannel: (piece?.channel ?? s.contentChannel) as PublishPayload["contentChannel"] } : {}),
        text,
        mediaUrls,
        linkUrl,
        ...(s.linkId ? { linkId: s.linkId } : {}),
        ...(s.pieceId ? { pieceId: s.pieceId } : {}),
        ...(pieceOutputHash ? { pieceOutputHash } : {}),
        ...(pieceSnapshotHash ? { pieceSnapshotHash } : {}),
      };
      const payloadError = validatePublishPayload(payload) ?? validateExecutorPublishContract(space, payload);
      const metaConfigInvalid = space.authMode === "META_API" && (!currentTarget.account || !metaLivePublishAvailable(currentTarget.account.mode));
      if (payloadError || metaConfigInvalid) {
        const reason = space.platform === "INSTAGRAM" && !payload.contentChannel
          ? "CONTENT_CHANNEL_REVIEW_REQUIRED"
          : metaConfigInvalid ? "META_CONFIG_REVIEW_REQUIRED" : "PUBLISH_PAYLOAD_REVIEW_REQUIRED";
        await ctx.db.patch(s._id, { nextRunAt: undefined, enabled: false, lastSkipReason: reason, lastSkippedAt: now });
        skipped++;
        continue;
      }
      let jobId: Id<"agentJobs">;
      try {
        jobId = await enqueueJob(ctx, {
          userId: s.userId,
          jobType: "post.publish",
          payload: payload as unknown as Record<string, unknown>,
          spaceId: space._id,
          scheduleId: s._id,
          source: "SCHEDULE",
          needsApproval: s.autoApprove !== true,
          idempotencyKey: `schedule:${s._id}:${s.nextRunAt}`,
          expiresAt: s.nextRunAt + 2 * 60 * 60_000,
        });
      } catch {
        // One malformed legacy row must never roll back every other due
        // schedule in this cron batch. Disable it for explicit owner review.
        await ctx.db.patch(s._id, { nextRunAt: undefined, enabled: false, lastSkipReason: "PUBLISH_ENQUEUE_REVIEW_REQUIRED", lastSkippedAt: now });
        skipped++;
        continue;
      }
      await ctx.db.patch(s._id, {
        lastRunAt: now,
        lastJobId: jobId,
        nextRunAt: next,
        enabled: next !== undefined,
        lastSkipReason: undefined,
        lastSkippedAt: undefined,
      });
      if (s.autoApprove !== true) await ctx.scheduler.runAfter(0, internal.telegram.notifyApproval, { jobId });
      created++;
    }
    return { created, skipped, processed: due.length, batchLimited: due.length === SCHEDULE_TICK_BATCH_SIZE };
  },
});
