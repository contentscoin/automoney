import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { api, internal } from "../convex/_generated/api";
import { mediaRevisionHash, resolveMediaIntegrity, mediaMatchesSources } from "../convex/lib/mediaIntegrity";
import { makeT, signup } from "./helpers";

const remote = "https://images.example.com/photo.png";
const caption = "가을 데일리 코디를 위한 원피스 스타일을 소개합니다. 소재와 핏 정보를 확인하고 다음 코디에 활용해 보세요.";
const checklist = { productFacts: true, adDisclosure: true, mediaRightsAndFit: true, finalCopy: true };
async function fixture(urls = [remote]) {
  const t = makeT();
  const owner = await signup(t, "owner@automoney.test");
  const other = await signup(t, "reader@automoney.test");
  const { pieceId } = await owner.as.mutation(api.content.createManual, { channel: "THREADS", caption, hashtags: ["광고", "데일리룩"], mediaUrls: urls });
  const piece = await t.run(ctx => ctx.db.get(pieceId));
  const args = { pieceId, expectedMediaRevisionHash: await mediaRevisionHash(piece!), rightsConfirmed: true, rightsNote: "운영사가 직접 촬영한 파일, 공개 배포 허용" };
  return { t, owner, other, pieceId, args };
}
async function file(t: ReturnType<typeof makeT>, content = "fixed content") {
  const bytes = new TextEncoder().encode(content);
  const storageId = await t.run(ctx => ctx.storage.store(new Blob([bytes], { type: "image/png" })));
  return { storageId, mimeType: "image/png", extension: "png", sizeBytes: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("immutable media preparation lifecycle", () => {
  it("keeps media drafts unapproved and requires rights plus current revision", async () => {
    const { t, owner, other, pieceId, args } = await fixture();
    expect(await t.run(ctx => ctx.db.get(pieceId))).toMatchObject({ status: "DRAFT" });
    await expect(other.as.mutation(api.media.requestFreeze, args)).rejects.toThrow(/권한/);
    await expect(owner.as.mutation(api.media.requestFreeze, { ...args, rightsConfirmed: false })).rejects.toThrow(/권한/);
    await expect(owner.as.mutation(api.media.requestFreeze, { ...args, rightsNote: " " })).rejects.toThrow(/근거/);
    await expect(owner.as.mutation(api.media.requestFreeze, { ...args, expectedMediaRevisionHash: "stale" })).rejects.toThrow(/변경/);
    await expect(owner.as.mutation(api.content.approve, { pieceId, reviewChecklist: checklist })).rejects.toThrow(/미디어/);
    await t.run(ctx => ctx.db.patch(owner.userId, { status: "PENDING" }));
    await expect(owner.as.mutation(api.media.requestFreeze, args)).rejects.toThrow(/권한/);
  });

  it("deduplicates a pending request and commits frozen URLs atomically in source order", async () => {
    const { t, owner, pieceId, args } = await fixture([remote, remote]);
    const request = await owner.as.mutation(api.media.requestFreeze, args);
    expect(await owner.as.mutation(api.media.requestFreeze, args)).toEqual(request);
    expect(await t.query(internal.media.nextFile, request)).toMatchObject({ index: 0, sourceUrl: remote, reusable: false });
    await t.mutation(internal.media.appendFile, { ...request, index: 0, file: await file(t) });
    const staged = await t.run(ctx => ctx.db.query("contentMediaAssets").collect());
    expect(staged).toHaveLength(1);
    expect(await t.query(internal.media.publicAsset, { assetId: staged[0]!._id, fileName: `${staged[0]!.contentHash}.png` })).toBeNull();
    expect(await t.run(ctx => ctx.db.get(pieceId))).toMatchObject({ mediaUrls: [remote, remote] });
    expect(await t.mutation(internal.media.appendFile, { ...request, index: 0, file: await file(t) })).toBe(false);
    await t.mutation(internal.media.appendFile, { ...request, index: 1, file: await file(t, "second content") });
    const result = await owner.as.query(api.content.getPiece, { pieceId });
    expect(result).toMatchObject({ status: "DRAFT", mediaIntegrity: { ready: true }, mediaFreeze: { status: "SUCCEEDED", completedCount: 2 } });
    expect(result.mediaUrls.every(url => url.startsWith("https://convex.automoney.test/media-assets/"))).toBe(true);
    const integrity = await t.run(ctx => resolveMediaIntegrity(ctx, result.mediaUrls));
    expect(integrity.ok).toBe(true);
    if (!integrity.ok) throw new Error("expected ready manifest");
    expect(integrity.manifest.map(item => item.sha256)).toEqual([createHash("sha256").update("fixed content").digest("hex"), createHash("sha256").update("second content").digest("hex")]);
    expect(await t.run(ctx => mediaMatchesSources(ctx, result.mediaUrls, new Set([remote])))).toBe(true);
    expect(await t.run(ctx => mediaMatchesSources(ctx, result.mediaUrls, new Set(["https://example.org/other.png"])))).toBe(false);
    await owner.as.mutation(api.content.approve, { pieceId, expectedOutputHash: result.productionMeta!.outputHash, reviewChecklist: checklist });
    const reviewed = await t.run(ctx => ctx.db.get(pieceId));
    expect(reviewed?.productionMeta.mediaIntegrity).toEqual(integrity.manifest);
    expect(reviewed?.status).toBe("APPROVED");
  });

  it("serves only exact READY asset names with immutable caching and byte identity", async () => {
    const { t, owner, pieceId, args } = await fixture();
    const request = await owner.as.mutation(api.media.requestFreeze, args);
    const snapshot = await file(t);
    await t.mutation(internal.media.appendFile, { ...request, index: 0, file: snapshot });
    const piece = await t.run(ctx => ctx.db.get(pieceId));
    const path = new URL(piece!.mediaUrls[0]!).pathname;
    const response = await t.fetch(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fixed content");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe(`"${snapshot.contentHash}"`);
    expect((await t.fetch(path, { headers: { "if-none-match": `"${snapshot.contentHash}"` } })).status).toBe(304);
    expect((await t.fetch(path.replace(".png", ".gif"))).status).toBe(404);
    expect((await t.fetch("/media-assets/not-an-id/test.png")).status).toBe(404);
    for (const invalid of [piece!.mediaUrls[0]! + "?change=1", piece!.mediaUrls[0]!.replace("convex.automoney.test", "evil.example"), remote]) {
      expect((await t.run(ctx => resolveMediaIntegrity(ctx, [invalid]))).ok).toBe(false);
    }
    await t.run(ctx => ctx.storage.delete(snapshot.storageId));
    expect((await t.fetch(path)).status).toBe(404);
    expect((await t.run(ctx => resolveMediaIntegrity(ctx, piece!.mediaUrls))).ok).toBe(false);
  });

  it("never overwrites concurrent edits and cleans only expired staged files", async () => {
    const { t, owner, pieceId, args } = await fixture([remote, remote]);
    const request = await owner.as.mutation(api.media.requestFreeze, args);
    const first = await file(t);
    await t.mutation(internal.media.appendFile, { ...request, index: 0, file: first });
    await owner.as.mutation(api.content.edit, { pieceId, caption: `${caption} 새로운 설명입니다.`, hashtags: ["광고"], mediaUrls: [remote] });
    await expect(t.mutation(internal.media.appendFile, { ...request, index: 1, file: await file(t) })).rejects.toThrow(/변경/);
    expect((await t.run(ctx => ctx.db.get(pieceId)))?.caption).toContain("새로운 설명");
    await t.mutation(internal.media.recordFailure, { ...request, error: "콘텐츠가 변경되었습니다." });
    await t.run(async ctx => {
      const staged = await ctx.db.query("contentMediaAssets").collect();
      for (const asset of staged) await ctx.db.patch(asset._id, { expiresAt: Date.now() - 1 });
    });
    expect(await t.mutation(internal.media.sweep, {})).toEqual({ removedStagedAssets: 1 });
    expect(await t.run(ctx => ctx.storage.get(first.storageId))).toBeNull();
    expect((await owner.as.query(api.content.getPiece, { pieceId })).mediaFreeze?.status).toBe("FAILED");
  });

  it("rechecks actor activation and rejects forged storage metadata", async () => {
    const { t, owner, args } = await fixture();
    const request = await owner.as.mutation(api.media.requestFreeze, args);
    const snapshot = await file(t);
    await expect(t.mutation(internal.media.appendFile, { ...request, index: 0, file: { ...snapshot, contentHash: "a".repeat(64) } })).rejects.toThrow(/일치/);
    await t.run(ctx => ctx.db.patch(owner.userId, { status: "SUSPENDED" }));
    await expect(t.query(internal.media.nextFile, request)).rejects.toThrow(/권한/);
    await expect(t.mutation(internal.media.appendFile, { ...request, index: 0, file: snapshot })).rejects.toThrow(/권한/);
  });

  it("expires a stalled request, allows retry, and preserves previously READY files", async () => {
    const { t, owner, pieceId, args } = await fixture();
    const request = await owner.as.mutation(api.media.requestFreeze, args);
    await t.run(ctx => ctx.db.patch(request.requestId, { expiresAt: Date.now() - 1 }));
    expect((await owner.as.query(api.content.getPiece, { pieceId })).mediaFreeze?.status).toBe("FAILED");
    const retry = await owner.as.mutation(api.media.requestFreeze, args);
    expect(retry.requestId).not.toEqual(request.requestId);
    const snapshot = await file(t);
    await t.mutation(internal.media.appendFile, { ...retry, index: 0, file: snapshot });
    await t.run(async ctx => {
      const assets = await ctx.db.query("contentMediaAssets").collect();
      for (const asset of assets) await ctx.db.patch(asset._id, { expiresAt: Date.now() - 1 });
    });
    await t.mutation(internal.media.sweep, {});
    expect(await t.run(async ctx => !!await ctx.storage.get(snapshot.storageId))).toBe(true);
    await t.mutation(internal.media.recordFailure, { ...retry, error: "late duplicate failure" });
    expect((await t.run(ctx => ctx.db.get(retry.requestId)))?.status).toBe("SUCCEEDED");
  });

  it("reuses existing immutable files while freezing remaining remote inputs", async () => {
    const { t, owner, pieceId, args } = await fixture();
    const first = await owner.as.mutation(api.media.requestFreeze, args);
    await t.mutation(internal.media.appendFile, { ...first, index: 0, file: await file(t) });
    const original = await t.run(ctx => ctx.db.get(pieceId));
    const fixedUrl = original!.mediaUrls[0]!;
    await owner.as.mutation(api.content.edit, { pieceId, caption, hashtags: ["광고"], mediaUrls: [fixedUrl, remote] });
    const edited = await t.run(ctx => ctx.db.get(pieceId));
    const next = await owner.as.mutation(api.media.requestFreeze, { ...args, expectedMediaRevisionHash: await mediaRevisionHash(edited!) });
    expect(await t.query(internal.media.nextFile, next)).toMatchObject({ reusable: true });
    await t.mutation(internal.media.appendFile, { ...next, index: 0 });
    await t.mutation(internal.media.appendFile, { ...next, index: 1, file: await file(t) });
    expect((await t.run(ctx => ctx.db.get(pieceId)))?.mediaUrls[0]).toBe(fixedUrl);
    expect(await t.run(ctx => ctx.db.query("contentMediaAssets").collect())).toHaveLength(2);
  });

  it("limits repeated requests per actor before scheduling more downloads", async () => {
    const { t, owner, pieceId, args } = await fixture();
    for (let i = 0; i < 12; i++) await t.run(ctx => ctx.db.insert("contentMediaFreezes", { pieceId, userId: owner.userId, status: "FAILED", inputHash: "old", sourceUrls: [], resultUrls: [], rightsNote: "test", completedCount: 0, createdAt: Date.now(), expiresAt: Date.now() + 1000 }));
    await expect(owner.as.mutation(api.media.requestFreeze, args)).rejects.toThrow(/12회/);
  });

  it("preserves committed files after an ambiguous append response and ignores stale worker failures", async () => {
    const { t, owner, args } = await fixture([remote, remote]);
    const request = await owner.as.mutation(api.media.requestFreeze, args);
    const first = await file(t);
    await t.mutation(internal.media.appendFile, { ...request, index: 0, file: first });
    expect(await t.mutation(internal.media.cleanupUnbound, { storageId: first.storageId })).toBe(false);
    await t.mutation(internal.media.recordFailure, { ...request, expectedIndex: 0, error: "late worker failed" });
    expect((await t.run(ctx => ctx.db.get(request.requestId)))?.status).toBe("RUNNING");
    const second = await file(t);
    await t.mutation(internal.media.appendFile, { ...request, index: 1, file: second });
    expect(await t.mutation(internal.media.cleanupUnbound, { storageId: second.storageId })).toBe(false);
    expect(await t.run(async ctx => !!await ctx.storage.get(second.storageId))).toBe(true);
    const orphan = await file(t);
    expect(await t.mutation(internal.media.cleanupUnbound, { storageId: orphan.storageId })).toBe(true);
    expect(await t.run(ctx => ctx.storage.get(orphan.storageId))).toBeNull();
  });
});
