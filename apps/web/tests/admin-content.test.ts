import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { consumePiece } from "../convex/lib/pieces";
import { makeT, seedProduct, setRole, signup } from "./helpers";

const REVIEW_CHECKLIST = {
  productFacts: true,
  adDisclosure: true,
  mediaRightsAndFit: true,
  finalCopy: true,
} as const;

const PASSING_CAPTION = "가을 원피스로 완성하는 데일리 코디가 궁금하다면? 소재와 핏 정보는 상품 링크에서 자세히 확인해 보세요.";

async function setup() {
  const t = makeT();
  const owner = await signup(t, "owner@automoney.test");
  await setRole(t, owner.userId, "SUPER_ADMIN");
  const user = await signup(t, "reader@automoney.test");
  const productId = await seedProduct(t, 909001);
  return { t, owner, user, productId };
}

async function bindContentUpload(
  t: ReturnType<typeof makeT>,
  owner: Awaited<ReturnType<typeof signup>>,
  blob: Blob,
) {
  const { intentId } = await owner.as.mutation(api.adminContent.generateUploadUrl, {});
  const storageId = await t.run((ctx) => ctx.storage.store(blob));
  await owner.as.mutation(api.adminContent.bindUpload, { intentId, storageId });
  return { intentId, storageId };
}

async function readyTextMaterial(
  owner: Awaited<ReturnType<typeof signup>>,
  overrides: Partial<{
    title: string;
    bodyText: string;
    externalUrl: string;
    productId: Id<"products">;
  }> = {},
) {
  const created = await owner.as.mutation(api.adminContent.createMaterial, {
    kind: "TEXT",
    title: overrides.title ?? "가을 캠페인 원문",
    bodyText: overrides.bodyText ?? "등록 상품의 이름과 가격만 근거로 사용합니다.",
    externalUrl: overrides.externalUrl,
    productId: overrides.productId,
    rightsStatus: "OWNED",
    rightsNote: "운영사 자체 작성 원문",
  });
  await owner.as.mutation(api.adminContent.markMaterialReady, { materialId: created.materialId, expectedUpdatedAt: created.updatedAt });
  return created.materialId;
}

async function createCollectionPiece(
  owner: Awaited<ReturnType<typeof signup>>,
  materialId: Id<"contentSourceMaterials">,
  productId?: Id<"products">,
) {
  const { collectionId } = await owner.as.mutation(api.adminContent.createCollection, {
    title: "9월 운영 콘텐츠",
    summary: "검수 완료 콘텐츠만 사용자에게 제공합니다.",
    tags: ["가을", "운영추천", "가을"],
    sourceMaterialIds: [materialId],
  });
  const piece = await owner.as.mutation(api.adminContent.addManualPiece, {
    collectionId,
    sourceMaterialIds: [materialId],
    channel: "THREADS",
    caption: PASSING_CAPTION,
    hashtags: ["광고", "데일리룩", "원피스"],
    productId,
  });
  return { collectionId, ...piece };
}

