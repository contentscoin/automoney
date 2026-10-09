import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { editPieceFor } from "./content";
import { fail } from "./lib/errors";
import { isActiveSuperAdmin, requireUser } from "./lib/rbac";
import { MEDIA_TYPES, mediaAssetUrl, mediaRevisionHash, resolveMediaIntegrity, storageMatches } from "./lib/mediaIntegrity";

const TTL = 30 * 60_000;
const requestArgs = { requestId: v.id("contentMediaFreezes") };
async function editable(ctx: QueryCtx | MutationCtx, piece: Doc<"contentPieces"> | null, user: Doc<"users"> | null) {
  if (!piece || !user || (user.status ?? "ACTIVE") !== "ACTIVE" || (piece.ownerUserId !== user._id && !isActiveSuperAdmin(user))) fail("FORBIDDEN", "이 콘텐츠의 미디어를 준비할 권한이 없습니다.");
  if (piece.status === "RETIRED") fail("CONFLICT", "보관 종료한 콘텐츠는 수정할 수 없습니다.");
  if (piece.collectionId) {
    const collection = await ctx.db.get(piece.collectionId);
    if (!isActiveSuperAdmin(user) || !collection || collection.status !== "DRAFT") fail("CONFLICT", "공급 묶음을 수정 상태로 전환한 뒤 미디어를 준비하세요.");
    const runs = await ctx.db.query("contentRuns").withIndex("by_collection", q => q.eq("collectionId", collection._id)).collect();
    if (runs.some(run => run.status === "QUEUED" || run.status === "RUNNING")) fail("CONFLICT", "진행 중인 AI 제작이 끝난 뒤 다시 시도하세요.");
  }
  return { piece, user };
}
async function current(ctx: QueryCtx | MutationCtx, requestId: Id<"contentMediaFreezes">) {
  const request = await ctx.db.get(requestId);
  if (!request || (request.status !== "PENDING" && request.status !== "RUNNING") || request.expiresAt <= Date.now()) fail("CONFLICT", "미디어 저장 요청이 만료되었거나 종료되었습니다.");
  const { piece, user } = await editable(ctx, await ctx.db.get(request.pieceId), await ctx.db.get(request.userId));
  if (piece.mediaFreezeId !== request._id || await mediaRevisionHash(piece) !== request.inputHash) fail("CONFLICT", "저장 중 콘텐츠가 변경되었습니다. 최신 콘텐츠에서 다시 준비하세요.");
  return { request, piece, user };
}

export const requestFreeze = mutation({
  args: { pieceId: v.id("contentPieces"), expectedMediaRevisionHash: v.string(), rightsConfirmed: v.boolean(), rightsNote: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const { piece } = await editable(ctx, await ctx.db.get(args.pieceId), user);
    const rightsNote = args.rightsNote.trim();
    if (!args.rightsConfirmed || rightsNote.length < 3 || rightsNote.length > 1000) fail("INVALID_ARGUMENT", "파일 사용 권한과 공개 배포 동의를 확인하고 근거를 3~1000자로 입력하세요.");
    if (!piece.mediaUrls.length || piece.mediaUrls.length > 30) fail("INVALID_ARGUMENT", "준비할 이미지·영상 주소를 1~30개 입력하세요.");
    const inputHash = await mediaRevisionHash(piece);
    if (inputHash !== args.expectedMediaRevisionHash) fail("CONFLICT", "콘텐츠가 변경되었습니다. 최신 내용을 확인하세요.");
    const previous = piece.mediaFreezeId ? await ctx.db.get(piece.mediaFreezeId) : null;
    if (previous && (previous.status === "PENDING" || previous.status === "RUNNING") && previous.expiresAt > Date.now() && previous.inputHash === inputHash) return { requestId: previous._id };
    if ((await resolveMediaIntegrity(ctx, piece.mediaUrls)).ok) fail("CONFLICT", "이미 고정된 파일입니다. 미디어를 확인한 뒤 승인하세요.");
    const recent = await ctx.db.query("contentMediaFreezes").withIndex("by_user_created", q => q.eq("userId", user._id).gte("createdAt", Date.now() - 60 * 60_000)).take(13);
    if (recent.length >= 12) fail("CONFLICT", "미디어 준비는 시간당 12회까지 가능합니다. 잠시 후 다시 시도하세요.");
    if (previous && (previous.status === "PENDING" || previous.status === "RUNNING")) await ctx.db.patch(previous._id, { status: "FAILED", error: "새 준비 요청으로 교체되었습니다.", finishedAt: Date.now() });
    // Validate basic URL shape here; DNS, redirects and pinned connections are checked in the Node worker.
    for (const raw of piece.mediaUrls) {
      let url: URL;
      try { url = new URL(raw); } catch { fail("INVALID_ARGUMENT", "올바른 HTTPS 미디어 주소를 입력하세요."); }
      if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || raw.length > 4096) fail("INVALID_ARGUMENT", "인증 정보가 없는 HTTPS 미디어 주소만 사용할 수 있습니다.");
    }
    const requestId = await ctx.db.insert("contentMediaFreezes", { pieceId: piece._id, userId: user._id, status: "PENDING", inputHash, sourceUrls: piece.mediaUrls, resultUrls: [], rightsNote, completedCount: 0, createdAt: Date.now(), expiresAt: Date.now() + TTL });
    await ctx.db.patch(piece._id, { mediaFreezeId: requestId });
    await ctx.scheduler.runAfter(0, internal.mediaCapture.captureNext, { requestId });
    return { requestId };
  },
});

