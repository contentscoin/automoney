import type { Channel } from "@automoney/shared";
import { api } from "../convex/_generated/api";
import { normalizeMediaHash } from "../convex/lib/mediaIntegrity";
import { type T, signup } from "./helpers";

export const MEDIA_REVIEW_CHECKLIST = { productFacts: true, adDisclosure: true, mediaRightsAndFit: true, finalCopy: true } as const;
export const MEDIA_CAPTION = "가을 스타일링으로 완성하는 데일리 코디가 궁금하다면? 소재와 핏 정보는 상품 링크에서 자세히 확인해 보세요.";

/** A real stored blob plus previously rights-reviewed operator source material. */
export async function seedReadyMedia(t: T, owner: Awaited<ReturnType<typeof signup>>) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }));
    const metadata = (await ctx.db.system.get(storageId))!;
    const contentHash = normalizeMediaHash(metadata.sha256)!;
    const materialId = await ctx.db.insert("contentSourceMaterials", {
      kind: "FILE", title: "권리 검수 이미지", storageId, fileName: "reviewed.png", mimeType: "image/png",
      sizeBytes: metadata.size, contentHash, rightsStatus: "OWNED", rightsNote: "자체 제작 이미지",
      status: "READY", createdBy: owner.userId, createdAt: Date.now(), updatedAt: Date.now(), readyAt: Date.now(),
    });
    const url = `${process.env.CONVEX_SITE_URL}/content-assets/${materialId}/reviewed.png`;
    return { storageId, materialId, url, manifest: [{ url, sha256: contentHash, sizeBytes: metadata.size, mimeType: "image/png" }] };
  });
}

export async function createReviewedMediaPiece(t: T, user: Awaited<ReturnType<typeof signup>>, options: { channel?: Channel; caption?: string } = {}) {
  const media = await seedReadyMedia(t, user);
  const created = await user.as.mutation(api.content.createManual, {
    channel: options.channel ?? "THREADS", caption: options.caption ?? MEDIA_CAPTION,
    hashtags: ["광고", "데일리룩", "가을코디"], mediaUrls: [media.url],
  });
  const piece = await user.as.query(api.content.getPiece, { pieceId: created.pieceId });
  await user.as.mutation(api.content.approve, { pieceId: created.pieceId, expectedOutputHash: piece.productionMeta.outputHash, reviewChecklist: MEDIA_REVIEW_CHECKLIST });
  return { ...created, ...media, piece: await user.as.query(api.content.getPiece, { pieceId: created.pieceId }) };
}
