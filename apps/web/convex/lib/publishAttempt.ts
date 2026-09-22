import {
  APPROVAL_TTL_MS,
  CHANNEL_PLATFORM,
  validatePublishPayload,
  type PublishPayload,
} from "@automoney/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { canonicalJson } from "../jobs";
import { sha256Hex } from "./crypto";
import { metaLivePublishAvailable } from "./meta";
import {
  contentPieceEvidenceRunId,
  contentPiecePublishOutputHash,
  contentPieceText,
  hashPiecePublishSnapshot,
  workflowReviewEvidence,
} from "./pieces";
import { livePublishEnabled } from "./publishPolicy";
import { marketingRedirectUrl } from "./publicUrl";
import { publicationIdentity } from "./publishIdentity";
import { roleOf } from "./rbac";

export type PublishAttemptPolicyResult =
  | { ok: true; currentHash: string }
  | { ok: false; reason: string };

/**
 * Revalidates every mutable input immediately before the irreversible provider
 * call. Convex mutations are serializable, so recording the attempt in the
 * same mutation closes the preflight-to-click/API TOCTOU window.
 */
export async function validatePublishAttemptPolicy(
  ctx: MutationCtx,
  job: Doc<"agentJobs">,
  now: number,
  options: { continuation?: boolean } = {},
): Promise<PublishAttemptPolicyResult> {
  const deny = (reason: string): PublishAttemptPolicyResult => ({ ok: false, reason });
  if (job.jobType !== "post.publish" || job.status !== "RUNNING") return deny("JOB_NOT_ACTIVE");
  const payload = job.payload as PublishPayload;
  if (payload.dryRun === true) return deny("DRY_RUN_HAS_NO_PUBLISH_ATTEMPT");
  if (options.continuation ? !job.publishAttemptedAt : !!job.publishAttemptedAt)
    return deny(options.continuation ? "PUBLISH_ATTEMPT_REQUIRED" : "PUBLISH_ALREADY_ATTEMPTED");
  if (job.cancelRequested) return deny("JOB_CANCELLED");
  const rootJob = job.rootJobId && job.rootJobId !== job._id ? await ctx.db.get(job.rootJobId) : job;
  if (rootJob?.cancelRequested || rootJob?.status === "CANCELLED") return deny("JOB_CANCELLED");
  if (job.expiresAt && job.expiresAt < now) return deny("SCHEDULE_EXPIRED");
  if (!livePublishEnabled()) return deny("LIVE_PUBLISH_DISABLED");
  if (job.publishPhase !== "INTENT_RECORDED" || !job.publishIntentId) return deny("PREFLIGHT_REQUIRED");

  const currentHash = await sha256Hex(canonicalJson({ jobType: job.jobType, payload: job.payload }));
  if (!job.payloadHash || job.payloadHash !== currentHash) return deny("STALE_APPROVAL");
  if (job.publishPreflightPayloadHash !== currentHash || job.publishPreflightAttemptNo !== job.attemptNo)
    return deny("PREFLIGHT_REQUIRED");
  if (job.approvalRequired !== false) {
    if (!job.approval || job.approval.payloadHash !== currentHash) return deny("APPROVAL_REQUIRED");
    if (now - job.approval.approvedAt > APPROVAL_TTL_MS) return deny("APPROVAL_EXPIRED");
  }

  const user = await ctx.db.get(job.userId);
  if (!user || (user.status ?? "ACTIVE") !== "ACTIVE") return deny("USER_SUSPENDED");
  const space = job.spaceId ? await ctx.db.get(job.spaceId) : null;
  if (!space || space.userId !== job.userId) return deny("SPACE_NOT_FOUND");
  if (!["HEALTHY", "RUNNING"].includes(space.sessionState)) return deny("SPACE_NOT_READY");
  if (payload.spaceId !== space._id || payload.platform !== space.platform) return deny("PUBLISH_TARGET_MISMATCH");

  const identity = await publicationIdentity(ctx, space);
  if (!payload.targetPublicationKey || !identity || payload.targetPublicationKey !== identity.publicationKey)
    return deny("TARGET_IDENTITY_CHANGED");
  if (space.authMode === "META_API" && (!identity.account || !metaLivePublishAvailable(identity.account.mode)))
    return deny("META_CONFIG");

  if (job.scheduleId) {
    const schedule = await ctx.db.get(job.scheduleId);
    const consumedOneShot = schedule?.kind === "ONE_SHOT"
      && schedule.lastJobId === (job.rootJobId ?? job._id)
      && schedule.lastRunAt !== undefined;
    if (!schedule || (!schedule.enabled && !consumedOneShot) || payload.scheduleRevision === undefined || schedule.revision !== payload.scheduleRevision)
      return deny("SCHEDULE_REVISION_CHANGED");
  }

  const piece = payload.pieceId ? await ctx.db.get(payload.pieceId as Id<"contentPieces">) : null;
  if (payload.pieceId && (!piece || piece.status !== "APPROVED")) return deny("CONTENT_UNAVAILABLE");
  if (piece) {
    const accessible = piece.ownerUserId === job.userId || piece.visibility === "SHARED" || roleOf(user) === "SUPER_ADMIN";
    if (!accessible) return deny("CONTENT_UNAVAILABLE");
    if (payload.contentChannel && payload.contentChannel !== piece.channel) return deny("CONTENT_CHANNEL_MISMATCH");
    if (CHANNEL_PLATFORM[piece.channel as keyof typeof CHANNEL_PLATFORM] !== space.platform) return deny("CONTENT_PLATFORM_MISMATCH");
  }

  const evidenceRunId = piece ? contentPieceEvidenceRunId(piece) : undefined;
  if (piece && !evidenceRunId && piece.generatedBy !== "manual") return deny("CONTENT_REVIEW_REQUIRED");
  if (piece && evidenceRunId) {
    const run = await ctx.db.get(evidenceRunId);
    const standardPassed = (piece.productionMeta as { standardPassed?: boolean } | undefined)?.standardPassed === true;
    if (!standardPassed || run?.status !== "COMPLETED") return deny("CONTENT_REVIEW_REQUIRED");
    const review = await workflowReviewEvidence(ctx, piece);
    if (!review.ok) return deny("CONTENT_REVIEW_REQUIRED");
  }

  const link = payload.linkId ? await ctx.db.get(payload.linkId as Id<"marketingLinks">) : null;
  if (payload.linkId && (!link || link.userId !== job.userId)) return deny("LINK_NOT_FOUND");
  if (link?.status !== undefined && link.status !== "ACTIVE") return deny("LINK_INACTIVE");
  if (piece?.productId && link && piece.productId !== link.productId) return deny("CONTENT_LINK_PRODUCT_MISMATCH");
  const expectedLinkUrl = link ? marketingRedirectUrl(link.shortCode) : null;
  if (link && !expectedLinkUrl) return deny("PUBLIC_SITE_URL_INVALID");
  if (link && payload.linkUrl !== expectedLinkUrl) return deny("LINK_URL_MISMATCH");
  if (!link && payload.linkUrl) return deny("LINK_REFERENCE_REQUIRED");

  const payloadError = validatePublishPayload({
    ...payload,
    spaceId: space._id,
    platform: space.platform,
    ...(piece ? { contentChannel: piece.channel as PublishPayload["contentChannel"] } : {}),
  });
  if (payloadError) return deny("PUBLISH_PAYLOAD_INVALID");

  if (piece) {
    if (evidenceRunId && piece.productId && !link) return deny("CONTENT_LINK_REQUIRED");
    const outputHash = await contentPiecePublishOutputHash(piece);
    if (!outputHash || !payload.pieceOutputHash || !payload.pieceSnapshotHash) return deny("CONTENT_SNAPSHOT_MISSING");
    const canonicalText = contentPieceText(piece);
    const snapshotHash = await hashPiecePublishSnapshot({
      pieceId: piece._id,
      outputHash,
      text: canonicalText,
      mediaUrls: piece.mediaUrls,
      linkId: link?._id,
      linkUrl: expectedLinkUrl,
    });
    if (
      payload.pieceOutputHash !== outputHash
      || payload.pieceSnapshotHash !== snapshotHash
      || payload.text !== canonicalText
      || JSON.stringify(payload.mediaUrls) !== JSON.stringify(piece.mediaUrls)
      || payload.linkUrl !== expectedLinkUrl
    )
      return deny("CONTENT_REVISION_CHANGED");
  }

  const intent = await ctx.db.get(job.publishIntentId);
  if (
    !intent
    || intent.rootJobId !== (job.rootJobId ?? job._id)
    || intent.userId !== job.userId
    || intent.spaceId !== space._id
    || intent.publicationKey !== identity.publicationKey
    || intent.state !== "RESERVED"
    || intent.expiresAt < now
  ) return deny("PUBLISH_INTENT_INVALID");

  return { ok: true, currentHash };
}
