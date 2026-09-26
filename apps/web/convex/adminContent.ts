import { v } from "convex/values";
import { contentMediaMax, evaluatePiece, isAutoApprovable, normalizeContentBrief, validateContentMedia, type Channel, type ProductBrief } from "@automoney/shared";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { libraryReviewEvidence, manualContentOutputHash } from "./lib/pieces";
import { isActiveSuperAdmin, requireSuperAdmin } from "./lib/rbac";
import { decorate, requestGenerateFor, type AdminMaterialSnapshot } from "./content";
import { canonicalJson } from "./jobs";

const materialKindValidator = v.union(v.literal("FILE"), v.literal("TEXT"), v.literal("LINK"));
const rightsStatusValidator = v.union(v.literal("OWNED"), v.literal("LICENSED"), v.literal("LINK_ONLY"));
const materialStatusValidator = v.union(v.literal("DRAFT"), v.literal("READY"), v.literal("ARCHIVED"));
const collectionStatusValidator = v.union(
  v.literal("DRAFT"),
  v.literal("IN_REVIEW"),
  v.literal("PUBLISHED"),
  v.literal("WITHDRAWN"),
);
const channelValidator = v.union(
  v.literal("INSTAGRAM_FEED"),
  v.literal("INSTAGRAM_REEL"),
  v.literal("THREADS"),
  v.literal("X"),
  v.literal("TIKTOK"),
  v.literal("BLOG"),
);

function validateMaterialRightsPolicy(
  kind: Doc<"contentSourceMaterials">["kind"],
  rightsStatus: Doc<"contentSourceMaterials">["rightsStatus"],
): void {
  if (kind === "LINK" && rightsStatus !== "LINK_ONLY")
    fail("INVALID_ARGUMENT", "외부 링크 자료는 링크만 인용 권한으로 등록하세요.");
  if (kind !== "LINK" && rightsStatus === "LINK_ONLY")
    fail("INVALID_ARGUMENT", "텍스트·파일 자료는 자체 소유 또는 사용 허가가 확인되어야 합니다.");
}

const MIB = 1024 * 1024;
const CONTENT_UPLOAD_TTL_MS = 15 * 60_000;
const UPLOAD_SWEEP_BATCH = 100;
const MAX_COLLECTION_MATERIALS = 30;
const MAX_COLLECTION_PIECES = 100;
const MAX_AI_MATERIALS = 10;
const MAX_AI_SNAPSHOT_TEXT = 20_000;
export const CONTENT_FILE_POLICY = {
  "image/jpeg": { maxBytes: 10 * MIB, extensions: ["jpg", "jpeg"], media: true },
  "image/png": { maxBytes: 10 * MIB, extensions: ["png"], media: true },
  "image/webp": { maxBytes: 10 * MIB, extensions: ["webp"], media: true },
  "image/gif": { maxBytes: 10 * MIB, extensions: ["gif"], media: true },
  "video/mp4": { maxBytes: 20 * MIB, extensions: ["mp4"], media: true },
  "video/quicktime": { maxBytes: 20 * MIB, extensions: ["mov"], media: true },
  "video/webm": { maxBytes: 20 * MIB, extensions: ["webm"], media: true },
  "application/pdf": { maxBytes: 20 * MIB, extensions: ["pdf"], media: false },
  "text/plain": { maxBytes: 2 * MIB, extensions: ["txt"], media: false },
  "text/csv": { maxBytes: 2 * MIB, extensions: ["csv"], media: false },
} as const;

type AllowedMime = keyof typeof CONTENT_FILE_POLICY;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SAFE_UPLOAD_FILE_NAME = /^[^\\/\u0000-\u001f]{1,200}$/;
const HASH_RE = /^[a-f0-9]{64}$/i;

function normalizeSha256(value: string): string | null {
  if (HASH_RE.test(value)) return value.toLowerCase();
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    if (bytes.length !== 32) return null;
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function cleanRequired(value: string, label: string, max: number): string {
  const cleaned = value.trim();
  if (!cleaned) fail("INVALID_ARGUMENT", `${label}을(를) 입력하세요.`);
  if (cleaned.length > max) fail("INVALID_ARGUMENT", `${label}은(는) ${max}자 이하여야 합니다.`);
  return cleaned;
}

function cleanOptional(value: string | undefined, max: number): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned) return undefined;
  if (cleaned.length > max) fail("INVALID_ARGUMENT", `입력값은 ${max}자 이하여야 합니다.`);
  return cleaned;
}

function normalizeTags(tags: string[]): string[] {
  const normalized = [...new Set(tags.map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))];
  if (normalized.length > 20) fail("INVALID_ARGUMENT", "태그는 최대 20개까지 입력할 수 있습니다.");
  if (normalized.some((tag) => tag.length > 40)) fail("INVALID_ARGUMENT", "태그는 각각 40자 이하여야 합니다.");
  return normalized;
}

function safeHttpsUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    fail("INVALID_ARGUMENT", `${label}은(는) 올바른 HTTPS 주소여야 합니다.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    fail("INVALID_ARGUMENT", `${label}은(는) 인증정보가 없는 HTTPS 주소여야 합니다.`);
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) fail("INVALID_ARGUMENT", `${label}에 내부 네트워크 주소를 사용할 수 없습니다.`);
  return parsed.toString();
}

function convexSiteUrl(): string {
  const raw = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  if (!raw || !/^https:\/\/[^/]+$/i.test(raw))
    fail("CONFIG_MISSING", "CONVEX_SITE_URL이 올바르게 설정되지 않았습니다.");
  return raw;
}

function materialDeliveryUrl(material: Pick<Doc<"contentSourceMaterials">, "_id" | "kind" | "fileName" | "storageId" | "mimeType">): string | null {
  if (
    material.kind !== "FILE"
    || !material.storageId
    || !material.fileName
    || !material.mimeType
    || !(material.mimeType in CONTENT_FILE_POLICY)
    || !CONTENT_FILE_POLICY[material.mimeType as AllowedMime].media
  ) return null;
  return `${convexSiteUrl()}/content-assets/${material._id}/${encodeURIComponent(material.fileName)}`;
}

async function materialAdminPreviewUrl(
  ctx: QueryCtx,
  material: Pick<Doc<"contentSourceMaterials">, "kind" | "storageId">,
): Promise<string | null> {
  if (material.kind !== "FILE" || !material.storageId) return null;
  return await ctx.storage.getUrl(material.storageId);
}

function isMediaMaterial(material: Doc<"contentSourceMaterials">): boolean {
  return material.kind === "FILE"
    && !!material.mimeType
    && material.mimeType in CONTENT_FILE_POLICY
    && CONTENT_FILE_POLICY[material.mimeType as AllowedMime].media;
}

async function validateStoredFileMaterial(
  ctx: QueryCtx | MutationCtx,
  material: Doc<"contentSourceMaterials">,
): Promise<void> {
  if (material.kind !== "FILE") return;
  if (material.rightsStatus === "LINK_ONLY")
    fail("CONFLICT", "저장 파일은 OWNED 또는 LICENSED 권리가 필요합니다.");
  if (
    !material.storageId
    || !material.fileName
    || !material.mimeType
    || !(material.mimeType in CONTENT_FILE_POLICY)
    || material.sizeBytes === undefined
    || !material.contentHash
    || !HASH_RE.test(material.contentHash)
  ) fail("CONFLICT", "파일 자료의 무결성 정보를 확인할 수 없습니다.");
  const policy = CONTENT_FILE_POLICY[material.mimeType as AllowedMime];
  const extension = material.fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!(policy.extensions as readonly string[]).includes(extension))
    fail("CONFLICT", "파일 자료의 MIME 형식과 확장자가 일치하지 않습니다.");
  const metadata = await ctx.db.system.get(material.storageId);
  if (!metadata) fail("CONFLICT", "저장된 원본 파일을 찾을 수 없습니다.");
  const storedMime = metadata.contentType?.split(";")[0]?.trim().toLowerCase();
  const testMimeFallback = process.env.NODE_ENV === "test"
    && process.env.AUTOMONEY_TEST_ALLOW_DECLARED_STORAGE_MIME === "true"
    ? material.mimeType
    : undefined;
  if ((storedMime ?? testMimeFallback) !== material.mimeType)
    fail("CONFLICT", "저장된 파일의 MIME 형식이 등록 정보와 일치하지 않습니다.");
  if (metadata.size !== material.sizeBytes || metadata.size <= 0 || metadata.size > policy.maxBytes)
    fail("CONFLICT", "저장된 파일의 크기가 등록 정보와 일치하지 않습니다.");
  if (normalizeSha256(metadata.sha256) !== material.contentHash)
    fail("CONFLICT", "저장된 파일의 무결성 해시가 등록 정보와 일치하지 않습니다.");
}

async function ownedMaterial(
  ctx: QueryCtx | MutationCtx,
  _actorId: Id<"users">,
  materialId: Id<"contentSourceMaterials">,
): Promise<Doc<"contentSourceMaterials">> {
  const material = await ctx.db.get(materialId);
  if (!material) fail("NOT_FOUND", "운영 자료를 찾을 수 없습니다.");
  return material;
}

async function ownedCollection(
  ctx: QueryCtx | MutationCtx,
  _actorId: Id<"users">,
  collectionId: Id<"contentCollections">,
): Promise<Doc<"contentCollections">> {
  const collection = await ctx.db.get(collectionId);
  if (!collection) fail("NOT_FOUND", "콘텐츠 컬렉션을 찾을 수 없습니다.");
  return collection;
}

async function requireReadyCollectionMaterials(
  ctx: QueryCtx | MutationCtx,
  actorId: Id<"users">,
  materialIds: Id<"contentSourceMaterials">[],
): Promise<Doc<"contentSourceMaterials">[]> {
  if (materialIds.length === 0) fail("CONFLICT", "검수 완료된 운영 자료를 하나 이상 연결하세요.");
  const unique = [...new Set(materialIds)];
  if (unique.length !== materialIds.length) fail("INVALID_ARGUMENT", "운영 자료가 중복되었습니다.");
  const materials = [];
  for (const id of unique) {
    const material = await ownedMaterial(ctx, actorId, id);
    if (material.status !== "READY") fail("CONFLICT", "READY 상태의 운영 자료만 사용할 수 있습니다.");
    if (!material.rightsNote.trim()) fail("CONFLICT", "모든 운영 자료에 권리 근거가 필요합니다.");
    validateMaterialRightsPolicy(material.kind, material.rightsStatus);
    await validateStoredFileMaterial(ctx, material);
    if (material.productId) {
      const product = await ctx.db.get(material.productId);
      if (!product || product.status !== "ACTIVE") fail("CONFLICT", "운영 자료에 연결된 상품이 판매 중이 아닙니다.");
    }
    materials.push(material);
  }
  return materials;
}

async function reopenCollectionInternal(
  ctx: MutationCtx,
  actorId: Id<"users">,
  collection: Doc<"contentCollections">,
  reason: string,
): Promise<void> {
  if (collection.status === "DRAFT") return;
  const now = Date.now();
  for (const pieceId of collection.pieceIds) {
    const piece = await ctx.db.get(pieceId);
    if (!piece || piece.collectionId !== collection._id) continue;
    await ctx.db.patch(piece._id, {
      visibility: "PRIVATE",
      ...(piece.visibility === "SHARED" ? { libraryWithdrawnAt: now } : {}),
    });
  }
  await ctx.db.patch(collection._id, {
    status: "DRAFT",
    revision: collection.revision + 1,
    reviewedBy: undefined,
    reviewedByIds: undefined,
    reviewedAt: undefined,
    submittedAt: undefined,
    publishedBy: undefined,
    publishedAt: undefined,
    withdrawnBy: collection.status === "PUBLISHED" ? actorId : collection.withdrawnBy,
    withdrawnAt: collection.status === "PUBLISHED" ? now : collection.withdrawnAt,
    updatedAt: now,
  });
  await audit(ctx, {
    actorUserId: actorId,
    action: "adminContent.collectionReopen",
    metadata: { collectionId: collection._id, from: collection.status, revision: collection.revision + 1, reason },
  });
}

export async function reopenCollectionForPieceEdit(
  ctx: MutationCtx,
  actorId: Id<"users">,
  collectionId: Id<"contentCollections">,
): Promise<void> {
  const collection = await ownedCollection(ctx, actorId, collectionId);
  await reopenCollectionInternal(ctx, actorId, collection, "piece.edit");
}

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await requireSuperAdmin(ctx);
    const now = Date.now();
    const intentId = await ctx.db.insert("uploadIntents", {
      userId: actor._id,
      purpose: "CONTENT_MATERIAL",
      expiresAt: now + CONTENT_UPLOAD_TTL_MS,
      state: "PENDING",
      createdAt: now,
    });
    return { intentId, uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

export const bindUpload = mutation({
  args: { intentId: v.id("uploadIntents"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.userId !== actor._id || intent.purpose !== "CONTENT_MATERIAL")
      fail("NOT_FOUND", "콘텐츠 업로드 요청을 찾을 수 없습니다.");
    if (intent.state !== "PENDING" || intent.expiresAt < Date.now())
      fail("CONFLICT", "콘텐츠 업로드 요청이 만료되었거나 이미 사용되었습니다.");
    if (!(await ctx.db.system.get(args.storageId))) fail("INVALID_ARGUMENT", "업로드한 파일을 찾을 수 없습니다.");
    const existing = await ctx.db
      .query("uploadIntents")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    if (existing && existing._id !== intent._id)
      fail("CONFLICT", "이미 다른 업로드 요청에 연결된 파일입니다.");
    await ctx.db.patch(intent._id, { storageId: args.storageId, state: "BOUND" });
    return { ok: true as const };
  },
});

/** Bounded janitor for abandoned KYC/content uploads. */
export const sweepExpiredUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let expired = 0;
    let deleted = 0;
    for (const state of ["PENDING", "BOUND"] as const) {
      const rows = await ctx.db
        .query("uploadIntents")
        .withIndex("by_state_expiry", (q) => q.eq("state", state).lte("expiresAt", now))
        .take(UPLOAD_SWEEP_BATCH);
      for (const intent of rows) {
        if (intent.storageId) {
          const references = await ctx.db
            .query("uploadIntents")
            .withIndex("by_storage", (q) => q.eq("storageId", intent.storageId))
            .collect();
          if (!references.some((reference) => reference._id !== intent._id && reference.state === "CONSUMED")) {
            await ctx.storage.delete(intent.storageId);
            deleted++;
          }
        }
        await ctx.db.patch(intent._id, { state: "EXPIRED" });
        expired++;
      }
    }
    if (expired > 0) await audit(ctx, { action: "uploads.sweepExpired", metadata: { expired, deleted } });
    return { expired, deleted };
  },
});

export const createMaterial = mutation({
  args: {
    kind: materialKindValidator,
    title: v.string(),
    bodyText: v.optional(v.string()),
    externalUrl: v.optional(v.string()),
    uploadIntentId: v.optional(v.id("uploadIntents")),
    fileName: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    productId: v.optional(v.id("products")),
    rightsStatus: rightsStatusValidator,
    rightsNote: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const title = cleanRequired(args.title, "자료 제목", 160);
    const rightsNote = cleanRequired(args.rightsNote, "권리 근거", 1_000);
    validateMaterialRightsPolicy(args.kind, args.rightsStatus);
    if (args.productId && !(await ctx.db.get(args.productId))) fail("NOT_FOUND", "상품을 찾을 수 없습니다.");

    let bodyText: string | undefined;
    let externalUrl: string | undefined;
    let storageId: Id<"_storage"> | undefined;
    let fileName: string | undefined;
    let mimeType: string | undefined;
    let sizeBytes: number | undefined;
    let contentHash: string | undefined;
    let uploadIntent: Doc<"uploadIntents"> | undefined;
    if (args.kind === "TEXT") {
      bodyText = cleanRequired(args.bodyText ?? "", "본문", 200_000);
      externalUrl = args.externalUrl ? safeHttpsUrl(args.externalUrl, "원문 링크") : undefined;
      if (args.uploadIntentId || args.fileName)
        fail("INVALID_ARGUMENT", "텍스트 자료에는 파일을 함께 지정할 수 없습니다.");
    } else if (args.kind === "LINK") {
      externalUrl = safeHttpsUrl(args.externalUrl ?? "", "외부 링크");
      if (args.bodyText || args.uploadIntentId || args.fileName)
        fail("INVALID_ARGUMENT", "링크 자료에는 본문이나 파일을 함께 지정할 수 없습니다.");
    } else {
      if (!args.uploadIntentId || !args.fileName) fail("INVALID_ARGUMENT", "파일 자료에는 유효한 업로드 요청과 파일명이 필요합니다.");
      if (args.rightsStatus === "LINK_ONLY")
        fail("INVALID_ARGUMENT", "파일을 저장·전달하려면 OWNED 또는 LICENSED 권리가 필요합니다.");
      if (args.bodyText) fail("INVALID_ARGUMENT", "파일 자료에는 본문을 함께 지정할 수 없습니다.");
      externalUrl = args.externalUrl ? safeHttpsUrl(args.externalUrl, "원문 링크") : undefined;
      if (!SAFE_UPLOAD_FILE_NAME.test(args.fileName)) fail("INVALID_ARGUMENT", "파일명에 경로 또는 제어 문자를 사용할 수 없습니다.");
      uploadIntent = await ctx.db.get(args.uploadIntentId) ?? undefined;
      if (
        !uploadIntent
        || uploadIntent.userId !== actor._id
        || uploadIntent.purpose !== "CONTENT_MATERIAL"
        || uploadIntent.state !== "BOUND"
        || !uploadIntent.storageId
        || uploadIntent.expiresAt < Date.now()
      ) fail("CONFLICT", "콘텐츠 업로드 요청이 만료되었거나 사용할 수 없습니다.");
      const metadata = await ctx.db.system.get(uploadIntent.storageId);
      if (!metadata) fail("INVALID_ARGUMENT", "업로드한 파일을 찾을 수 없습니다.");
      const suppliedMime = args.mimeType?.split(";")[0]?.trim().toLowerCase();
      const storedMime = metadata.contentType?.split(";")[0]?.trim().toLowerCase();
      const testMimeFallback = process.env.NODE_ENV === "test"
        && process.env.AUTOMONEY_TEST_ALLOW_DECLARED_STORAGE_MIME === "true"
        ? suppliedMime
        : undefined;
      const actualMime = storedMime ?? testMimeFallback;
      if (!actualMime || !(actualMime in CONTENT_FILE_POLICY)) fail("INVALID_ARGUMENT", "지원하지 않는 파일 형식입니다.");
      if (storedMime && suppliedMime && actualMime !== suppliedMime)
        fail("INVALID_ARGUMENT", "요청한 MIME 형식과 업로드 파일의 실제 형식이 일치하지 않습니다.");
      const policy = CONTENT_FILE_POLICY[actualMime as AllowedMime];
      const extension = args.fileName.split(".").pop()?.toLowerCase() ?? "";
      if (!(policy.extensions as readonly string[]).includes(extension))
        fail("INVALID_ARGUMENT", "파일 확장자와 실제 MIME 형식이 일치하지 않습니다.");
      if (metadata.size <= 0 || metadata.size > policy.maxBytes)
        fail("INVALID_ARGUMENT", `파일 크기는 ${Math.floor(policy.maxBytes / MIB)}MB 이하여야 합니다.`);
      const normalizedHash = normalizeSha256(metadata.sha256);
      if (!normalizedHash) fail("INVALID_ARGUMENT", "업로드 파일의 무결성 해시를 확인할 수 없습니다.");
      storageId = uploadIntent.storageId;
      fileName = SAFE_FILE_NAME.test(args.fileName)
        ? args.fileName
        : `asset-${normalizedHash.slice(0, 16)}.${extension}`;
      mimeType = actualMime;
      sizeBytes = metadata.size;
      contentHash = normalizedHash;
    }

    const now = Date.now();
    const materialId = await ctx.db.insert("contentSourceMaterials", {
      kind: args.kind,
      title,
      bodyText,
      externalUrl,
      storageId,
      fileName,
      mimeType,
      sizeBytes,
      contentHash,
      productId: args.productId,
      rightsStatus: args.rightsStatus,
      rightsNote,
      status: "DRAFT",
      createdBy: actor._id,
      createdAt: now,
      updatedAt: now,
    });
    const material = (await ctx.db.get(materialId))!;
    if (uploadIntent) await ctx.db.patch(uploadIntent._id, { state: "CONSUMED" });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "adminContent.materialCreate",
      metadata: { materialId, kind: args.kind, productId: args.productId ?? null, contentHash: contentHash ?? null },
    });
    return { materialId, deliveryUrl: materialDeliveryUrl(material) };
  },
});

export const markMaterialReady = mutation({
  args: { materialId: v.id("contentSourceMaterials") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const material = await ownedMaterial(ctx, actor._id, args.materialId);
    if (material.status !== "DRAFT") fail("CONFLICT", "초안 자료만 검수 완료할 수 있습니다.");
    validateMaterialRightsPolicy(material.kind, material.rightsStatus);
    await validateStoredFileMaterial(ctx, material);
    if (material.productId) {
      const product = await ctx.db.get(material.productId);
      if (!product || product.status !== "ACTIVE") fail("CONFLICT", "연결된 상품이 판매 중이 아닙니다.");
    }
    const now = Date.now();
    await ctx.db.patch(material._id, { status: "READY", readyAt: material.readyAt ?? now, updatedAt: now });
    await audit(ctx, { actorUserId: actor._id, action: "adminContent.materialReady", metadata: { materialId: material._id } });
  },
});

export const archiveMaterial = mutation({
  args: { materialId: v.id("contentSourceMaterials") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const material = await ownedMaterial(ctx, actor._id, args.materialId);
    if (material.status === "ARCHIVED") return;
    const collections = await ctx.db.query("contentCollections").collect();
    if (collections.some((collection) => collection.status !== "WITHDRAWN" && collection.sourceMaterialIds.includes(material._id)))
      fail("CONFLICT", "사용 중인 컬렉션의 자료는 보관할 수 없습니다. 컬렉션 작업을 먼저 종료하세요.");
    await ctx.db.patch(material._id, { status: "ARCHIVED", updatedAt: Date.now() });
    await audit(ctx, { actorUserId: actor._id, action: "adminContent.materialArchive", metadata: { materialId: material._id } });
  },
});

export const listMaterials = query({
  args: { status: v.optional(materialStatusValidator) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const rows = args.status
      ? await ctx.db.query("contentSourceMaterials").withIndex("by_status", (q) => q.eq("status", args.status!)).order("desc").take(500)
      : await ctx.db.query("contentSourceMaterials").order("desc").take(500);
    return await Promise.all(rows.map(async (row) => ({
      ...row,
      deliveryUrl: materialDeliveryUrl(row),
      previewUrl: await materialAdminPreviewUrl(ctx, row),
    })));
  },
});

export const createCollection = mutation({
  args: {
    title: v.string(),
    summary: v.optional(v.string()),
    tags: v.array(v.string()),
    sourceMaterialIds: v.array(v.id("contentSourceMaterials")),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const title = cleanRequired(args.title, "컬렉션 제목", 160);
    const summary = cleanOptional(args.summary, 1_000);
    const sourceMaterialIds = [...new Set(args.sourceMaterialIds)];
    if (sourceMaterialIds.length === 0) fail("INVALID_ARGUMENT", "운영 자료를 하나 이상 선택하세요.");
    if (sourceMaterialIds.length > MAX_COLLECTION_MATERIALS)
      fail("INVALID_ARGUMENT", `컬렉션에는 운영 자료를 최대 ${MAX_COLLECTION_MATERIALS}개까지 연결할 수 있습니다.`);
    for (const id of sourceMaterialIds) {
      const material = await ownedMaterial(ctx, actor._id, id);
      if (material.status === "ARCHIVED") fail("CONFLICT", "보관된 자료는 컬렉션에 추가할 수 없습니다.");
    }
    const now = Date.now();
    const collectionId = await ctx.db.insert("contentCollections", {
      title,
      summary,
      tags: normalizeTags(args.tags),
      sourceMaterialIds,
      pieceIds: [],
      status: "DRAFT",
      createdBy: actor._id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "adminContent.collectionCreate",
      metadata: { collectionId, sourceMaterialIds, revision: 1 },
    });
    return { collectionId };
  },
});

export const addManualPiece = mutation({
  args: {
    collectionId: v.id("contentCollections"),
    sourceMaterialIds: v.array(v.id("contentSourceMaterials")),
    channel: channelValidator,
    caption: v.string(),
    hashtags: v.array(v.string()),
    script: v.optional(v.string()),
    productId: v.optional(v.id("products")),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const collection = await ownedCollection(ctx, actor._id, args.collectionId);
    if (collection.status !== "DRAFT") fail("CONFLICT", "초안 컬렉션에만 콘텐츠를 추가할 수 있습니다.");
    await requireNoPendingRuns(ctx, collection._id);
    if (collection.pieceIds.length >= MAX_COLLECTION_PIECES)
      fail("CONFLICT", `컬렉션에는 콘텐츠를 최대 ${MAX_COLLECTION_PIECES}개까지 추가할 수 있습니다.`);
    if (!args.caption.trim()) fail("INVALID_ARGUMENT", "본문을 입력하세요.");
    const selectedIds = [...new Set(args.sourceMaterialIds)];
    if (selectedIds.length === 0) fail("INVALID_ARGUMENT", "콘텐츠 근거 자료를 하나 이상 선택하세요.");
    if (selectedIds.some((id) => !collection.sourceMaterialIds.includes(id)))
      fail("INVALID_ARGUMENT", "컬렉션에 연결되지 않은 자료가 포함되어 있습니다.");
    const materials = await requireReadyCollectionMaterials(ctx, actor._id, selectedIds);
    const boundProductIds = [...new Set(materials.flatMap((material) => material.productId ? [material.productId] : []))];
    if (boundProductIds.length > 1) fail("CONFLICT", "서로 다른 상품에 연결된 자료를 한 콘텐츠에 함께 사용할 수 없습니다.");
    const resolvedProductId = args.productId ?? boundProductIds[0];
    if (args.productId && boundProductIds[0] && args.productId !== boundProductIds[0])
      fail("CONFLICT", "선택한 자료의 상품과 콘텐츠 상품이 일치하지 않습니다.");
    let product: Doc<"products"> | null = null;
    if (resolvedProductId) {
      product = await ctx.db.get(resolvedProductId);
      if (!product || product.status !== "ACTIVE") fail("CONFLICT", "판매 중인 상품만 연결할 수 있습니다.");
    }
    const mediaUrls = materials.flatMap((material) => {
      if (material.rightsStatus === "LINK_ONLY") return [];
      if (isMediaMaterial(material)) return [materialDeliveryUrl(material)!];
      return [];
    });
    const maxMedia = contentMediaMax(args.channel as Channel);
    if (mediaUrls.length > maxMedia) fail("INVALID_ARGUMENT", `이 채널의 콘텐츠 미디어는 최대 ${maxMedia}개까지 사용할 수 있습니다.`);
    const products: ProductBrief[] = product ? [{
      attrangsProductId: product.attrangsProductId,
      name: product.name,
      price: product.price,
      salePrice: product.salePrice ?? null,
      category: product.category ?? null,
    }] : [];
    const report = evaluatePiece({
      channel: args.channel as Channel,
      caption: args.caption,
      hashtags: args.hashtags,
      script: args.script ?? null,
    }, { linkExpected: !!product, products });
    const mediaPassed = validateContentMedia(args.channel as Channel, mediaUrls) === null;
    const candidate = {
      channel: args.channel,
      caption: report.caption,
      hashtags: report.hashtags,
      script: args.script,
      mediaUrls,
    };
    const outputHash = await manualContentOutputHash(candidate);
    const now = Date.now();
    const pieceId = await ctx.db.insert("contentPieces", {
      ownerUserId: actor._id,
      visibility: "PRIVATE",
      collectionId: collection._id,
      sourceMaterialIds: selectedIds,
      productId: resolvedProductId,
      channel: args.channel,
      caption: report.caption,
      hashtags: report.hashtags,
      script: args.script,
      mediaUrls,
      qualityScore: report.score,
      qualityReport: { violations: report.violations, fixed: report.fixed },
      status: "DRAFT",
      generatedBy: "manual",
      productionMeta: {
        provider: "manual",
        outputHash,
        standardPassed: isAutoApprovable(report) && mediaPassed,
        evaluatedAt: now,
        collectionId: collection._id,
        sourceMaterialIds: selectedIds,
        humanApprovedAt: null,
        approvedByUserId: null,
        reviewChecklist: null,
      },
      usageCount: 0,
      createdAt: now,
    });
    await ctx.db.patch(collection._id, { pieceIds: [...collection.pieceIds, pieceId], updatedAt: now });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "adminContent.pieceCreate",
      metadata: { collectionId: collection._id, pieceId, sourceMaterialIds: selectedIds, outputHash },
    });
    return { pieceId, qualityScore: report.score, violations: report.violations, mediaUrls, outputHash };
  },
});

/** Discards an unusable draft (including non-Codex fallback output) without trapping the collection. */
export const removePiece = mutation({
  args: { collectionId: v.id("contentCollections"), pieceId: v.id("contentPieces") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const collection = await ownedCollection(ctx, actor._id, args.collectionId);
    if (collection.status !== "DRAFT") fail("CONFLICT", "초안 컬렉션의 콘텐츠만 제거할 수 있습니다.");
    if (!collection.pieceIds.includes(args.pieceId)) fail("NOT_FOUND", "컬렉션 콘텐츠를 찾을 수 없습니다.");
    const piece = await ctx.db.get(args.pieceId);
    if (!piece || piece.collectionId !== collection._id) fail("NOT_FOUND", "컬렉션 콘텐츠를 찾을 수 없습니다.");
    if (piece.visibility === "SHARED") fail("CONFLICT", "공개 중인 콘텐츠는 컬렉션 공개를 먼저 종료하세요.");
    const now = Date.now();
    await ctx.db.patch(piece._id, {
      status: "RETIRED",
      visibility: "PRIVATE",
      collectionId: undefined,
      productionMeta: {
        ...(piece.productionMeta as Record<string, unknown> | undefined),
        removedFromCollectionId: collection._id,
        removedFromCollectionAt: now,
        removedFromCollectionBy: actor._id,
      },
    });
    await ctx.db.patch(collection._id, {
      pieceIds: collection.pieceIds.filter((pieceId) => pieceId !== piece._id),
      updatedAt: now,
    });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "adminContent.pieceRemove",
      metadata: { collectionId: collection._id, pieceId: piece._id, runId: piece.runId ?? null },
    });
  },
});

async function collectionRuns(ctx: QueryCtx | MutationCtx, collectionId: Id<"contentCollections">) {
  const runs = await ctx.db.query("contentRuns").withIndex("by_collection", (q) => q.eq("collectionId", collectionId)).order("desc").collect();
  return await Promise.all(runs.map(async (run) => {
    const jobs = await Promise.all(run.jobIds.map((id) => ctx.db.get(id)));
    return { _id: run._id, channels: run.channels, createdAt: run.createdAt, quarantineReason: run.quarantineReason ?? null,
      status: run.quarantineReason ? "QUARANTINED" : jobs.some((job) => job && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) ? "PENDING" : run.status === "FAILED" || jobs.some((job) => job?.status !== "SUCCEEDED") ? "FAILED" : "REVIEW_REQUIRED",
      jobIds: run.jobIds };
  }));
}

async function requireNoPendingRuns(ctx: MutationCtx, collectionId: Id<"contentCollections">) {
  if ((await collectionRuns(ctx, collectionId)).some((run) => run.status === "PENDING"))
    fail("CONFLICT", "AI 생성이 진행 중입니다. 모든 결과가 도착한 뒤 검토·공개하세요.");
}

export const requestGenerate = mutation({
  args: { collectionId: v.id("contentCollections"), sourceMaterialIds: v.array(v.id("contentSourceMaterials")),
    productId: v.optional(v.id("products")), channels: v.array(channelValidator), brief: v.any(), clientRequestId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.clientRequestId)) fail("INVALID_ARGUMENT", "생성 요청 식별자가 올바르지 않습니다.");
    const channels = [...new Set(args.channels)];
    const brief = normalizeContentBrief(args.brief);
    const batchKey = `admin-content:${actor._id}:${args.clientRequestId}`;
    const existing = await ctx.db.query("contentRuns").withIndex("by_batchKey", (q) => q.eq("batchKey", batchKey)).unique();
    if (existing) {
      const snapshot = existing.adminMaterialSnapshot as AdminMaterialSnapshot;
      if (existing.collectionId !== args.collectionId || canonicalJson(existing.channels) !== canonicalJson(channels)
        || canonicalJson(existing.briefSnapshot) !== canonicalJson(brief)
        || canonicalJson(snapshot.sourceMaterialIds) !== canonicalJson(args.sourceMaterialIds)
        || (snapshot.requestedProductId ?? null) !== (args.productId ?? null)) fail("CONFLICT", "IDEMPOTENCY_CONFLICT");
      return { runId: existing._id, jobIds: existing.jobIds };
    }
    const collection = await ownedCollection(ctx, actor._id, args.collectionId);
    if (collection.status !== "DRAFT") fail("CONFLICT", "초안 컬렉션에서만 AI 생성을 요청할 수 있습니다.");
    await requireNoPendingRuns(ctx, collection._id);
    if (channels.length === 0) fail("INVALID_ARGUMENT", "채널을 하나 이상 선택하세요.");
    if (collection.pieceIds.length + channels.length > MAX_COLLECTION_PIECES)
      fail("CONFLICT", `컬렉션에는 콘텐츠를 최대 ${MAX_COLLECTION_PIECES}개까지 추가할 수 있습니다.`);
    if (args.sourceMaterialIds.length > MAX_AI_MATERIALS)
      fail("INVALID_ARGUMENT", `AI 생성에는 운영 자료를 최대 ${MAX_AI_MATERIALS}개까지 사용할 수 있습니다.`);
    if (args.sourceMaterialIds.some((id) => !collection.sourceMaterialIds.includes(id))) fail("INVALID_ARGUMENT", "컬렉션에 포함된 자료를 선택하세요.");
    const materials = await requireReadyCollectionMaterials(ctx, actor._id, args.sourceMaterialIds);
    const boundProductIds = [...new Set(materials.flatMap((material) => material.productId ? [material.productId] : []))];
    if (boundProductIds.length > 1 || (args.productId && boundProductIds.length && args.productId !== boundProductIds[0]))
      fail("CONFLICT", "선택 자료의 상품과 생성할 상품이 일치해야 합니다.");
    const productId = args.productId ?? boundProductIds[0];
    if (productId && (await ctx.db.get(productId))?.status !== "ACTIVE") fail("CONFLICT", "판매 중인 상품을 선택하세요.");
    if (!productId && !materials.some((material) => material.kind === "TEXT" && material.rightsStatus !== "LINK_ONLY" && !!material.bodyText?.trim()))
      fail("CONFLICT", "AI 생성에는 판매 상품 또는 내용이 입력된 텍스트 자료가 필요합니다. 링크·미디어 주소만으로는 사실을 추론하지 않습니다.");
    const snapshot: AdminMaterialSnapshot = {
      collectionId: collection._id, revision: collection.revision, sourceMaterialIds: args.sourceMaterialIds,
      requestedProductId: args.productId ?? null,
      sourceMaterials: materials.map((material) => ({ id: material._id, revision: material.updatedAt, title: material.title,
        kind: material.kind, text: material.rightsStatus === "LINK_ONLY" ? "" : (material.bodyText ?? "").slice(0, MAX_AI_SNAPSHOT_TEXT), sourceUrl: material.externalUrl ?? null, rightsNote: material.rightsNote })),
      materialMediaUrls: materials.flatMap((material) => material.rightsStatus !== "LINK_ONLY" && isMediaMaterial(material) ? [materialDeliveryUrl(material)!] : []),
    };
    const jobId = await requestGenerateFor(ctx, actor, { productId, channels, brief, adminMaterialSnapshot: snapshot, batchKey });
    const run = await ctx.db.query("contentRuns").withIndex("by_batchKey", (q) => q.eq("batchKey", batchKey)).unique();
    return { runId: run!._id, jobIds: [jobId] };
  },
});

export const submitCollection = mutation({
  args: { collectionId: v.id("contentCollections") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const collection = await ownedCollection(ctx, actor._id, args.collectionId);
    if (collection.status !== "DRAFT") fail("CONFLICT", "초안 컬렉션만 검수 요청할 수 있습니다.");
    await requireNoPendingRuns(ctx, collection._id);
    await requireReadyCollectionMaterials(ctx, actor._id, collection.sourceMaterialIds);
    if (collection.pieceIds.length === 0) fail("CONFLICT", "검수할 콘텐츠를 하나 이상 추가하세요.");
    for (const pieceId of collection.pieceIds) {
      const piece = await ctx.db.get(pieceId);
      if (!piece || piece.collectionId !== collection._id)
        fail("CONFLICT", "컬렉션의 콘텐츠 소유권을 확인할 수 없습니다.");
    }
    const now = Date.now();
    await ctx.db.patch(collection._id, { status: "IN_REVIEW", submittedAt: now, updatedAt: now });
    await audit(ctx, { actorUserId: actor._id, action: "adminContent.collectionSubmit", metadata: { collectionId: collection._id, revision: collection.revision } });
  },
});

export const reopenCollection = mutation({
  args: { collectionId: v.id("contentCollections") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const collection = await ownedCollection(ctx, actor._id, args.collectionId);
    if (collection.status === "DRAFT") fail("CONFLICT", "이미 초안 상태입니다.");
    await reopenCollectionInternal(ctx, actor._id, collection, "operator.request");
  },
});

export const publishCollection = mutation({
  args: { collectionId: v.id("contentCollections") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const collection = await ownedCollection(ctx, actor._id, args.collectionId);
    if (collection.status !== "IN_REVIEW") fail("CONFLICT", "검수 중인 컬렉션만 공개할 수 있습니다.");
    await requireNoPendingRuns(ctx, collection._id);
    const collectionMaterials = await requireReadyCollectionMaterials(ctx, actor._id, collection.sourceMaterialIds);
    const materialById = new Map(collectionMaterials.map((material) => [material._id, material]));
    if (collection.pieceIds.length === 0) fail("CONFLICT", "공개할 콘텐츠가 없습니다.");
    const pieces: Doc<"contentPieces">[] = [];
    const transferredPieceIds: Id<"contentPieces">[] = [];
    const reviewerIds = new Set<Id<"users">>();
    let reviewedAt = 0;
    for (const pieceId of collection.pieceIds) {
      const piece = await ctx.db.get(pieceId);
      if (!piece || piece.collectionId !== collection._id)
        fail("CONFLICT", "운영 컬렉션 콘텐츠를 확인할 수 없습니다.");
      if (piece.status !== "APPROVED") fail("CONFLICT", "모든 콘텐츠를 검토·승인한 뒤 공개하세요.");
      const sourceMaterialIds = piece.sourceMaterialIds ?? [];
      if (sourceMaterialIds.length === 0 || sourceMaterialIds.some((id) => !materialById.has(id)))
        fail("CONFLICT", "콘텐츠 근거 자료가 컬렉션과 일치하지 않습니다.");
      const boundProductIds = [...new Set(sourceMaterialIds.flatMap((id) => {
        const productId = materialById.get(id)?.productId;
        return productId ? [productId] : [];
      }))];
      if (boundProductIds.length > 1 || (boundProductIds.length === 1 && piece.productId !== boundProductIds[0]))
        fail("CONFLICT", "콘텐츠 상품과 근거 자료의 상품이 일치하지 않습니다.");
      if (piece.productId) {
        const product = await ctx.db.get(piece.productId);
        if (!product || product.status !== "ACTIVE") fail("CONFLICT", "판매 중이 아닌 상품의 콘텐츠는 공개할 수 없습니다.");
      }
      const allowedMedia = new Set(sourceMaterialIds.flatMap((id) => {
        const material = materialById.get(id)!;
        if (material.rightsStatus === "LINK_ONLY") return [];
        if (isMediaMaterial(material)) return [materialDeliveryUrl(material)!];
        return [];
      }));
      if (piece.mediaUrls.some((url) => !allowedMedia.has(url)))
        fail("CONFLICT", "권리 검수된 운영 자료가 아닌 미디어가 콘텐츠에 포함되어 있습니다.");
      const review = await libraryReviewEvidence(ctx, piece);
      if (!review.ok) fail("CONFLICT", review.reason);
      const reviewMeta = piece.productionMeta as { approvedByUserId?: unknown; humanApprovedAt?: unknown } | undefined;
      if (typeof reviewMeta?.approvedByUserId !== "string" || typeof reviewMeta.humanApprovedAt !== "number")
        fail("CONFLICT", "컬렉션 검수자를 확인할 수 없습니다.");
      reviewerIds.add(reviewMeta.approvedByUserId as Id<"users">);
      reviewedAt = Math.max(reviewedAt, reviewMeta.humanApprovedAt);
      if (piece.ownerUserId !== actor._id) transferredPieceIds.push(piece._id);
      pieces.push(piece);
    }
    const reviewerIdList = [...reviewerIds];
    for (const reviewerId of reviewerIdList) {
      const reviewer = await ctx.db.get(reviewerId);
      if (!reviewer || !isActiveSuperAdmin(reviewer))
        fail("CONFLICT", "현재 활성 수퍼어드민의 검수 승인만 공개에 사용할 수 있습니다.");
    }
    const reviewerId = reviewerIdList[0]!;
    const now = Date.now();
    for (const piece of pieces) {
      await ctx.db.patch(piece._id, {
        ownerUserId: actor._id,
        visibility: "SHARED",
        libraryPublishedAt: now,
        libraryPublishedBy: actor._id,
        libraryWithdrawnAt: undefined,
      });
    }
    await ctx.db.patch(collection._id, {
      status: "PUBLISHED",
      reviewedBy: reviewerId,
      reviewedByIds: reviewerIdList,
      reviewedAt,
      publishedBy: actor._id,
      publishedAt: now,
      withdrawnBy: undefined,
      withdrawnAt: undefined,
      updatedAt: now,
    });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "adminContent.collectionPublish",
      metadata: { collectionId: collection._id, revision: collection.revision, reviewerId, reviewerIds: reviewerIdList, publisherId: actor._id, pieceIds: pieces.map((piece) => piece._id), transferredPieceIds },
    });
  },
});

export const withdrawCollection = mutation({
  args: { collectionId: v.id("contentCollections") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const collection = await ownedCollection(ctx, actor._id, args.collectionId);
    if (collection.status !== "PUBLISHED") fail("CONFLICT", "공개 중인 컬렉션만 철회할 수 있습니다.");
    const now = Date.now();
    for (const pieceId of collection.pieceIds) {
      const piece = await ctx.db.get(pieceId);
      if (piece?.collectionId === collection._id)
        await ctx.db.patch(piece._id, { visibility: "PRIVATE", libraryWithdrawnAt: now });
    }
    await ctx.db.patch(collection._id, {
      status: "WITHDRAWN",
      withdrawnBy: actor._id,
      withdrawnAt: now,
      updatedAt: now,
    });
    await audit(ctx, { actorUserId: actor._id, action: "adminContent.collectionWithdraw", metadata: { collectionId: collection._id, revision: collection.revision } });
  },
});

async function collectionView(ctx: QueryCtx, collection: Doc<"contentCollections">) {
  let approvedPieceCount = 0;
  for (const pieceId of collection.pieceIds) {
    if ((await ctx.db.get(pieceId))?.status === "APPROVED") approvedPieceCount++;
  }
  return {
    ...collection,
    materialCount: collection.sourceMaterialIds.length,
    pieceCount: collection.pieceIds.length,
    approvedPieceCount,
  };
}

export const listCollections = query({
  args: { status: v.optional(collectionStatusValidator), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 300);
    const rows = args.status
      ? await ctx.db.query("contentCollections").withIndex("by_status", (q) => q.eq("status", args.status!)).order("desc").take(limit)
      : await ctx.db.query("contentCollections").order("desc").take(limit);
    return await Promise.all(rows.map((row) => collectionView(ctx, row)));
  },
});

export const getCollection = query({
  args: { collectionId: v.id("contentCollections") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const collection = await ownedCollection(ctx, actor._id, args.collectionId);
    const materials = [];
    for (const id of collection.sourceMaterialIds) {
      const material = await ctx.db.get(id);
      if (material) materials.push({
        ...material,
        deliveryUrl: materialDeliveryUrl(material),
        previewUrl: await materialAdminPreviewUrl(ctx, material),
      });
    }
    const rows = [];
    for (const id of collection.pieceIds) {
      const piece = await ctx.db.get(id);
      if (piece?.collectionId === collection._id) rows.push(piece);
    }
    return {
      ...(await collectionView(ctx, collection)),
      materials,
      runs: await collectionRuns(ctx, collection._id),
      pieces: await decorate(ctx, rows.sort((a, b) => b.createdAt - a.createdAt), actor._id),
    };
  },
});

export const summary = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const materials = await ctx.db.query("contentSourceMaterials").collect();
    const collections = await ctx.db.query("contentCollections").collect();
    const pieceIds = new Set(collections.flatMap((collection) => collection.pieceIds));
    let approved = 0;
    let shared = 0;
    for (const id of pieceIds) {
      const piece = await ctx.db.get(id);
      if (piece?.status === "APPROVED") approved++;
      if (piece?.visibility === "SHARED") shared++;
    }
    return {
      materials: {
        total: materials.length,
        draft: materials.filter((row) => row.status === "DRAFT").length,
        ready: materials.filter((row) => row.status === "READY").length,
        archived: materials.filter((row) => row.status === "ARCHIVED").length,
      },
      collections: {
        total: collections.length,
        draft: collections.filter((row) => row.status === "DRAFT").length,
        inReview: collections.filter((row) => row.status === "IN_REVIEW").length,
        published: collections.filter((row) => row.status === "PUBLISHED").length,
        withdrawn: collections.filter((row) => row.status === "WITHDRAWN").length,
      },
      pieces: { total: pieceIds.size, approved, shared },
    };
  },
});

/** Public HTTP action lookup. String input lets malformed IDs fail closed instead of validator-throwing. */
export const publicMaterial = internalQuery({
  args: { materialId: v.string(), fileName: v.string() },
  handler: async (ctx, args) => {
    if (!SAFE_FILE_NAME.test(args.fileName)) return null;
    const materialId = ctx.db.normalizeId("contentSourceMaterials", args.materialId);
    if (!materialId) return null;
    const material = await ctx.db.get(materialId);
    if (
      !material
      || material.kind !== "FILE"
      || !material.storageId
      || material.rightsStatus === "LINK_ONLY"
      || material.fileName !== args.fileName
      || !material.mimeType
      || !(material.mimeType in CONTENT_FILE_POLICY)
      || !CONTENT_FILE_POLICY[material.mimeType as AllowedMime].media
      || material.sizeBytes === undefined
      || material.sizeBytes <= 0
      || material.sizeBytes > CONTENT_FILE_POLICY[material.mimeType as AllowedMime].maxBytes
      || !material.contentHash
      || !HASH_RE.test(material.contentHash)
      || !(material.status === "READY" || (material.status === "ARCHIVED" && typeof material.readyAt === "number"))
    ) return null;
    return {
      storageId: material.storageId,
      mimeType: material.mimeType,
      contentHash: material.contentHash,
      fileName: material.fileName,
    };
  },
});
