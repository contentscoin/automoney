import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT, seedProduct, signup } from "./helpers";

const manualInput = {
  channel: "THREADS" as const,
  caption: "오늘의 스타일링 자료를 정리했습니다. 자세한 구성과 상품 정보는 링크에서 확인하세요.",
  hashtags: ["광고"],
  mediaUrls: [] as string[],
};

describe("publish content deep-link selection", () => {
  it("loads an approved old piece by ID even when it falls outside the 200-item library window", async () => {
    const t = makeT();
    const user = await signup(t, "old-piece-selection@test.com");
    const old = await user.as.mutation(api.content.createManual, manualInput);
    expect(old.status).toBe("APPROVED");
    await t.run(async (ctx) => {
      const original = (await ctx.db.get(old.pieceId))!;
      for (let index = 0; index < 205; index++) {
        await ctx.db.insert("contentPieces", {
          ...manualInput,
          ownerUserId: user.userId,
          visibility: "PRIVATE",
          status: "APPROVED",
          generatedBy: "manual",
          qualityScore: 100,
          qualityReport: { violations: [], fixed: [] },
          usageCount: 0,
          createdAt: original.createdAt + index + 1,
        });
      }
    });
    const recent = await user.as.query(api.content.listLibrary, { status: "APPROVED", limit: 200 });
    expect(recent).toHaveLength(200);
    expect(recent.some((piece) => piece._id === old.pieceId)).toBe(false);
    const selected = await user.as.query(api.content.getPublishPiece, { pieceId: old.pieceId });
    expect(selected).toMatchObject({ _id: old.pieceId, status: "APPROVED", mine: true });
  });

  it("returns the same null result for malformed, missing and another user's private IDs", async () => {
    const t = makeT();
    const user = await signup(t, "selection-owner@test.com");
    const other = await signup(t, "selection-other@test.com");
    const privatePiece = await other.as.mutation(api.content.createManual, manualInput);
    const missing = await user.as.mutation(api.content.createManual, manualInput);
    await t.run((ctx) => ctx.db.delete(missing.pieceId));
    for (const pieceId of ["not-a-valid-id", "", missing.pieceId, privatePiece.pieceId, user.userId]) {
      expect(await user.as.query(api.content.getPublishPiece, { pieceId })).toBeNull();
    }
  });

  it("does not expose drafts, inactive product content, unpublished collections or unreviewed automation as publishable", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const productId = await seedProduct(t);
    const draft = await owner.as.mutation(api.content.createManual, manualInput);
    const inactive = await owner.as.mutation(api.content.createManual, { ...manualInput, productId });
    const unpublished = await owner.as.mutation(api.content.createManual, manualInput);
    const unreviewed = await owner.as.mutation(api.content.createManual, manualInput);
    await t.run(async (ctx) => {
      await ctx.db.patch(draft.pieceId, { status: "DRAFT" });
      await ctx.db.patch(productId, { status: "INACTIVE" });
      const collectionId = await ctx.db.insert("contentCollections", {
        title: "미공개 공급 자료", tags: [], sourceMaterialIds: [], pieceIds: [unpublished.pieceId],
        status: "DRAFT", createdBy: owner.userId, revision: 1, createdAt: Date.now(), updatedAt: Date.now(),
      });
      await ctx.db.patch(unpublished.pieceId, { collectionId });
      await ctx.db.patch(unreviewed.pieceId, { generatedBy: "codex", status: "APPROVED" });
    });
    for (const pieceId of [draft.pieceId, inactive.pieceId, unpublished.pieceId, unreviewed.pieceId]) {
      expect(await owner.as.query(api.content.getPublishPiece, { pieceId })).toBeNull();
    }
  });

  it("requires authentication even for malformed IDs", async () => {
    const t = makeT();
    await expect(t.query(api.content.getPublishPiece, { pieceId: "invalid" })).rejects.toThrow(/로그인/);
  });
});
