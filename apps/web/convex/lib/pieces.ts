import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { stripMatchingTrailingHashtagBlock } from "@automoney/shared";
import { sha256Hex } from "./crypto";
import { fail } from "./errors";
import { isActiveSuperAdmin } from "./rbac";

export function contentPieceText(piece: Pick<Doc<"contentPieces">, "caption" | "hashtags">): string {
  const caption = stripMatchingTrailingHashtagBlock(piece.caption, piece.hashtags);
  return piece.hashtags.length
    ? `${caption}\n\n${piece.hashtags.map((hashtag) => `#${hashtag}`).join(" ")}`
    : caption;
}

export function contentPieceOutputHash(piece: Doc<"contentPieces">): string | null {
  const value = (piece.productionMeta as { outputHash?: unknown } | undefined)?.outputHash;
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value : null;
}

/**
 * Revision identifier used by publishing. Workflow outputs retain their
 * review-bound output hash; manual pieces get a deterministic hash of every
 * publishable field so they cannot be attributed while carrying overrides.
 */
export async function contentPiecePublishOutputHash(piece: Doc<"contentPieces">): Promise<string | null> {
  const reviewedHash = contentPieceOutputHash(piece);
  if (contentPieceEvidenceRunId(piece)) return reviewedHash;
  if (piece.generatedBy !== "manual") return null;
  return await manualContentOutputHash(piece);
}

/** Deterministic revision hash for manually authored publishable fields. */
export async function manualContentOutputHash(
  piece: Pick<Doc<"contentPieces">, "channel" | "caption" | "hashtags" | "script" | "mediaUrls">,
): Promise<string> {
  return await sha256Hex(JSON.stringify({
    channel: piece.channel,
    caption: piece.caption,
    hashtags: piece.hashtags,
    script: piece.script ?? null,
    mediaUrls: piece.mediaUrls,
  }));
}

export function contentPieceEvidenceRunId(piece: Doc<"contentPieces">): Id<"contentRuns"> | undefined {
  return piece.runId ?? piece.evidenceRunId;
}

/** Supply originals and user copies both keep immutable operator-supply lineage. */
export function contentPieceHasOperatorSupplyLineage(piece: Doc<"contentPieces">): boolean {
  const meta = piece.productionMeta as { sourceCollectionId?: unknown } | undefined;
  return !!piece.collectionId || typeof meta?.sourceCollectionId === "string";
}

/** A source piece remains usable only while its operator collection is publicly active. */
export async function operatorSupplySourceAvailable(
  ctx: MutationCtx | QueryCtx,
  piece: Doc<"contentPieces">,
): Promise<boolean> {
  if (!piece.collectionId) return true;
  const collection = await ctx.db.get(piece.collectionId);
  const operatorOwner = piece.ownerUserId ? await ctx.db.get(piece.ownerUserId) : null;
  return !!collection
    && !!operatorOwner
    && isActiveSuperAdmin(operatorOwner)
    && collection.status === "PUBLISHED"
    && collection.publishedBy === piece.ownerUserId
    && piece.libraryPublishedBy === piece.ownerUserId
    && piece.libraryPublishedAt !== undefined
    && collection.publishedAt === piece.libraryPublishedAt;
}

/** Product-backed content is publishable only while its linked product is active. */
export async function contentPieceProductAvailable(
  ctx: MutationCtx | QueryCtx,
  piece: Doc<"contentPieces">,
): Promise<boolean> {
  if (!piece.productId) return true;
  return (await ctx.db.get(piece.productId))?.status === "ACTIVE";
}

export const completeContentReviewChecklist = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checklist = value as Record<string, unknown>;
  return checklist.productFacts === true
    && checklist.adDisclosure === true
    && checklist.mediaRightsAndFit === true
    && checklist.finalCopy === true;
};

/** Verify current run-scoped approval against an immutable human review event. */
export async function workflowReviewEvidence(
  ctx: MutationCtx | QueryCtx,
  piece: Doc<"contentPieces">,
): Promise<{ ok: true; outputHash: string } | { ok: false; reason: string }> {
  if (!contentPieceEvidenceRunId(piece)) return { ok: true, outputHash: contentPieceOutputHash(piece) ?? "" };
  const meta = piece.productionMeta as {
    outputHash?: unknown;
    standardPassed?: unknown;
    humanApprovedAt?: unknown;
    approvedByUserId?: unknown;
    reviewChecklist?: unknown;
  } | undefined;
  const outputHash = contentPieceOutputHash(piece);
  if (!outputHash || typeof meta?.humanApprovedAt !== "number" || typeof meta.approvedByUserId !== "string" || !completeContentReviewChecklist(meta.reviewChecklist)) {
    return { ok: false, reason: "현재 revision의 구조화된 사람 승인 증거가 없습니다." };
  }
  const events = await ctx.db
    .query("contentReviewEvents")
    .withIndex("by_piece", (q) => q.eq("pieceId", piece._id))
    .order("desc")
    .take(20);
  const event = events.find((candidate) =>
    candidate.action === "APPROVED"
    && candidate.outputHash === outputHash
    && candidate.actorUserId === meta.approvedByUserId
    && candidate.createdAt === meta.humanApprovedAt
    && completeContentReviewChecklist(candidate.reviewChecklist),
  );
  return event
    ? { ok: true, outputHash }
    : { ok: false, reason: "현재 revision과 일치하는 불변 검토 기록이 없습니다." };
}

/**
 * Global operator-library publication requires an exact immutable human review
 * for every source, including otherwise auto-approved manual content.
 */
