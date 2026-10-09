import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "./crypto";

type Ctx = QueryCtx | MutationCtx;
export type MediaIntegrity = { url: string; sha256: string; sizeBytes: number; mimeType: string };
export const MEDIA_TYPES: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"], "image/gif": ["gif"],
  "video/mp4": ["mp4"], "video/quicktime": ["mov"], "video/webm": ["webm"],
};
export function normalizeMediaHash(value: string): string | null {
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    return bytes.length === 32 ? [...bytes].map(b => b.toString(16).padStart(2, "0")).join("") : null;
  } catch { return null; }
}
export function mediaAssetUrl(asset: Pick<Doc<"contentMediaAssets">, "_id" | "contentHash" | "extension">): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site || new URL(site).protocol !== "https:") throw new Error("미디어 공개 저장 주소가 설정되지 않았습니다.");
  return `${new URL(site).origin}/media-assets/${asset._id}/${asset.contentHash}.${asset.extension}`;
}
export async function storageMatches(ctx: Ctx, value: { storageId: Id<"_storage">; contentHash: string; mimeType: string; sizeBytes: number }): Promise<boolean> {
  const metadata = await ctx.db.system.get(value.storageId);
  const max = value.mimeType.startsWith("image/") ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
  return !!metadata && !!MEDIA_TYPES[value.mimeType] && value.sizeBytes > 0 && value.sizeBytes <= max &&
    metadata.size === value.sizeBytes && normalizeMediaHash(metadata.sha256) === value.contentHash &&
    (metadata.contentType === value.mimeType || (process.env.NODE_ENV === "test" && process.env.AUTOMONEY_TEST_ALLOW_DECLARED_STORAGE_MIME === "true" && !metadata.contentType));
}
async function resolveOne(ctx: Ctx, raw: string): Promise<{ manifest: MediaIntegrity; sourceUrl: string } | null> {
  let url: URL;
  try {
    url = new URL(raw);
    if (!process.env.CONVEX_SITE_URL || url.origin !== new URL(process.env.CONVEX_SITE_URL).origin || url.protocol !== "https:" || url.search || url.hash || url.username || url.password) return null;
  } catch { return null; }
  const parts = url.pathname.split("/");
  if (parts.length !== 4 || !parts[2] || !parts[3]) return null;
  let fileName: string;
  try { fileName = decodeURIComponent(parts[3]); } catch { return null; }
  if (parts[1] === "media-assets") {
    const id = ctx.db.normalizeId("contentMediaAssets", parts[2]);
    const asset = id ? await ctx.db.get(id) : null;
    if (!asset || asset.status !== "READY" || !asset.rightsNote || fileName !== `${asset.contentHash}.${asset.extension}` || !MEDIA_TYPES[asset.mimeType]?.includes(asset.extension) || raw !== mediaAssetUrl(asset) || !await storageMatches(ctx, asset)) return null;
    return { manifest: { url: raw, sha256: asset.contentHash, sizeBytes: asset.sizeBytes, mimeType: asset.mimeType }, sourceUrl: asset.sourceUrl };
  }
  if (parts[1] === "content-assets") {
    const id = ctx.db.normalizeId("contentSourceMaterials", parts[2]);
    const material = id ? await ctx.db.get(id) : null;
    if (!material || material.kind !== "FILE" || !material.readyAt || (material.status !== "READY" && material.status !== "ARCHIVED") || material.rightsStatus === "LINK_ONLY" || !material.rightsNote || material.fileName !== fileName || !material.storageId || !material.mimeType || !material.contentHash || !material.sizeBytes) return null;
    if (raw !== `${url.origin}/content-assets/${id}/${encodeURIComponent(fileName)}` || !MEDIA_TYPES[material.mimeType]?.includes(fileName.split(".").at(-1)?.toLowerCase() ?? "")) return null;
    if (!await storageMatches(ctx, { storageId: material.storageId, mimeType: material.mimeType, contentHash: material.contentHash, sizeBytes: material.sizeBytes })) return null;
    return { manifest: { url: raw, sha256: material.contentHash, sizeBytes: material.sizeBytes, mimeType: material.mimeType }, sourceUrl: raw };
  }
  return null;
}
export async function resolveMediaIntegrity(ctx: Ctx, urls: string[]): Promise<{ ok: true; manifest: MediaIntegrity[] } | { ok: false; reason: string }> {
  if (urls.length > 30) return { ok: false, reason: "미디어는 최대 30개까지 준비할 수 있습니다." };
  const manifest: MediaIntegrity[] = [];
  for (const url of urls) {
    const asset = await resolveOne(ctx, url);
    if (!asset) return { ok: false, reason: "승인 전에 미디어 고정을 완료하세요. 파일이 없거나 변경된 경우 다시 준비해야 합니다." };
    manifest.push(asset.manifest);
  }
  return { ok: true, manifest };
}
export async function mediaRevisionHash(piece: Doc<"contentPieces">): Promise<string> {
  const { mediaFreezeId: _freeze, usageCount: _usage, ...content } = piece;
  void _freeze; void _usage;
  return sha256Hex(JSON.stringify(content));
}
export async function mediaPreparationView(ctx: Ctx, piece: Doc<"contentPieces">) {
  const result = await resolveMediaIntegrity(ctx, piece.mediaUrls);
  const freeze = piece.mediaFreezeId ? await ctx.db.get(piece.mediaFreezeId) : null;
  return {
    mediaIntegrity: result.ok ? { ready: true as const, manifest: result.manifest } : { ready: false as const, reason: result.reason },
    mediaRevisionHash: await mediaRevisionHash(piece),
    mediaFreeze: freeze ? { id: freeze._id, status: (freeze.status === "PENDING" || freeze.status === "RUNNING") && freeze.expiresAt <= Date.now() ? "FAILED" : freeze.status, error: freeze.error ?? (freeze.expiresAt <= Date.now() && !freeze.finishedAt ? "저장 시간이 초과되었습니다. 다시 준비하세요." : undefined), completedCount: freeze.completedCount, totalCount: freeze.sourceUrls.length, expiresAt: freeze.expiresAt } : null,
  };
}
export async function mediaMatchesSources(ctx: Ctx, urls: string[], allowedUrls: ReadonlySet<string>): Promise<boolean> {
  for (const url of urls) {
    if (allowedUrls.has(url)) continue;
    const asset = await resolveOne(ctx, url);
    if (!asset || !allowedUrls.has(asset.sourceUrl)) return false;
  }
  return true;
}