export const nextFile = internalQuery({ args: requestArgs, handler: async (ctx, args) => {
  const { request } = await current(ctx, args.requestId);
  const index = request.completedCount;
  const sourceUrl = request.sourceUrls[index];
  if (!sourceUrl) return null;
  const existing = await resolveMediaIntegrity(ctx, [sourceUrl]);
  return { index, sourceUrl, reusable: existing.ok };
} });

export const appendFile = internalMutation({
  args: { ...requestArgs, index: v.number(), file: v.optional(v.object({ storageId: v.id("_storage"), contentHash: v.string(), mimeType: v.string(), extension: v.string(), sizeBytes: v.number() })) },
  handler: async (ctx, args) => {
    const { request, piece, user } = await current(ctx, args.requestId);
    if (args.index !== request.completedCount) return false;
    let url = request.sourceUrls[args.index];
    if (!url) fail("INVALID_ARGUMENT", "저장할 파일 순서가 올바르지 않습니다.");
    if (args.file) {
      if (!MEDIA_TYPES[args.file.mimeType]?.includes(args.file.extension) || !await storageMatches(ctx, args.file)) fail("INVALID_ARGUMENT", "저장한 파일의 지문·크기·형식이 일치하지 않습니다.");
      const assetId = await ctx.db.insert("contentMediaAssets", { requestId: request._id, createdBy: user._id, ...args.file, sourceUrl: url, rightsNote: request.rightsNote, status: "STAGED", createdAt: Date.now(), expiresAt: request.expiresAt });
      url = mediaAssetUrl({ _id: assetId, contentHash: args.file.contentHash, extension: args.file.extension });
    } else if (!(await resolveMediaIntegrity(ctx, [url])).ok) fail("CONFLICT", "재사용할 고정 파일을 찾을 수 없습니다.");
    const resultUrls = [...request.resultUrls, url];
    if (resultUrls.length === request.sourceUrls.length) {
      const assets = await ctx.db.query("contentMediaAssets").withIndex("by_request", q => q.eq("requestId", request._id)).collect();
      for (const asset of assets) {
        if (!await storageMatches(ctx, asset)) fail("CONFLICT", "준비한 파일이 사라졌습니다. 다시 준비하세요.");
        await ctx.db.patch(asset._id, { status: "READY" });
      }
      if (!(await resolveMediaIntegrity(ctx, resultUrls)).ok) fail("CONFLICT", "모든 고정 파일의 검증을 완료하지 못했습니다.");
      await editPieceFor(ctx, user, { pieceId: piece._id, caption: piece.caption, hashtags: piece.hashtags, script: piece.script, mediaUrls: resultUrls });
      await ctx.db.patch(request._id, { status: "SUCCEEDED", resultUrls, completedCount: resultUrls.length, finishedAt: Date.now() });
    } else {
      await ctx.db.patch(request._id, { status: "RUNNING", resultUrls, completedCount: resultUrls.length });
      await ctx.scheduler.runAfter(0, internal.mediaCapture.captureNext, { requestId: request._id });
    }
    return true;
  },
});
export const recordFailure = internalMutation({ args: { ...requestArgs, error: v.string(), expectedIndex: v.optional(v.number()) }, handler: async (ctx, args) => {
  const request = await ctx.db.get(args.requestId);
  if (!request || (request.status !== "PENDING" && request.status !== "RUNNING")) return;
  if (args.expectedIndex !== undefined && request.completedCount !== args.expectedIndex) return;
  if (args.expectedIndex === undefined) {
    try { await current(ctx, args.requestId); return; } catch { /* Only a stale/invalid request may fail without a claimed index. */ }
  }
  await ctx.db.patch(request._id, { status: "FAILED", error: args.error.slice(0, 500), finishedAt: Date.now() });
} });

/** A lost append response is not proof that a blob is unused. Check binding atomically. */
export const cleanupUnbound = internalMutation({ args: { storageId: v.id("_storage") }, handler: async (ctx, args) => {
  const bound = await ctx.db.query("contentMediaAssets").withIndex("by_storage", q => q.eq("storageId", args.storageId)).first();
  if (bound) return false;
  await ctx.storage.delete(args.storageId);
  return true;
} });

export const publicAsset = internalQuery({ args: { assetId: v.string(), fileName: v.string() }, handler: async (ctx, args) => {
  const id = ctx.db.normalizeId("contentMediaAssets", args.assetId);
  const asset = id ? await ctx.db.get(id) : null;
  if (!asset || asset.status !== "READY" || args.fileName !== `${asset.contentHash}.${asset.extension}` || !(await resolveMediaIntegrity(ctx, [mediaAssetUrl(asset)])).ok) return null;
  return { storageId: asset.storageId, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, contentHash: asset.contentHash };
} });
export const sweep = internalMutation({ args: {}, handler: async ctx => {
  for (const status of ["PENDING", "RUNNING"] as const) {
    const expired = await ctx.db.query("contentMediaFreezes").withIndex("by_status_expiry", q => q.eq("status", status).lte("expiresAt", Date.now())).take(50);
    for (const request of expired) await ctx.db.patch(request._id, { status: "FAILED", error: "저장 시간이 초과되었습니다. 다시 준비하세요.", finishedAt: Date.now() });
  }
  const staged = await ctx.db.query("contentMediaAssets").withIndex("by_status_expiry", q => q.eq("status", "STAGED").lte("expiresAt", Date.now())).take(100);
  for (const asset of staged) {
    await ctx.storage.delete(asset.storageId);
    await ctx.db.delete(asset._id);
  }
  return { removedStagedAssets: staged.length };
} });