export async function libraryReviewEvidence(
  ctx: MutationCtx | QueryCtx,
  piece: Doc<"contentPieces">,
): Promise<{ ok: true; outputHash: string } | { ok: false; reason: string }> {
  const meta = piece.productionMeta as {
    outputHash?: unknown;
    standardPassed?: unknown;
    humanApprovedAt?: unknown;
    approvedByUserId?: unknown;
    reviewChecklist?: unknown;
  } | undefined;
  const expectedHash = piece.generatedBy === "manual"
    ? await manualContentOutputHash(piece)
    : contentPieceOutputHash(piece);
  if (
    !expectedHash
    || meta?.outputHash !== expectedHash
    || meta.standardPassed !== true
    || typeof meta.humanApprovedAt !== "number"
    || typeof meta.approvedByUserId !== "string"
    || !completeContentReviewChecklist(meta.reviewChecklist)
  ) return { ok: false, reason: "현재 revision의 구조화된 운영 검수 증거가 없습니다." };
  const events = await ctx.db
    .query("contentReviewEvents")
    .withIndex("by_piece", (q) => q.eq("pieceId", piece._id))
    .order("desc")
    .take(20);
  const event = events.find((candidate) =>
    candidate.action === "APPROVED"
    && candidate.outputHash === expectedHash
    && candidate.actorUserId === meta.approvedByUserId
    && candidate.createdAt === meta.humanApprovedAt
    && completeContentReviewChecklist(candidate.reviewChecklist),
  );
  return event
    ? { ok: true, outputHash: expectedHash }
    : { ok: false, reason: "현재 revision과 일치하는 불변 운영 검수 기록이 없습니다." };
}

export async function hashPiecePublishSnapshot(input: {
  pieceId: Id<"contentPieces">;
  outputHash: string;
  text: string;
  mediaUrls: string[];
  linkId?: Id<"marketingLinks">;
  linkUrl: string | null;
}): Promise<string> {
  return await sha256Hex(JSON.stringify({
    pieceId: input.pieceId,
    outputHash: input.outputHash,
    text: input.text,
    mediaUrls: input.mediaUrls,
    linkId: input.linkId ?? null,
    linkUrl: input.linkUrl,
  }));
}

/** 라이브러리 조각을 발행/예약 본문으로 읽는다. 사용 횟수는 실제 게시 성공 때만 증가한다. */
export async function consumePiece(
  ctx: MutationCtx,
  userId: Id<"users">,
  pieceId: Id<"contentPieces">,
): Promise<{
  text: string;
  mediaUrls: string[];
  channel: string;
  productId?: Id<"products">;
  runId?: Id<"contentRuns">;
  outputHash: string;
}> {
  const p = await ctx.db.get(pieceId);
  if (!p || p.status !== "APPROVED")
    fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
  const actor = await ctx.db.get(userId);
  const activeSuperAdmin = !!actor && isActiveSuperAdmin(actor);
  if (!(await contentPieceProductAvailable(ctx, p)))
    fail("CONFLICT", "판매 중이 아닌 상품의 콘텐츠는 게시할 수 없습니다.");
  if (!(await operatorSupplySourceAvailable(ctx, p)))
    fail("FORBIDDEN", "현재 공개 중인 운영 콘텐츠만 게시할 수 있습니다.");
  const evidenceRunId = contentPieceEvidenceRunId(p);
  if (!evidenceRunId && p.generatedBy !== "manual")
    fail("CONFLICT", "이전 품질 계약으로 생성된 콘텐츠는 게시할 수 없습니다. 새 제작 워크플로로 다시 생성하세요.");
  if (evidenceRunId) {
    const run = await ctx.db.get(evidenceRunId);
    const productionMeta = p.productionMeta as { standardPassed?: boolean } | undefined;
    const standardPassed = productionMeta?.standardPassed === true;
    const operatorSupplyLineage = contentPieceHasOperatorSupplyLineage(p);
    if (!standardPassed || (!operatorSupplyLineage && run?.status !== "COMPLETED"))
      fail("CONFLICT", "전체 제작 실행의 품질 검수와 사람 승인이 완료된 콘텐츠만 게시할 수 있습니다.");
    const review = await workflowReviewEvidence(ctx, p);
    if (!review.ok) fail("CONFLICT", `${review.reason} 콘텐츠를 다시 검토·승인하세요.`);
  }
  if (
    p.ownerUserId !== userId &&
    !(p.visibility === "SHARED" && p.status === "APPROVED") &&
    !activeSuperAdmin
  )
    fail("FORBIDDEN", "접근할 수 없는 콘텐츠입니다.");
  if (p.ownerUserId !== userId && !activeSuperAdmin) {
    if (!p.ownerUserId) fail("FORBIDDEN", "공유 콘텐츠의 운영 소유자를 확인할 수 없습니다.");
    const owner = await ctx.db.get(p.ownerUserId);
    if (!owner || !isActiveSuperAdmin(owner))
      fail("FORBIDDEN", "운영사가 제공한 공유 콘텐츠만 사용할 수 있습니다.");
    const libraryReview = await libraryReviewEvidence(ctx, p);
    if (!libraryReview.ok) fail("FORBIDDEN", "운영 검수가 완료된 공유 콘텐츠만 사용할 수 있습니다.");
  }
  const outputHash = await contentPiecePublishOutputHash(p);
  if (!outputHash)
    fail("CONFLICT", "승인된 콘텐츠 revision 정보를 확인할 수 없습니다. 콘텐츠를 다시 검토·승인하세요.");
  return {
    text: contentPieceText(p),
    mediaUrls: p.mediaUrls,
    channel: p.channel,
    productId: p.productId,
    runId: evidenceRunId,
    outputHash,
  };
}