describe("SUPER_ADMIN content supply workflow", () => {
  it("corrects draft evidence with stale-edit protection and preserves reviewed evidence", async () => {
    const { t, owner, user, productId } = await setup();
    const created = await owner.as.mutation(api.adminContent.createMaterial, {
      kind: "TEXT", title: "오입력", bodyText: "수정 전", productId,
      rightsStatus: "OWNED", rightsNote: "자체 작성",
    });
    const original = (await t.run((ctx) => ctx.db.get(created.materialId)))!;
    const correction = {
      materialId: created.materialId, expectedUpdatedAt: original.updatedAt,
      title: "확인된 제품 설명", bodyText: "상품에서 확인한 소재와 핏 정보입니다.",
      externalUrl: "https://example.com/source", productId: null,
      rightsStatus: "LICENSED" as const, rightsNote: "브랜드 콘텐츠 사용 계약",
    };
    await expect(user.as.mutation(api.adminContent.updateMaterial, correction)).rejects.toThrow(/권한/);
    const updated = await owner.as.mutation(api.adminContent.updateMaterial, correction);
    expect(updated.updatedAt).toBeGreaterThan(original.updatedAt);
    const material = await t.run((ctx) => ctx.db.get(created.materialId));
    expect(material).toMatchObject({ title: correction.title, bodyText: correction.bodyText, rightsStatus: "LICENSED", status: "DRAFT" });
    expect(material?.productId).toBeUndefined();
    await expect(owner.as.mutation(api.adminContent.updateMaterial, correction)).rejects.toThrow(/다른 운영자/);
    await expect(owner.as.mutation(api.adminContent.markMaterialReady, { materialId: created.materialId, expectedUpdatedAt: original.updatedAt })).rejects.toThrow(/자료가 변경/);
    expect(await t.run((ctx) => ctx.db.get(created.materialId))).toMatchObject({ status: "DRAFT" });
    await owner.as.mutation(api.adminContent.markMaterialReady, { materialId: created.materialId, expectedUpdatedAt: updated.updatedAt });
    const readyEvents = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(readyEvents.find((event) => event.action === "adminContent.materialReady")?.metadata)
      .toMatchObject({ materialId: created.materialId, reviewedUpdatedAt: updated.updatedAt });
    await expect(owner.as.mutation(api.adminContent.updateMaterial, { ...correction, expectedUpdatedAt: updated.updatedAt })).rejects.toThrow(/초안 자료만/);

    const link = await owner.as.mutation(api.adminContent.createMaterial, {
      kind: "LINK", title: "잘못된 출처", externalUrl: "https://example.com/wrong",
      rightsStatus: "LINK_ONLY", rightsNote: "출처 확인",
    });
    const linkBefore = (await t.run((ctx) => ctx.db.get(link.materialId)))!;
    const linkEdit = { materialId: link.materialId, expectedUpdatedAt: linkBefore.updatedAt, title: "수정된 출처", externalUrl: "https://example.com/correct", rightsStatus: "LINK_ONLY" as const, rightsNote: "출처 확인" };
    await expect(owner.as.mutation(api.adminContent.updateMaterial, { ...linkEdit, externalUrl: "http://example.com" })).rejects.toThrow(/HTTPS/);
    await owner.as.mutation(api.adminContent.updateMaterial, linkEdit);
    expect(await t.run((ctx) => ctx.db.get(link.materialId))).toMatchObject({ externalUrl: "https://example.com/correct" });
  });

  it("reselects collection materials without severing output evidence and detects concurrent edits", async () => {
    const { t, owner } = await setup();
    const used = await readyTextMaterial(owner);
    const unused = await readyTextMaterial(owner, { title: "잘못 선택한 자료" });
    const replacement = await readyTextMaterial(owner, { title: "새 캠페인 자료" });
    const item = await createCollectionPiece(owner, used);
    const update = { collectionId: item.collectionId, expectedRevision: 1, title: "수정한 캠페인", summary: "공급용", tags: ["새태그"], sourceMaterialIds: [used, unused] };
    expect(await owner.as.mutation(api.adminContent.updateCollection, update)).toMatchObject({ revision: 2 });
    await expect(owner.as.mutation(api.adminContent.updateCollection, update)).rejects.toThrow(/컬렉션이 변경/);
    await expect(owner.as.mutation(api.adminContent.updateCollection, { ...update, expectedRevision: 2, sourceMaterialIds: [replacement] })).rejects.toThrow(/콘텐츠가 사용 중/);
    await owner.as.mutation(api.adminContent.updateCollection, { ...update, expectedRevision: 2, sourceMaterialIds: [used, replacement] });
    await owner.as.mutation(api.adminContent.archiveMaterial, { materialId: unused });
    expect(await t.run((ctx) => ctx.db.get(unused))).toMatchObject({ status: "ARCHIVED" });
    await owner.as.mutation(api.adminContent.removePiece, { collectionId: item.collectionId, pieceId: item.pieceId });
    await owner.as.mutation(api.adminContent.updateCollection, { ...update, expectedRevision: 3, sourceMaterialIds: [replacement] });
    await owner.as.mutation(api.adminContent.archiveMaterial, { materialId: used });
    expect(await owner.as.query(api.adminContent.getCollection, { collectionId: item.collectionId })).toMatchObject({ title: update.title, revision: 4, sourceMaterialIds: [replacement] });
  });

  it("discards a reopened draft, releases source materials, and preserves existing user copies and audit lineage", async () => {
    const { t, owner, user } = await setup();
    const materialId = await readyTextMaterial(owner);
    const item = await createCollectionPiece(owner, materialId);
    await owner.as.mutation(api.adminContent.submitCollection, { collectionId: item.collectionId });
    await owner.as.mutation(api.content.approve, { pieceId: item.pieceId, expectedOutputHash: item.outputHash, reviewChecklist: REVIEW_CHECKLIST });
    await owner.as.mutation(api.adminContent.publishCollection, { collectionId: item.collectionId });
    const copy = await user.as.mutation(api.content.copyToMine, { pieceId: item.pieceId });
    await expect(owner.as.mutation(api.adminContent.discardCollection, { collectionId: item.collectionId, expectedRevision: 1 })).rejects.toThrow(/초안 컬렉션만/);
    await owner.as.mutation(api.adminContent.reopenCollection, { collectionId: item.collectionId });
    await expect(user.as.mutation(api.adminContent.discardCollection, { collectionId: item.collectionId, expectedRevision: 2 })).rejects.toThrow(/권한/);
    await expect(owner.as.mutation(api.adminContent.discardCollection, { collectionId: item.collectionId, expectedRevision: 1 })).rejects.toThrow(/컬렉션이 변경/);
    await owner.as.mutation(api.adminContent.discardCollection, { collectionId: item.collectionId, expectedRevision: 2 });
    expect(await owner.as.mutation(api.adminContent.discardCollection, { collectionId: item.collectionId, expectedRevision: 2 })).toMatchObject({ discarded: true });
    const discarded = await owner.as.query(api.adminContent.getCollection, { collectionId: item.collectionId });
    expect(discarded).toMatchObject({ status: "WITHDRAWN", discardedBy: owner.userId, sourceMaterialIds: [], pieceIds: [] });
    expect(discarded.discardedAt).toBeTypeOf("number");
    expect(await t.run((ctx) => ctx.db.get(item.pieceId))).toMatchObject({ status: "RETIRED", visibility: "PRIVATE", productionMeta: { removedFromCollectionId: item.collectionId } });
    await expect(owner.as.mutation(api.adminContent.reopenCollection, { collectionId: item.collectionId })).rejects.toThrow(/폐기된 컬렉션/);
    await owner.as.mutation(api.adminContent.archiveMaterial, { materialId });
    expect(await user.as.query(api.content.getPiece, { pieceId: copy.pieceId })).toMatchObject({ mine: true, status: "DRAFT", sourceMaterialIds: [materialId] });
    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(events.find((event) => event.action === "adminContent.collectionDiscard")?.metadata).toMatchObject({ sourceMaterialIds: [materialId], pieceIds: [item.pieceId] });
  });

  it("locks collection changes until pending generation results are ingested", async () => {
    const { t, owner } = await setup();
    const materialId = await readyTextMaterial(owner);
    const item = await createCollectionPiece(owner, materialId);
    const { code } = await owner.as.mutation(api.devices.createPairCode, {});
    const device = await t.mutation(api.devices.pair, { code, deviceName: "운영 PC", platform: "win32", appVersion: "0.1.16" });
    await t.run((ctx) => ctx.db.patch(device.deviceId, { lastSeenAt: Date.now(), snapshot: { codexLoggedIn: true } }));
    const run = await owner.as.mutation(api.adminContent.requestGenerate, { collectionId: item.collectionId, sourceMaterialIds: [materialId], channels: ["THREADS"], brief: {}, clientRequestId: "locked_collection_001" });
    const update = { collectionId: item.collectionId, expectedRevision: 1, title: "변경", tags: [], sourceMaterialIds: [materialId] };
    for (const status of ["QUEUED", "SUCCEEDED"] as const) {
      await t.run((ctx) => ctx.db.patch(run.jobIds[0]!, { status }));
      await expect(owner.as.mutation(api.adminContent.updateCollection, update)).rejects.toThrow(/AI 생성이 진행/);
      await expect(owner.as.mutation(api.adminContent.discardCollection, { collectionId: item.collectionId, expectedRevision: 1 })).rejects.toThrow(/AI 생성이 진행/);
      await expect(owner.as.mutation(api.adminContent.removePiece, { collectionId: item.collectionId, pieceId: item.pieceId })).rejects.toThrow(/AI 생성이 진행/);
    }
    await t.run((ctx) => ctx.db.patch(run.jobIds[0]!, { status: "FAILED", errorCode: "CODEX_NOT_READY", errorMessage: "운영 PC의 로그인을 확인하세요." }));
    const collection = await owner.as.query(api.adminContent.getCollection, { collectionId: item.collectionId });
    expect(collection.runs[0]).toMatchObject({ status: "FAILED", errorMessage: "운영 PC의 로그인을 확인하세요.", jobs: [{ errorCode: "CODEX_NOT_READY" }] });
    await owner.as.mutation(api.adminContent.updateCollection, update);
  });

  it("paginates all materials and collections and bounds oversized dashboard summaries", async () => {
    const { t, owner, user } = await setup();
    const materialId = await readyTextMaterial(owner);
    await t.run(async (ctx) => {
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("contentCollections", { title: `컬렉션 ${i}`, tags: [], sourceMaterialIds: [materialId], pieceIds: [], status: "DRAFT", createdBy: owner.userId, revision: 1, createdAt: Date.now(), updatedAt: Date.now() });
      }
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("contentSourceMaterials", { kind: "TEXT", title: `자료 ${i}`, bodyText: "가".repeat(200_000), rightsStatus: "OWNED", rightsNote: "자체 제작", status: "DRAFT", createdBy: owner.userId, createdAt: Date.now(), updatedAt: Date.now() });
      }
    });
    const first = await owner.as.query(api.adminContent.paginateCollections, { paginationOpts: { numItems: 50, cursor: null }, status: "DRAFT" });
    expect(first.page).toHaveLength(50);
    expect(first.isDone).toBe(false);
    const second = await owner.as.query(api.adminContent.paginateCollections, { paginationOpts: { numItems: 50, cursor: first.continueCursor }, status: "DRAFT" });
    expect(second.page).toHaveLength(5);
    expect(second.isDone).toBe(true);
    expect(new Set([...first.page, ...second.page].map((row) => row._id)).size).toBe(55);
    const materials = await owner.as.query(api.adminContent.paginateMaterials, { paginationOpts: { numItems: 3, cursor: null }, status: "DRAFT" });
    expect(materials.page).toHaveLength(3);
    expect(materials.isDone).toBe(false);
    expect((await owner.as.query(api.adminContent.paginateMaterials, { paginationOpts: { numItems: 3, cursor: materials.continueCursor }, status: "DRAFT" })).page[0]!._id).not.toBe(materials.page[0]!._id);
    await expect(user.as.query(api.adminContent.paginateMaterials, { paginationOpts: { numItems: 3, cursor: null } })).rejects.toThrow(/권한/);
    const summary = await owner.as.query(api.adminContent.summary, {});
    expect(summary.truncated).toBe(true);
    expect(summary.materials.total).toBeLessThan(9);
    expect(summary.collections.total).toBe(55);
  });

  it("freezes admin material evidence, deduplicates requests, and attaches private AI drafts without catalog media", async () => {
    const { t, owner, productId, user } = await setup();
    const materialId = await readyTextMaterial(owner, { productId });
    const { collectionId } = await owner.as.mutation(api.adminContent.createCollection, { title: "AI 운영", tags: [], sourceMaterialIds: [materialId] });
    const { code } = await owner.as.mutation(api.devices.createPairCode, {});
    const device = await t.mutation(api.devices.pair, { code, deviceName: "운영 PC", platform: "win32", appVersion: "0.1.16" });
    await t.run(async (ctx) => {
      await ctx.db.patch(device.deviceId, { lastSeenAt: Date.now(), snapshot: { codexLoggedIn: true } });
      await ctx.db.patch(productId, { imageUrls: ["https://catalog.test/unlicensed.jpg"] });
    });
    const args = { collectionId, sourceMaterialIds: [materialId], channels: ["THREADS" as const], brief: { audience: "코디 고객" }, clientRequestId: "admin_test_001" };
    await expect(user.as.mutation(api.adminContent.requestGenerate, args)).rejects.toThrow(/권한/);
    const requested = await owner.as.mutation(api.adminContent.requestGenerate, args);
    expect(await owner.as.mutation(api.adminContent.requestGenerate, args)).toEqual(requested);
    await expect(owner.as.mutation(api.adminContent.requestGenerate, { ...args, channels: ["X"] })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    const run = await t.run((ctx) => ctx.db.get(requested.runId));
    expect(run?.adminMaterialSnapshot).toMatchObject({ collectionId, revision: 1, sourceMaterialIds: [materialId], materialMediaUrls: [], sourceMaterials: [{ title: "가을 캠페인 원문", rightsNote: "운영사 자체 작성 원문" }] });
    const generatedCaption = "테스트 상품 909001 원피스로 완성하는 가을 데일리 코디를 소개합니다.\n상품 정보와 가격은 링크에서 자세히 확인해 보세요. 저장해 두고 코디할 때 참고하세요.";
    await t.run((ctx) => ctx.db.patch(requested.jobIds[0]!, { status: "SUCCEEDED", result: { data: { generatedBy: "codex", pieces: [{ channel: "THREADS", caption: generatedCaption, hashtags: ["가을코디", "광고"], generatedBy: "codex", attemptNo: 1, mediaUrls: ["https://attacker.test/file.jpg"] }] } } }));
    expect(await t.mutation(internal.content.ingestGenerated, { jobId: requested.jobIds[0]! })).toMatchObject({ saved: 1, approved: 0 });
    const collection = await owner.as.query(api.adminContent.getCollection, { collectionId });
    expect(collection.pieces).toHaveLength(1);
    expect(collection.pieces[0]).toMatchObject({ collectionId, sourceMaterialIds: [materialId], mediaUrls: [], visibility: "PRIVATE", status: "DRAFT", productionMeta: { standardPassed: true } });
    expect(await t.mutation(internal.content.ingestGenerated, { jobId: requested.jobIds[0]! })).toMatchObject({ duplicate: true });
    const generated = collection.pieces[0]!;
    await owner.as.mutation(api.adminContent.submitCollection, { collectionId });
    await owner.as.mutation(api.content.approve, { pieceId: generated._id, expectedOutputHash: generated.productionMeta.outputHash, reviewChecklist: REVIEW_CHECKLIST });
    await owner.as.mutation(api.adminContent.publishCollection, { collectionId });
    expect((await user.as.query(api.content.listLibrary, {})).map((piece) => piece._id)).toContain(generated._id);
    const copied = await user.as.mutation(api.content.copyToMine, { pieceId: generated._id });
    expect(await user.as.query(api.content.getPiece, { pieceId: copied.pieceId })).toMatchObject({ visibility: "PRIVATE", status: "DRAFT", sourceMaterialIds: [materialId] });
  });

  it("requires PC version and Codex readiness, blocks pending review, and quarantines late results", async () => {
    const { t, owner } = await setup();
    const materialId = await readyTextMaterial(owner);
    const { collectionId } = await createCollectionPiece(owner, materialId);
    const { code } = await owner.as.mutation(api.devices.createPairCode, {});
    const device = await t.mutation(api.devices.pair, { code, deviceName: "운영 PC", platform: "win32", appVersion: "0.1.15" });
    await t.run((ctx) => ctx.db.patch(device.deviceId, { lastSeenAt: Date.now(), snapshot: { codexLoggedIn: true } }));
    const args = { collectionId, sourceMaterialIds: [materialId], channels: ["THREADS" as const], brief: {}, clientRequestId: "admin_test_002" };
    await expect(owner.as.mutation(api.adminContent.requestGenerate, args)).rejects.toThrow(/0.1.16/);
    await t.run((ctx) => ctx.db.patch(device.deviceId, { appVersion: "0.1.16", snapshot: { codexLoggedIn: false } }));
    await expect(owner.as.mutation(api.adminContent.requestGenerate, args)).rejects.toThrow(/Codex/);
    await t.run((ctx) => ctx.db.patch(device.deviceId, { snapshot: { codexLoggedIn: true } }));

    const linkMaterial = await owner.as.mutation(api.adminContent.createMaterial, {
      kind: "LINK",
      title: "출처 링크만 있는 자료",
      externalUrl: "https://example.com/editorial",
      rightsStatus: "LINK_ONLY",
      rightsNote: "출처 확인용",
    });
    await owner.as.mutation(api.adminContent.markMaterialReady, { materialId: linkMaterial.materialId, expectedUpdatedAt: linkMaterial.updatedAt });
    const linkCollection = await owner.as.mutation(api.adminContent.createCollection, {
      title: "근거 없는 AI 요청 차단",
      tags: [],
      sourceMaterialIds: [linkMaterial.materialId],
    });
    await expect(owner.as.mutation(api.adminContent.requestGenerate, {
      collectionId: linkCollection.collectionId,
      sourceMaterialIds: [linkMaterial.materialId],
      channels: ["THREADS"],
      brief: {},
      clientRequestId: "admin_link_only",
    })).rejects.toThrow(/판매 상품 또는 내용이 입력된 텍스트 자료/);

    const requested = await owner.as.mutation(api.adminContent.requestGenerate, args);
    await expect(owner.as.mutation(api.adminContent.submitCollection, { collectionId })).rejects.toThrow(/AI 생성이 진행/);
    await t.run(async (ctx) => {
      await ctx.db.patch(collectionId, { revision: 2 });
      await ctx.db.patch(requested.jobIds[0]!, { status: "SUCCEEDED", result: { data: { pieces: [{ channel: "THREADS", caption: PASSING_CAPTION, hashtags: ["광고"], generatedBy: "codex" }] } } });
    });
    expect(await t.mutation(internal.content.ingestGenerated, { jobId: requested.jobIds[0]! })).toMatchObject({ saved: 0 });
    const run = await t.run((ctx) => ctx.db.get(requested.runId));
    expect(run?.quarantineReason).toMatch(/revision/);
    expect((await owner.as.query(api.adminContent.getCollection, { collectionId })).pieces).toHaveLength(1);
  });

  it("denies regular users and distributor admins while allowing audited SUPER_ADMIN collaboration", async () => {
    const { t, owner, user } = await setup();
    const distributor = await signup(t, "distributor@automoney.test");
    await setRole(t, distributor.userId, "ADMIN");
    const materialId = await readyTextMaterial(owner);

    for (const principal of [user, distributor]) {
      await expect(principal.as.mutation(api.adminContent.createMaterial, {
        kind: "TEXT",
        title: "권한 없는 자료",
        bodyText: "권한 없음",
        rightsStatus: "OWNED",
        rightsNote: "없음",
      })).rejects.toThrow(/권한/);
      await expect(principal.as.query(api.adminContent.listMaterials, {})).rejects.toThrow(/권한/);
    }

    const otherSuper = await signup(t, "second-owner@automoney.test");
    await setRole(t, otherSuper.userId, "SUPER_ADMIN");
    const shared = await otherSuper.as.mutation(api.adminContent.createCollection, {
      title: "공동 운영 컬렉션",
      tags: [],
      sourceMaterialIds: [materialId],
    });
    expect(await t.run((ctx) => ctx.db.get(shared.collectionId))).toMatchObject({ createdBy: otherSuper.userId });
    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(events.some((event) =>
      event.action === "adminContent.collectionCreate"
      && event.actorUserId === otherSuper.userId
      && event.metadata?.collectionId === shared.collectionId
    )).toBe(true);
  });

  it("validates uploaded files, normalizes a Korean file name, and serves only ready immutable assets", async () => {
    const { t, owner } = await setup();
    const upload = await bindContentUpload(t, owner, new Blob(["png-bytes"], { type: "image/png" }));
    const created = await owner.as.mutation(api.adminContent.createMaterial, {
      kind: "FILE",
      title: "운영 이미지",
      externalUrl: "https://attrangs.co.kr/editorial/source",
      uploadIntentId: upload.intentId,
      fileName: "가을 코디 이미지.png",
      mimeType: "image/png",
      rightsStatus: "LICENSED",
      rightsNote: "마케팅 재사용 계약 확인",
    });
    expect(created.deliveryUrl).toMatch(/^https:\/\/convex\.automoney\.test\/content-assets\/[^/]+\/asset-[a-f0-9]{16}\.png$/);

    const before = await t.fetch(new URL(created.deliveryUrl!).pathname);
    expect(before.status).toBe(404);
    const listedDraft = (await owner.as.query(api.adminContent.listMaterials, {}))
      .find((material) => material._id === created.materialId);
    expect(listedDraft?.previewUrl).toMatch(/^https?:\/\//);
    await owner.as.mutation(api.adminContent.markMaterialReady, { materialId: created.materialId, expectedUpdatedAt: created.updatedAt });
    const served = await t.fetch(new URL(created.deliveryUrl!).pathname);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(await served.text()).toBe("png-bytes");
    expect((await t.fetch(`${new URL(created.deliveryUrl!).pathname}.jpg`)).status).toBe(404);
    await owner.as.mutation(api.adminContent.archiveMaterial, { materialId: created.materialId });
    expect((await t.fetch(new URL(created.deliveryUrl!).pathname)).status).toBe(200);

    const draftUpload = await bindContentUpload(t, owner, new Blob(["draft"], { type: "image/png" }));
    const draftOnly = await owner.as.mutation(api.adminContent.createMaterial, {
      kind: "FILE",
      title: "미검수 보관 자료",
      uploadIntentId: draftUpload.intentId,
      fileName: "draft.png",
      mimeType: "image/png",
      rightsStatus: "OWNED",
      rightsNote: "검수 전 보관",
    });
    await owner.as.mutation(api.adminContent.archiveMaterial, { materialId: draftOnly.materialId });
    expect((await t.fetch(new URL(draftOnly.deliveryUrl!).pathname)).status).toBe(404);

    const duplicateIntent = await owner.as.mutation(api.adminContent.generateUploadUrl, {});
    await expect(owner.as.mutation(api.adminContent.bindUpload, {
      intentId: duplicateIntent.intentId,
      storageId: upload.storageId,
    })).rejects.toThrow(/이미 다른 업로드 요청/);
    await t.run((ctx) => ctx.db.patch(duplicateIntent.intentId, {
      storageId: upload.storageId,
      state: "BOUND",
      expiresAt: Date.now() - 1,
    }));

    const wrongPurpose = await owner.as.mutation(api.adminContent.generateUploadUrl, {});
    const wrongPurposeStorage = await t.run((ctx) => ctx.storage.store(new Blob(["kyc"], { type: "image/png" })));
    await expect(owner.as.mutation(api.kyc.bindUpload, {
      intentId: wrongPurpose.intentId,
      storageId: wrongPurposeStorage,
    })).rejects.toThrow(/찾을 수 없습니다/);

    const badMime = await bindContentUpload(t, owner, new Blob(["x"], { type: "application/zip" }));
    await expect(owner.as.mutation(api.adminContent.createMaterial, {
      kind: "FILE",
      title: "금지 파일",
      uploadIntentId: badMime.intentId,
      fileName: "bad.zip",
      mimeType: "application/zip",
      rightsStatus: "OWNED",
      rightsNote: "자체 제작",
    })).rejects.toThrow(/지원하지 않는/);
    const wrongExtension = await bindContentUpload(t, owner, new Blob(["png-bytes"], { type: "image/png" }));
    await expect(owner.as.mutation(api.adminContent.createMaterial, {
      kind: "FILE",
      title: "확장자 불일치",
      uploadIntentId: wrongExtension.intentId,
      fileName: "image.jpg",
      mimeType: "image/png",
      rightsStatus: "OWNED",
      rightsNote: "자체 제작",
    })).rejects.toThrow(/확장자/);
    await expect(owner.as.mutation(api.adminContent.createMaterial, {
      kind: "LINK",
      title: "안전하지 않은 링크",
      externalUrl: "http://example.com/source",
      rightsStatus: "LINK_ONLY",
      rightsNote: "링크 인용만",
    })).rejects.toThrow(/HTTPS/);
    await expect(owner.as.mutation(api.adminContent.createMaterial, {
      kind: "TEXT",
      title: "재사용 권리 없는 텍스트",
      bodyText: "링크로만 확인해야 하는 원문",
      rightsStatus: "LINK_ONLY",
      rightsNote: "본문 재사용 금지",
    })).rejects.toThrow(/자체 소유 또는 사용 허가/);
    await expect(owner.as.mutation(api.adminContent.createMaterial, {
      kind: "LINK",
      title: "권리 유형이 잘못된 링크",
      externalUrl: "https://example.com/source",
      rightsStatus: "OWNED",
      rightsNote: "링크 자료",
    })).rejects.toThrow(/링크만 인용/);

    await t.run((ctx) => ctx.db.patch(wrongExtension.intentId, { expiresAt: Date.now() - 1 }));
    expect(await t.mutation(internal.adminContent.sweepExpiredUploads, {})).toMatchObject({ expired: 2, deleted: 1 });
    expect(await t.run((ctx) => ctx.db.system.get(wrongExtension.storageId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get(upload.storageId))).not.toBeNull();
  });

  it("requires an exact checklist review and publishes or withdraws the collection atomically", async () => {
    const { t, owner, user, productId } = await setup();
    const reviewer = await signup(t, "reviewer@automoney.test");
    await setRole(t, reviewer.userId, "SUPER_ADMIN");
    const publisher = await signup(t, "publisher@automoney.test");
    await setRole(t, publisher.userId, "SUPER_ADMIN");
    const pendingOperator = await signup(t, "pending-operator@automoney.test");
    await setRole(t, pendingOperator.userId, "SUPER_ADMIN");
    await t.run((ctx) => ctx.db.patch(pendingOperator.userId, { status: "PENDING" }));
    const materialId = await readyTextMaterial(owner, { productId });
    const first = await createCollectionPiece(owner, materialId);
    expect(await t.run((ctx) => ctx.db.get(first.pieceId))).toMatchObject({ productId });
    await expect(owner.as.mutation(api.adminContent.archiveMaterial, { materialId }))
      .rejects.toThrow(/사용 중인 컬렉션/);
    const second = await owner.as.mutation(api.adminContent.addManualPiece, {
      collectionId: first.collectionId,
      sourceMaterialIds: [materialId],
      channel: "X",
      caption: "가을 원피스 코디 포인트를 상품 링크에서 자세히 확인해 보세요.",
      hashtags: ["광고", "가을코디"],
      productId,
    });
    await expect(pendingOperator.as.query(api.content.getPiece, { pieceId: first.pieceId })).rejects.toThrow(/접근/);
    await reviewer.as.mutation(api.adminContent.submitCollection, { collectionId: first.collectionId });

    await expect(pendingOperator.as.mutation(api.content.approve, {
      pieceId: first.pieceId,
      expectedOutputHash: first.outputHash,
      reviewChecklist: REVIEW_CHECKLIST,
    })).rejects.toThrow(/찾을 수 없|활성|검수 요청/);

    await expect(reviewer.as.mutation(api.content.approve, { pieceId: first.pieceId }))
      .rejects.toThrow(/다시 확인|모두 확인/);
    await expect(reviewer.as.mutation(api.content.approve, {
      pieceId: first.pieceId,
      expectedOutputHash: "0".repeat(64),
      reviewChecklist: REVIEW_CHECKLIST,
    })).rejects.toThrow(/변경/);
    await reviewer.as.mutation(api.content.approve, {
      pieceId: first.pieceId,
      expectedOutputHash: first.outputHash,
      reviewChecklist: REVIEW_CHECKLIST,
    });

    await expect(publisher.as.mutation(api.adminContent.publishCollection, { collectionId: first.collectionId }))
      .rejects.toThrow(/모든 콘텐츠/);
    expect(await t.run((ctx) => ctx.db.get(first.pieceId))).toMatchObject({ visibility: "PRIVATE" });
    expect(await t.run((ctx) => ctx.db.get(second.pieceId))).toMatchObject({ visibility: "PRIVATE" });

    await publisher.as.mutation(api.content.approve, {
      pieceId: second.pieceId,
      expectedOutputHash: second.outputHash,
      reviewChecklist: REVIEW_CHECKLIST,
    });
    await t.run(async (ctx) => {
      const piece = await ctx.db.get(first.pieceId);
      await ctx.db.patch(first.pieceId, {
        productionMeta: { ...(piece!.productionMeta as Record<string, unknown>), standardPassed: false },
      });
    });
    await expect(publisher.as.mutation(api.adminContent.publishCollection, { collectionId: first.collectionId }))
      .rejects.toThrow(/운영 검수/);
    await t.run(async (ctx) => {
      const piece = await ctx.db.get(first.pieceId);
      await ctx.db.patch(first.pieceId, {
        productionMeta: { ...(piece!.productionMeta as Record<string, unknown>), standardPassed: true },
      });
    });
    await publisher.as.mutation(api.adminContent.publishCollection, { collectionId: first.collectionId });
    await expect(pendingOperator.as.mutation(api.content.edit, {
      pieceId: first.pieceId,
      caption: PASSING_CAPTION,
      hashtags: ["광고", "데일리룩"],
      mediaUrls: [],
    })).rejects.toThrow(/찾을 수 없|활성|권한|운영 컬렉션/);
    await expect(pendingOperator.as.mutation(api.content.reject, {
      pieceId: first.pieceId,
      reason: "권한 없는 변경",
    })).rejects.toThrow(/찾을 수 없|활성|권한|운영 컬렉션/);
    expect(await t.run((ctx) => ctx.db.get(first.collectionId))).toMatchObject({ status: "PUBLISHED" });
    const published = await user.as.query(api.content.listLibrary, {});
    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({
      collectionId: first.collectionId,
      collectionTitle: "9월 운영 콘텐츠",
      collectionStatus: "PUBLISHED",
      visibility: "SHARED",
    });
    expect(await t.run((ctx) => ctx.db.get(first.pieceId))).toMatchObject({ ownerUserId: publisher.userId, libraryPublishedBy: publisher.userId });
    expect(await t.run((ctx) => ctx.db.get(first.collectionId))).toMatchObject({
      createdBy: owner.userId,
      reviewedBy: reviewer.userId,
      reviewedByIds: [reviewer.userId, publisher.userId],
      publishedBy: publisher.userId,
    });
    expect(published[0]!.sourceMaterialIds).toEqual([materialId]);
    await expect(owner.as.mutation(api.content.setVisibility, { pieceId: first.pieceId, visibility: "PRIVATE" }))
      .rejects.toThrow(/컬렉션/);

    await setRole(t, publisher.userId, "USER");
    expect(await user.as.query(api.content.listLibrary, {})).toHaveLength(0);
    await expect(user.as.mutation(api.content.copyToMine, { pieceId: first.pieceId })).rejects.toThrow(/운영사가 소유/);
    await setRole(t, publisher.userId, "SUPER_ADMIN");

    await t.run((ctx) => ctx.db.patch(publisher.userId, { status: "SUSPENDED" }));
    expect(await user.as.query(api.content.listLibrary, {})).toHaveLength(0);
    await expect(user.as.mutation(api.content.copyToMine, { pieceId: first.pieceId })).rejects.toThrow(/운영사가 소유/);
    await t.run((ctx) => ctx.db.patch(publisher.userId, { status: "ACTIVE" }));

    const copied = await user.as.mutation(api.content.copyToMine, { pieceId: first.pieceId });
    expect(await user.as.query(api.content.getPiece, { pieceId: copied.pieceId })).toMatchObject({
      collectionId: null,
      sourceMaterialIds: [materialId],
      visibility: "PRIVATE",
      status: "DRAFT",
      mine: true,
    });
    await t.run((ctx) => ctx.db.patch(productId, { status: "INACTIVE" }));
    await expect(user.as.mutation(api.content.copyToMine, { pieceId: first.pieceId })).rejects.toThrow(/판매 중이 아닌/);
    expect((await user.as.query(api.content.listLibrary, {})).map((piece) => piece._id)).toEqual([copied.pieceId]);
    await t.run((ctx) => ctx.db.patch(productId, { status: "ACTIVE" }));

    await publisher.as.mutation(api.adminContent.withdrawCollection, { collectionId: first.collectionId });
    expect((await user.as.query(api.content.listLibrary, {})).map((piece) => piece._id)).toEqual([copied.pieceId]);
    await expect(user.as.query(api.content.getPiece, { pieceId: first.pieceId })).rejects.toThrow(/접근/);
    await expect(user.as.mutation(api.content.copyToMine, { pieceId: first.pieceId })).rejects.toThrow(/공유 콘텐츠/);
    await expect(t.run((ctx) => consumePiece(ctx, publisher.userId, first.pieceId))).rejects.toThrow(/현재 공개 중/);
    const collection = await owner.as.query(api.adminContent.getCollection, { collectionId: first.collectionId });
    expect(collection).toMatchObject({ status: "WITHDRAWN", pieceCount: 2, approvedPieceCount: 2 });
    expect(collection.pieces.every((piece) => piece.visibility === "PRIVATE")).toBe(true);
  });

  it("does not let a human checklist override the manual quality floor", async () => {
    const { owner } = await setup();
    const materialId = await readyTextMaterial(owner);
    const { collectionId } = await owner.as.mutation(api.adminContent.createCollection, {
      title: "낮은 품질 검증",
      tags: [],
      sourceMaterialIds: [materialId],
    });
    const lowQuality = await owner.as.mutation(api.adminContent.addManualPiece, {
      collectionId,
      sourceMaterialIds: [materialId],
      channel: "X",
      caption: "완벽한 선택과 특별한 순간을 위한 일상 속 여러분의 스타일을 지금 바로 만나 보시기 바랍니다. 완벽한 선택과 특별한 순간을 위한 일상 속 여러분의 스타일을 한 번 더 소개합니다.",
      hashtags: ["광고"],
    });
    expect(lowQuality.qualityScore).toBeLessThan(90);
    expect(lowQuality.violations.every((violation) => violation.severity !== "block")).toBe(true);
    await owner.as.mutation(api.adminContent.submitCollection, { collectionId });
    await expect(owner.as.mutation(api.content.approve, {
      pieceId: lowQuality.pieceId,
      expectedOutputHash: lowQuality.outputHash,
      reviewChecklist: REVIEW_CHECKLIST,
    })).rejects.toThrow(/90점 이상의 수동 콘텐츠 품질 기준/);
  });

  it("lets an operator repair a rejected collection piece instead of deadlocking the collection", async () => {
    const { t, owner } = await setup();
    const materialId = await readyTextMaterial(owner);
    const item = await createCollectionPiece(owner, materialId);

    await owner.as.mutation(api.content.reject, { pieceId: item.pieceId, reason: "문구 수정 필요" });
    expect(await t.run((ctx) => ctx.db.get(item.pieceId))).toMatchObject({ status: "RETIRED" });

    await owner.as.mutation(api.content.edit, {
      pieceId: item.pieceId,
      caption: `${PASSING_CAPTION} 저장해 두고 다음 코디에 활용해 보세요.`,
      hashtags: ["광고", "데일리룩", "원피스"],
      mediaUrls: [],
    });
    expect(await t.run((ctx) => ctx.db.get(item.pieceId))).toMatchObject({ status: "DRAFT", visibility: "PRIVATE" });
  });

  it("removes an unusable AI fallback and keeps the reviewed supply piece usable", async () => {
    const { t, owner, user } = await setup();
    const materialId = await readyTextMaterial(owner);
    const { collectionId } = await owner.as.mutation(api.adminContent.createCollection, {
      title: "부분 AI 결과 정리",
      tags: ["검수완료"],
      sourceMaterialIds: [materialId],
    });
    const { code } = await owner.as.mutation(api.devices.createPairCode, {});
    const device = await t.mutation(api.devices.pair, { code, deviceName: "운영 PC", platform: "win32", appVersion: "0.1.16" });
    await t.run((ctx) => ctx.db.patch(device.deviceId, { lastSeenAt: Date.now(), snapshot: { codexLoggedIn: true } }));
    const requested = await owner.as.mutation(api.adminContent.requestGenerate, {
      collectionId,
      sourceMaterialIds: [materialId],
      channels: ["THREADS", "X"],
      brief: { audience: "데일리룩 고객" },
      clientRequestId: "admin_partial_fallback",
    });
    await t.run((ctx) => ctx.db.patch(requested.jobIds[0]!, {
      status: "SUCCEEDED",
      result: { data: { generatedBy: "codex", pieces: [
        { channel: "THREADS", caption: "가을 원피스로 완성하는 데일리 코디를 소개합니다. 상품 정보는 링크에서 확인하고 저장해 두세요.", hashtags: ["광고", "데일리룩"], generatedBy: "codex", attemptNo: 1 },
        { channel: "X", caption: "가을 원피스 코디 포인트를 링크에서 확인하고 저장해 두세요.", hashtags: ["광고", "가을코디"], generatedBy: "template", attemptNo: 1 },
      ] } },
    }));
    expect(await t.mutation(internal.content.ingestGenerated, { jobId: requested.jobIds[0]! })).toMatchObject({ saved: 2 });
    let collection = await owner.as.query(api.adminContent.getCollection, { collectionId });
    const accepted = collection.pieces.find((piece) => piece.channel === "THREADS")!;
    const fallback = collection.pieces.find((piece) => piece.channel === "X")!;
    expect(accepted.productionMeta.standardPassed).toBe(true);
    expect(fallback.productionMeta.standardPassed).toBe(false);

    await owner.as.mutation(api.adminContent.submitCollection, { collectionId });
    await owner.as.mutation(api.content.approve, {
      pieceId: accepted._id,
      expectedOutputHash: accepted.productionMeta.outputHash,
      reviewChecklist: REVIEW_CHECKLIST,
    });
    await owner.as.mutation(api.adminContent.reopenCollection, { collectionId });
    await owner.as.mutation(api.adminContent.removePiece, { collectionId, pieceId: fallback._id });
    const removed = await t.run((ctx) => ctx.db.get(fallback._id));
    expect(removed).toMatchObject({ status: "RETIRED" });
    expect(removed?.collectionId).toBeUndefined();

    await owner.as.mutation(api.adminContent.submitCollection, { collectionId });
    await owner.as.mutation(api.adminContent.publishCollection, { collectionId });
    collection = await owner.as.query(api.adminContent.getCollection, { collectionId });
    expect(collection.pieces.map((piece) => piece._id)).toEqual([accepted._id]);
    expect((await t.run((ctx) => ctx.db.get(requested.runId)))?.status).toBe("REVIEW_REQUIRED");
    expect(await user.as.mutation(api.content.copyToMine, { pieceId: accepted._id })).toHaveProperty("pieceId");
    expect(await t.run((ctx) => consumePiece(ctx, user.userId, accepted._id))).toMatchObject({ channel: "THREADS" });
  });

  it("reopens and revisions a published collection when a piece is edited", async () => {
    const { owner, user, productId } = await setup();
    const materialId = await readyTextMaterial(owner, { productId });
    const item = await createCollectionPiece(owner, materialId, productId);
    await owner.as.mutation(api.adminContent.submitCollection, { collectionId: item.collectionId });
    await owner.as.mutation(api.content.approve, {
      pieceId: item.pieceId,
      expectedOutputHash: item.outputHash,
      reviewChecklist: REVIEW_CHECKLIST,
    });
    await owner.as.mutation(api.adminContent.publishCollection, { collectionId: item.collectionId });

    await owner.as.mutation(api.content.edit, {
      pieceId: item.pieceId,
      caption: `${PASSING_CAPTION} 이번 주 스타일링 포인트도 확인해 보세요.`,
      hashtags: ["광고", "데일리룩", "원피스"],
      mediaUrls: [],
    });
    const collection = await owner.as.query(api.adminContent.getCollection, { collectionId: item.collectionId });
    expect(collection).toMatchObject({ status: "DRAFT", revision: 2 });
    expect(collection.reviewedByIds).toBeUndefined();
    expect(collection.pieces[0]).toMatchObject({ status: "DRAFT", visibility: "PRIVATE" });
    expect((await user.as.query(api.content.listLibrary, {}))).toHaveLength(0);
  });
});
