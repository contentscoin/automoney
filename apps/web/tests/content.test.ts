import { describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_STANDARD } from "@automoney/shared";
import { api, internal } from "../convex/_generated/api";
import { frozenProductionStandard } from "../convex/content";
import { consumePiece } from "../convex/lib/pieces";
import { validatePublishAttemptPolicy } from "../convex/lib/publishAttempt";
import { parseTrendsRss } from "../convex/lib/search/provider";
import { makeT, seedProduct, setRole, signup, type T } from "./helpers";

const MAG_HTML = `<!doctype html><html><head><title>가을 니트 스타일링</title>
<meta property="og:title" content="가을 니트 스타일링 5가지" />
<meta property="og:description" content="아뜨랑스 매거진 · 니트 하나로 완성하는 데일리룩" />
<meta property="og:image" content="https://cdn.attrangs.co.kr/mag/cover.jpg" />
</head><body><nav>메뉴</nav><article>
<h1>가을 니트 스타일링 5가지</h1>
<p>올가을 니트는 어깨선이 살짝 떨어지는 루즈핏이 대세입니다. 첫 번째 팁, 와이드 슬랙스와 매치하면 편안하면서도 단정해 보여요.</p>
<img src="https://cdn.attrangs.co.kr/mag/look1.jpg" alt="룩1" />
<p>테스트 상품 100001 은 소매가 길어 손등을 살짝 덮는 디자인이라 가을 감성에 딱 맞아요. <a href="https://attrangs.co.kr/shop/view.php?index_no=100001">상품 보기</a></p>
<p>두 번째 팁, 톤온톤 컬러로 맞추면 키가 커 보이는 효과가 있습니다. <a href="/shop/view.php?index_no=100002">니트 원피스</a></p>
<p>"올해는 미니멀보다 포근함이 키워드" 라고 에디터는 말합니다.</p>
</article><footer>회사 정보</footer></body></html>`;

const RSS = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
<item><title>한강 불꽃축제</title><ht:approx_traffic>200,000+</ht:approx_traffic><link>https://trends.google.com/x</link><ht:news_item_title>불꽃축제 명당</ht:news_item_title><ht:news_item_url>https://news.example/1</ht:news_item_url><pubDate>Sat, 05 Sep 2026 00:00:00 -0700</pubDate></item>
<item><title><![CDATA[가을 니트 코디]]></title><ht:approx_traffic>50,000+</ht:approx_traffic></item>
<item><title></title></item>
</channel></rss>`;

async function pairDevice(t: T, user: Awaited<ReturnType<typeof signup>>) {
  const { code } = await user.as.mutation(api.devices.createPairCode, {});
  return await t.mutation(api.devices.pair, { code, deviceName: "PC", platform: "linux", appVersion: "0.1.13" });
}
const authed = (token: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" } });
const REVIEW_CHECKLIST = { productFacts: true, adDisclosure: true, mediaRightsAndFit: true, finalCopy: true } as const;

async function setup() {
  const t = makeT();
  const owner = await signup(t, "owner@automoney.test");
  await setRole(t, owner.userId, "SUPER_ADMIN");
  const p1 = await seedProduct(t, 100001);
  const p2 = await seedProduct(t, 100002);
  return { t, owner, p1, p2 };
}

describe("magazines", () => {
  it("registers from HTML: extracts atoms, images and matches products by index_no; re-register replaces", async () => {
    const { t, owner, p1, p2 } = await setup();
    const user = await signup(t, "u1@test.com");
    await expect(user.as.action(api.magazines.register, { html: MAG_HTML })).rejects.toThrow(/권한/);
    const r = await owner.as.action(api.magazines.register, { html: MAG_HTML, url: "https://attrangs.co.kr/magazine/1" });
    expect(r.productCount).toBe(2);
    expect(r.atomCount).toBeGreaterThanOrEqual(3);
    const m = await user.as.query(api.magazines.get, { magazineId: r.magazineId });
    expect(m?.title).toBe("가을 니트 스타일링 5가지");
    expect(m?.imageUrls).toContain("https://cdn.attrangs.co.kr/mag/look1.jpg");
    expect(m?.products.map((p) => p._id).sort()).toEqual([p1, p2].sort());
    expect(m?.atoms.some((a) => a.atomType === "PRODUCT_POINT" && a.attrangsProductId === 100001)).toBe(true);
    expect(m?.atoms.some((a) => a.atomType === "QUOTE")).toBe(true);
    // 같은 URL 재등록 → 교체(목록 1개)
    const r2 = await owner.as.action(api.magazines.register, { html: MAG_HTML, url: "https://attrangs.co.kr/magazine/1" });
    expect(r2.magazineId).toBe(r.magazineId);
    expect((await user.as.query(api.magazines.list, {})).length).toBe(1);
    await expect(owner.as.action(api.magazines.register, { html: "<html><body><p>짧음</p></body></html>" })).rejects.toThrow();
  });

  it("builds OUTFIT curation sets from magazine theme + product roles, and replaces them on re-register", async () => {
    const { t, owner, p1 } = await setup();
    const user = await signup(t, "u2@test.com");
    // 100002 를 아우터로 바꿔 원피스+아우터 조합이 성립하게 한다
    const p2 = await t.run(async (ctx) => {
      const row = (await ctx.db.query("products").withIndex("by_attrangsProductId", (q) => q.eq("attrangsProductId", 100002)).unique())!;
      await ctx.db.patch(row._id, { name: "트위드 크롭 자켓", category: "아우터" });
      return row._id;
    });
    const html = MAG_HTML.replace("가을 니트 스타일링 5가지", "가을 하객룩 5가지").replace("올가을 니트는", "결혼식 하객룩으로 올가을 니트는");
    const r = await owner.as.action(api.magazines.register, { html, url: "https://attrangs.co.kr/magazine/outfit" });
    expect(r.outfitCount).toBeGreaterThanOrEqual(1);
    const items = await user.as.query(api.curation.list, { kind: "OUTFIT" });
    expect(items.length).toBe(r.outfitCount);
    const set = items[0]!;
    expect(set.title).toMatch(/하객룩 코디 · /);
    expect(set.body).toMatch(/합계: [\d,]+원/);
    expect(set.body).toContain("스타일링:");
    expect(set.magazineId).toBe(r.magazineId);
    expect(set.productIds!.sort()).toEqual([p1, p2].sort());
    expect(set.licenseNote).toMatch(/상품 링크만/);
    // 재등록해도 dedupeKey 로 갱신만 (중복 없음)
    const r2 = await owner.as.action(api.magazines.register, { html, url: "https://attrangs.co.kr/magazine/outfit" });
    expect(r2.outfitCount).toBe(r.outfitCount);
    expect((await user.as.query(api.curation.list, { kind: "OUTFIT" })).length).toBe(r.outfitCount);
  });
});

describe("content generation gate", () => {
  it("keeps authoring media limits aligned with the selected channel", async () => {
    const { owner } = await setup();
    const blogImages = Array.from({ length: 30 }, (_, index) => `https://cdn.example.com/blog-${index}.jpg`);
    const created = await owner.as.mutation(api.content.createManual, {
      channel: "BLOG",
      caption: "가을 스타일링 자료를 정리했습니다.",
      hashtags: ["광고", "가을코디"],
      mediaUrls: blogImages,
    });
    expect(created.pieceId).toBeTruthy();
    await owner.as.mutation(api.content.edit, {
      pieceId: created.pieceId,
      caption: "가을 스타일링 자료 30장을 정리했습니다.",
      hashtags: ["광고", "가을코디"],
      mediaUrls: blogImages,
    });
    await expect(owner.as.mutation(api.content.createManual, {
      channel: "BLOG",
      caption: "이미지가 너무 많은 글",
      hashtags: ["광고"],
      mediaUrls: [...blogImages, "https://cdn.example.com/blog-30.jpg"],
    })).rejects.toThrow(/최대 30개/);
  });

  it("quarantines legacy automated pieces without a V2 run even for super admins", async () => {
    const { t, owner, p1 } = await setup();
    const legacyPieceId = await t.run((ctx) => ctx.db.insert("contentPieces", {
      ownerUserId: owner.userId,
      visibility: "PRIVATE",
      productId: p1,
      channel: "THREADS",
      caption: "이전 자동 생성 콘텐츠",
      hashtags: ["광고"],
      mediaUrls: [],
      qualityScore: 100,
      qualityReport: { violations: [], fixed: [] },
      status: "APPROVED",
      generatedBy: "codex",
      usageCount: 0,
      createdAt: Date.now(),
    }));
    await expect(owner.as.mutation(api.content.setVisibility, { pieceId: legacyPieceId, visibility: "SHARED" }))
      .rejects.toThrow(/콘텐츠 공급실|컬렉션/);
    await expect(owner.as.mutation(api.content.edit, {
      pieceId: legacyPieceId,
      caption: "편집으로 출처를 세탁하면 안 되는 이전 자동 생성 콘텐츠",
      hashtags: ["광고"],
      mediaUrls: [],
    })).rejects.toThrow(/이전 품질 계약/);
    await expect(t.run((ctx) => consumePiece(ctx, owner.userId, legacyPieceId)))
      .rejects.toThrow(/이전 품질 계약/);
    await t.run((ctx) => ctx.db.patch(legacyPieceId, { status: "DRAFT" }));
    await expect(owner.as.mutation(api.content.approve, { pieceId: legacyPieceId }))
      .rejects.toThrow(/이전 품질 계약/);
  });

  it("binds shared manual pieces to their exact revision and unshares every edit", async () => {
    const { t, owner } = await setup();
    const viewer = await signup(t, "shared-manual-viewer@test.com");
    const { deviceToken } = await pairDevice(t, viewer);
    const createdSpace = await viewer.as.mutation(api.spaces.create, { platform: "THREADS", name: "공유 콘텐츠 게시", handle: "shared_manual" });
    await t.run(async (ctx) => {
      await ctx.db.patch(createdSpace.spaceId, { sessionState: "HEALTHY", handle: "shared_manual" });
      await ctx.db.patch(createdSpace.jobId, { status: "SUCCEEDED", finishedAt: Date.now(), updatedAt: Date.now() });
    });

    const material = await owner.as.mutation(api.adminContent.createMaterial, {
      kind: "TEXT",
      title: "공유 수동 콘텐츠 근거",
      bodyText: "가을 원피스 운영 문구 근거",
      rightsStatus: "OWNED",
      rightsNote: "운영사 자체 작성",
    });
    await owner.as.mutation(api.adminContent.markMaterialReady, { materialId: material.materialId });
    const collection = await owner.as.mutation(api.adminContent.createCollection, {
      title: "공유 수동 콘텐츠",
      tags: ["가을"],
      sourceMaterialIds: [material.materialId],
    });
    const manual = await owner.as.mutation(api.adminContent.addManualPiece, {
      collectionId: collection.collectionId,
      sourceMaterialIds: [material.materialId],
      channel: "THREADS",
      caption: "가을 원피스로 완성하는 데일리 코디가 궁금하다면? 소재와 핏 정보를 상품 링크에서 자세히 확인해 보세요.",
      hashtags: ["광고", "데일리룩", "원피스"],
    });
    await owner.as.mutation(api.adminContent.submitCollection, { collectionId: collection.collectionId });
    await owner.as.mutation(api.content.approve, { pieceId: manual.pieceId, expectedOutputHash: manual.outputHash, reviewChecklist: REVIEW_CHECKLIST });
    await owner.as.mutation(api.adminContent.publishCollection, { collectionId: collection.collectionId });
    expect((await viewer.as.query(api.content.listLibrary, {})).map((piece) => piece._id)).toContain(manual.pieceId);

    await expect(viewer.as.mutation(api.jobs.enqueuePublish, {
      spaceId: createdSpace.spaceId,
      pieceId: manual.pieceId,
      text: "공유 조각과 무관한 본문",
      mediaUrls: [],
    })).rejects.toThrow(/승인된 revision/);
    await expect(viewer.as.mutation(api.schedules.upsert, {
      spaceId: createdSpace.spaceId,
      kind: "DAILY",
      timeOfDay: "10:00",
      daysOfWeek: [],
      jitterMinutes: 0,
      pieceId: manual.pieceId,
      text: "공유 조각과 무관한 예약 본문",
      mediaUrls: [],
      autoApprove: false,
    })).rejects.toThrow(/승인된 revision/);

    const publishJobId = await viewer.as.mutation(api.jobs.enqueuePublish, {
      spaceId: createdSpace.spaceId,
      pieceId: manual.pieceId,
      text: "",
      mediaUrls: [],
    });
    const schedule = await viewer.as.mutation(api.schedules.upsert, {
      spaceId: createdSpace.spaceId,
      kind: "DAILY",
      timeOfDay: "10:00",
      daysOfWeek: [],
      jitterMinutes: 0,
      pieceId: manual.pieceId,
      text: "",
      mediaUrls: [],
      autoApprove: false,
    });
    const storedJob = await t.run((ctx) => ctx.db.get(publishJobId));
    expect((storedJob!.payload as { pieceOutputHash?: string }).pieceOutputHash).toMatch(/^[a-f0-9]{64}$/);
    expect((storedJob!.payload as { pieceSnapshotHash?: string }).pieceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);

    const edited = await owner.as.mutation(api.content.edit, {
      pieceId: manual.pieceId,
      caption: "수정된 가을 원피스 코디입니다. 소재와 핏 정보는 상품 링크에서 자세히 확인해 보세요.",
      hashtags: ["광고", "데일리룩", "원피스"],
      mediaUrls: [],
    });
    expect(edited.status).toBe("DRAFT");
    const revised = await owner.as.query(api.content.getPiece, { pieceId: manual.pieceId });
    expect(revised).toMatchObject({ visibility: "PRIVATE", status: "DRAFT" });
    expect((await viewer.as.query(api.content.listLibrary, {})).map((piece) => piece._id)).not.toContain(manual.pieceId);
    await expect(t.run((ctx) => consumePiece(ctx, viewer.userId, manual.pieceId))).rejects.toThrow(/접근|찾을/);

    await owner.as.mutation(api.adminContent.submitCollection, { collectionId: collection.collectionId });
    await owner.as.mutation(api.content.approve, { pieceId: manual.pieceId, expectedOutputHash: revised.productionMeta.outputHash, reviewChecklist: REVIEW_CHECKLIST });
    await owner.as.mutation(api.adminContent.publishCollection, { collectionId: collection.collectionId });
    const due = (await t.run((ctx) => ctx.db.get(schedule.scheduleId)))!.nextRunAt!;
    expect(await t.mutation(internal.schedules.tick, { now: due + 1 })).toMatchObject({ created: 0, skipped: 1 });
    expect((await viewer.as.query(api.schedules.listMine, {}))[0]).toMatchObject({ lastSkipReason: "CONTENT_REVISION_CHANGED" });

    await viewer.as.mutation(api.jobs.approve, { jobId: publishJobId });
    const claim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    expect(claim.id).toBe(publishJobId);
    const preflight = await t.fetch(`/agent/jobs/${publishJobId}/preflight`, authed(deviceToken, {
      method: "POST",
      body: JSON.stringify({ attemptNo: claim.attemptNo, leaseToken: claim.leaseToken }),
    }));
    expect(preflight.status).toBe(409);
    expect((await preflight.json()).error.code).toBe("CONTENT_REVISION_CHANGED");
  });

  it("uses an exact frozen standard and blocks unknown contract versions", () => {
    const frozen = frozenProductionStandard({
      ...DEFAULT_CONTENT_STANDARD,
      minScore: 99,
      maxEmoji: 1,
      forbiddenPhrases: [...DEFAULT_CONTENT_STANDARD.forbiddenPhrases, "테스트 금칙어"],
    });
    expect(frozen).toMatchObject({ minScore: 99, maxEmoji: 1 });
    expect(frozen.forbiddenPhrases).toContain("테스트 금칙어");
    expect(() => frozenProductionStandard({
      ...DEFAULT_CONTENT_STANDARD,
      qualityVersion: "content-quality/999.0.0",
    })).toThrow(/지원하지 않는/);
  });

  it("queues one generation job per selected product in a batch", async () => {
    const { t, owner, p1, p2 } = await setup();
    await pairDevice(t, owner);
    const result = await owner.as.mutation(api.content.requestGenerateBatch, {
      productIds: [p1, p2],
      channels: ["THREADS", "INSTAGRAM_FEED"],
    });
    expect(result.total).toBe(2);
    expect(result.jobIds).toHaveLength(2);
    expect(result.runId).toBeTruthy();
    const jobs = await owner.as.query(api.jobs.listMine, { limit: 10 });
    expect(jobs.filter((job) => result.jobIds.includes(job._id))).toHaveLength(2);
    expect(jobs.find((job) => job._id === result.jobIds[0])?.contentProduct?.attrangsProductId).toBe(100001);
    const run = await owner.as.query(api.content.getRun, { runId: result.runId });
    expect(run).toMatchObject({
      productIds: [p1, p2],
      channels: ["THREADS", "INSTAGRAM_FEED"],
      jobIds: result.jobIds,
      expectedOutputs: 4,
      completedJobs: 0,
      savedOutputs: 0,
      approvedOutputs: 0,
      status: "QUEUED",
    });
    expect(run.productSnapshots).toHaveLength(2);
    expect(run.productSnapshots[0]).toMatchObject({ productId: p1, attrangsProductId: 100001 });
    expect(run.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await owner.as.query(api.content.listRuns, {})).map((item) => item._id)).toContain(result.runId);
    await expect(owner.as.mutation(api.content.requestGenerateBatch, { productIds: [], channels: ["THREADS"] })).rejects.toThrow(/하나 이상/);
    await expect(owner.as.mutation(api.content.requestGenerateBatch, { productIds: Array(11).fill(p1), channels: ["THREADS"] })).rejects.toThrow(/최대 10개/);
  });

  it("deduplicates a retried batch request by client request id", async () => {
    const { t, owner, p1 } = await setup();
    await pairDevice(t, owner);
    const input = {
      productIds: [p1],
      channels: ["THREADS" as const],
      clientRequestId: "request_retry_1234",
    };
    const first = await owner.as.mutation(api.content.requestGenerateBatch, input);
    const second = await owner.as.mutation(api.content.requestGenerateBatch, input);
    expect(second).toEqual(first);
    await expect(owner.as.mutation(api.content.requestGenerateBatch, { ...input, channels: ["X"] })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    const runs = await owner.as.query(api.content.listRuns, {});
    expect(runs.filter((run) => run._id === first.runId)).toHaveLength(1);
    const jobs = await owner.as.query(api.jobs.listMine, { limit: 10 });
    expect(jobs.filter((job) => first.jobIds.includes(job._id))).toHaveLength(1);
  });

  it("freezes the production standard and keeps template output in review", async () => {
    const { t, owner, p1 } = await setup();
    await setRole(t, owner.userId, "USER");
    const { deviceToken } = await pairDevice(t, owner);
    const result = await owner.as.mutation(api.content.requestGenerateBatch, {
      productIds: [p1],
      channels: ["THREADS"],
      brief: {
        goal: "CONVERSION",
        tone: "CHANNEL_NATIVE",
        cta: "LINK",
        audience: "출근룩을 찾는 20~30대 여성",
        keyMessage: "가격과 코디 포인트를 구체적으로 안내",
      },
      // Client input may tighten the policy, but must not weaken the server baseline.
      standard: {
        id: "client-standard",
        version: "1",
        name: "약한 클라이언트 기준",
        brand: "다른 브랜드",
        minScore: 0,
        requireCodex: false,
        maxAttempts: 5,
        maxEmoji: 10,
        forbiddenPhrases: [],
        workflowVersion: "forged",
        promptVersion: "forged",
        qualityVersion: "forged",
      },
    });
    const queued = await owner.as.query(api.content.getRun, { runId: result.runId });
    expect(queued.briefSnapshot).toMatchObject({ goal: "CONVERSION", cta: "LINK" });
    expect(queued.standardSnapshot).toMatchObject({
      id: "ATTRANGS_STANDARD_KO_V2",
      version: "2.0.0",
      name: "아뜨랑스 기본 콘텐츠 기준",
      brand: "아뜨랑스",
      minScore: 92,
      requireCodex: true,
      maxAttempts: 3,
      maxEmoji: 2,
    });
    expect(queued.standardSnapshot.workflowVersion).not.toBe("forged");
    expect(queued.standardSnapshot.forbiddenPhrases.length).toBeGreaterThan(0);

    const claimed = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(claimed.data.payload.runId).toBe(result.runId);
    expect(claimed.data.payload.brief.goal).toBe("CONVERSION");
    const completed = await t.fetch(`/agent/jobs/${claimed.data.id}/complete`, authed(deviceToken, {
      method: "POST",
      body: JSON.stringify({
        status: "SUCCEEDED",
        result: {
          schema: "automoney.job-result/v1",
          kind: "ok",
          data: {
            generatedBy: "codex",
            pieces: [{
              channel: "THREADS",
              caption: "가을 니트가 궁금하다면?\n가격과 코디 포인트를 링크에서 확인해 보세요",
              hashtags: ["광고", "니트", "가을코디"],
              generatedBy: "template",
              attemptNo: 2,
            }],
          },
        },
      }),
    }));
    expect(completed.status).toBe(200);
    const piece = (await owner.as.query(api.content.listLibrary, {}))[0]!;
    expect(piece).toMatchObject({
      runId: result.runId,
      generatedBy: "template",
      status: "DRAFT",
      productionMeta: {
        provider: "template",
        attemptNo: 2,
        inputHash: queued.inputHash,
        desktopVersion: "0.1.13",
        provenanceComplete: true,
      },
    });
    expect(piece.productionMeta.jobInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(piece.productionMeta.outputHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(owner.as.mutation(api.content.approve, { pieceId: piece._id }))
      .rejects.toThrow(/제작 기준/);
    await setRole(t, owner.userId, "SUPER_ADMIN");
    await expect(owner.as.mutation(api.content.approve, { pieceId: piece._id }))
      .rejects.toThrow(/제작 기준/);
    expect((await owner.as.query(api.content.getPiece, { pieceId: piece._id })).status).toBe("DRAFT");
    const run = await owner.as.query(api.content.getRun, { runId: result.runId });
    expect(run).toMatchObject({
      completedJobs: 1,
      savedOutputs: 1,
      approvedOutputs: 0,
      expectedOutputs: 1,
      status: "REVIEW_REQUIRED",
    });
  });

  it("rejects V2 requests from an outdated desktop and never trusts legacy job-level provenance", async () => {
    const { t, owner, p1 } = await setup();
    const { code } = await owner.as.mutation(api.devices.createPairCode, {});
    await t.mutation(api.devices.pair, { code, deviceName: "Old PC", platform: "linux", appVersion: "0.1.10" });
    await expect(owner.as.mutation(api.content.requestGenerateBatch, {
      productIds: [p1],
      channels: ["THREADS"],
    })).rejects.toThrow(/0\.1\.11/);

    const { code: replacementCode } = await owner.as.mutation(api.devices.createPairCode, {});
    const { deviceToken } = await t.mutation(api.devices.pair, {
      code: replacementCode,
      deviceName: "Current PC",
      platform: "linux",
      appVersion: "0.1.11",
    });
    const requested = await owner.as.mutation(api.content.requestGenerateBatch, {
      productIds: [p1],
      channels: ["THREADS"],
    });
    await t.run((ctx) => ctx.db.patch(p1, { imageUrls: ["https://cdn.example.com/changed-after-run.jpg"] }));
    const blockedClaim = await (await t.fetch("/agent/claim", authed(deviceToken, {
      method: "POST",
      body: JSON.stringify({ appVersion: "0.1.10" }),
    }))).json();
    expect(blockedClaim.data).toBeNull();
    const claimed = await (await t.fetch("/agent/claim", authed(deviceToken, {
      method: "POST",
      body: JSON.stringify({ appVersion: "0.1.11" }),
    }))).json();
    await t.fetch(`/agent/jobs/${claimed.data.id}/complete`, authed(deviceToken, {
      method: "POST",
      body: JSON.stringify({
        status: "SUCCEEDED",
        result: {
          data: {
            generatedBy: "codex",
            pieces: [{
              channel: "THREADS",
              caption: "테스트 상품 100001 원피스로 완성하는 가을 코디를 상품 링크에서 자세히 확인해 보세요.",
              hashtags: ["광고", "원피스"],
            }],
          },
        },
      }),
    }));
    const [piece] = await owner.as.query(api.content.listRunPieces, { runId: requested.runId });
    expect(piece).toMatchObject({
      status: "DRAFT",
      generatedBy: "template",
      mediaUrls: [],
      productionMeta: { provenanceComplete: false, standardPassed: false },
    });
    expect(piece!.qualityReport.violations.map((violation: { code: string }) => violation.code)).toContain("PROVENANCE_MISSING");
    await expect(owner.as.mutation(api.content.approve, { pieceId: piece!._id })).rejects.toThrow(/제작 기준/);
  });

  it("completes a run only when every expected output passes the frozen standard", async () => {
    const { t, owner, p1 } = await setup();
    const { deviceToken } = await pairDevice(t, owner);
    const requested = await owner.as.mutation(api.content.requestGenerateBatch, {
      productIds: [p1],
      channels: ["THREADS"],
    });
    const claimed = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    const completed = await t.fetch(`/agent/jobs/${claimed.data.id}/complete`, authed(deviceToken, {
      method: "POST",
      body: JSON.stringify({
        status: "SUCCEEDED",
        result: {
          schema: "automoney.job-result/v1",
          kind: "ok",
          data: {
            generatedBy: "codex",
            pieces: [{
              channel: "THREADS",
              caption: "테스트 상품 100001 원피스로 완성하는 가을 코디가 궁금하다면?\n가격과 코디 포인트를 상품 링크에서 자세히 확인해 보세요.",
              hashtags: ["광고", "니트", "가을코디"],
              generatedBy: "codex",
              attemptNo: 1,
            }],
          },
        },
      }),
    }));
    expect(completed.status).toBe(200);
    expect(await owner.as.query(api.content.getRun, { runId: requested.runId })).toMatchObject({
      expectedOutputs: 1,
      completedJobs: 1,
      savedOutputs: 1,
      approvedOutputs: 0,
      status: "REVIEW_REQUIRED",
    });
    const [piece] = await owner.as.query(api.content.listRunPieces, { runId: requested.runId });
    expect(piece).toMatchObject({
      status: "DRAFT",
      mediaUrls: [],
      productionMeta: { standardPassed: true },
      productEvidence: { name: "테스트 상품 100001", frozen: true, source: "MOCK" },
    });
    await expect(owner.as.mutation(api.content.approve, { pieceId: piece!._id, expectedOutputHash: "stale-review" }))
      .rejects.toThrow(/변경/);
    await expect(owner.as.mutation(api.content.approve, { pieceId: piece!._id, expectedOutputHash: piece!.productionMeta.outputHash }))
      .rejects.toThrow(/모두 확인/);
    await owner.as.mutation(api.content.approve, { pieceId: piece!._id, expectedOutputHash: piece!.productionMeta.outputHash, reviewChecklist: REVIEW_CHECKLIST });
    const reviewEvents = await t.run((ctx) => ctx.db
      .query("contentReviewEvents")
      .withIndex("by_piece", (q) => q.eq("pieceId", piece!._id))
      .collect());
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0]).toMatchObject({
      action: "APPROVED",
      outputHash: piece!.productionMeta.outputHash,
      reviewChecklist: REVIEW_CHECKLIST,
      snapshot: { caption: piece!.caption, channel: "THREADS" },
    });
    expect(await owner.as.query(api.content.getRun, { runId: requested.runId })).toMatchObject({
      expectedOutputs: 1,
      completedJobs: 1,
      savedOutputs: 1,
      approvedOutputs: 1,
      status: "COMPLETED",
    });
  });

  it("requires a paired device, enqueues content.generate, ingests results with quality gate and honors visibility", async () => {
    const { t, owner, p1, p2 } = await setup();
    const user = await signup(t, "gen@test.com");
    const other = await signup(t, "other@test.com");
    const { magazineId } = await owner.as.action(api.magazines.register, { html: MAG_HTML });
    await expect(user.as.mutation(api.content.requestGenerate, { magazineId, channels: ["THREADS"] })).rejects.toThrow(/페어링/);
    const { deviceToken } = await pairDevice(t, user);
    const jobId = await user.as.mutation(api.content.requestGenerate, { magazineId, productId: p1, channels: ["THREADS", "X"] });
    const claimed = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(claimed.data.id).toBe(jobId);
    expect(claimed.data.jobType).toBe("content.generate");
    expect(claimed.data.payload.channels).toEqual(["THREADS", "X"]);
    expect(claimed.data.payload.products[0].attrangsProductId).toBe(100001);
    expect(claimed.data.payload.atoms.length).toBeGreaterThan(0);

    const pieces = [
      { channel: "THREADS", caption: "테스트 상품 100001 원피스로 완성하는 가을 코디.\n와이드 슬랙스와 매치하면 단정한 분위기를 연출할 수 있어요. 상품 링크에서 자세히 확인하세요.", hashtags: ["가을코디", "니트", "광고"], generatedBy: "codex", attemptNo: 1, mediaUrls: [] },
      { channel: "X", caption: "테스트 상품 100001 최저가 보장! 직접 입어봤는데 100% 만족", hashtags: ["광고"], generatedBy: "codex", attemptNo: 1, mediaUrls: [] },
      { channel: "NOPE", caption: "x", hashtags: [], mediaUrls: [] },
    ];
    const done = await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok", data: { pieces, generatedBy: "codex" } } }) }));
    expect(done.status).toBe(200);
    const lib = await user.as.query(api.content.listLibrary, {});
    expect(lib.length).toBe(2);
    const threads = lib.find((p) => p.channel === "THREADS")!;
    const x = lib.find((p) => p.channel === "X")!;
    expect(threads).toMatchObject({ status: "DRAFT", productionMeta: { standardPassed: true } });
    expect(threads.hashtags).toContain("광고");
    expect(x.status).toBe("DRAFT");
    expect(x.qualityScore).toBeLessThan(90);
    // 금칙 위반 조각은 유저가 승인 불가, 수정 후 승인 가능
    await expect(user.as.mutation(api.content.approve, { pieceId: x._id })).rejects.toThrow(/금칙/);
    await user.as.mutation(api.content.edit, { pieceId: x._id, caption: "테스트 상품 100001 원피스 셀렉션을 상품 링크에서 자세히 확인하세요", hashtags: ["광고", "니트"] });
    const editedX = await user.as.query(api.content.getPiece, { pieceId: x._id });
    expect(editedX.status).toBe("DRAFT");
    await user.as.mutation(api.content.approve, { pieceId: x._id, expectedOutputHash: editedX.productionMeta.outputHash, reviewChecklist: REVIEW_CHECKLIST });
    expect((await user.as.query(api.content.getPiece, { pieceId: x._id })).status).toBe("APPROVED");
    await user.as.mutation(api.content.approve, { pieceId: threads._id, expectedOutputHash: threads.productionMeta.outputHash, reviewChecklist: REVIEW_CHECKLIST });
    expect(await user.as.query(api.content.getRun, { runId: threads.runId! })).toMatchObject({ status: "COMPLETED", approvedOutputs: 2 });
    // 중복 ingest 방지
    expect(await t.mutation(internal.content.ingestGenerated, { jobId })).toMatchObject({ saved: 0, duplicate: true });

    // 가시성: 개인 생성물은 PRIVATE이며 전역 공급은 자료 컬렉션 경로로만 가능하다.
    expect((await other.as.query(api.content.listLibrary, {})).length).toBe(0);
    await expect(other.as.query(api.content.getPiece, { pieceId: threads._id })).rejects.toThrow();
    await expect(user.as.mutation(api.content.setVisibility, { pieceId: threads._id, visibility: "SHARED" })).rejects.toThrow(/권한/);
    await expect(owner.as.mutation(api.content.setVisibility, { pieceId: threads._id, visibility: "SHARED" })).rejects.toThrow(/콘텐츠 공급실|컬렉션/);
    expect((await other.as.query(api.content.listLibrary, {})).length).toBe(0);

    const manual = await other.as.mutation(api.content.createManual, {
      channel: "X",
      caption: "최저가 100% 보장",
      hashtags: ["광고"],
      mediaUrls: [],
    });
    expect(manual.status).toBe("DRAFT");
    await expect(owner.as.mutation(api.content.approve, { pieceId: manual.pieceId })).rejects.toThrow(/금칙/);
    const shortForm = await other.as.mutation(api.content.createManual, {
      channel: "INSTAGRAM_REEL",
      caption: "테스트 상품 100001 스타일을 상품 링크에서 확인하세요",
      hashtags: ["광고", "데일리룩"],
      script: "0-3초 상품 소개 장면\n3-7초 스타일 포인트 장면\n7-12초 상품 링크 확인 장면",
      mediaUrls: ["https://cdn.example.com/product.jpg"],
    });
    expect(shortForm.status).toBe("DRAFT");
    await expect(other.as.mutation(api.content.approve, { pieceId: shortForm.pieceId })).rejects.toThrow(/미디어 요건/);
    await expect(other.as.mutation(api.content.createManual, {
      channel: "THREADS",
      caption: "   ",
      hashtags: [],
      mediaUrls: [],
    })).rejects.toThrow(/본문/);
    await expect(other.as.mutation(api.content.createManual, {
      channel: "X",
      caption: "안전한 링크에서 확인하세요",
      hashtags: ["광고"],
      mediaUrls: ["http://insecure.example/image.jpg"],
    })).rejects.toThrow(/HTTPS/);

    // 거절 → RETIRED + 사유 기록
    await expect(user.as.mutation(api.content.reject, { pieceId: x._id, reason: "   " })).rejects.toThrow(/사유/);
    await user.as.mutation(api.content.reject, { pieceId: x._id, reason: "톤이 안 맞음" });
    await expect(user.as.mutation(api.content.reject, { pieceId: x._id, reason: "중복" })).rejects.toThrow(/이미 폐기/);
    expect((await user.as.query(api.content.listLibrary, {})).some((p) => p._id === x._id)).toBe(false);
    const stats = await owner.as.query(api.content.rejectionStats, {});
    expect(stats.total).toBe(1);
    expect(await user.as.query(api.content.getRun, { runId: threads.runId! })).toMatchObject({ status: "REVIEW_REQUIRED", approvedOutputs: 1 });
    await expect(user.as.mutation(api.content.approve, { pieceId: x._id, expectedOutputHash: x.productionMeta.outputHash, reviewChecklist: REVIEW_CHECKLIST }))
      .rejects.toThrow(/초안만 승인/);
    // 폐기 결과를 되살리려면 수정으로 새 revision을 만든 뒤 다시 검토해야 한다.
    const rejectedX = await user.as.query(api.content.getPiece, { pieceId: x._id });
    await user.as.mutation(api.content.edit, {
      pieceId: x._id,
      caption: rejectedX.caption,
      hashtags: rejectedX.hashtags,
      script: rejectedX.script ?? undefined,
      mediaUrls: rejectedX.mediaUrls,
    });
    const revisedX = await user.as.query(api.content.getPiece, { pieceId: x._id });
    await user.as.mutation(api.content.approve, { pieceId: x._id, expectedOutputHash: revisedX.productionMeta.outputHash, reviewChecklist: REVIEW_CHECKLIST });

    // 공급실에서 검수·공개한 조각을 타 유저가 사용하고, 실제 게시 성공 때만 usageCount를 올린다.
    const supplyMaterial = await owner.as.mutation(api.adminContent.createMaterial, {
      kind: "TEXT",
      title: "게시 회귀 테스트 근거",
      bodyText: "테스트 상품 100001의 이름과 카탈로그 가격만 사용합니다.",
      productId: p1,
      rightsStatus: "OWNED",
      rightsNote: "운영사 테스트 원문",
    });
    await owner.as.mutation(api.adminContent.markMaterialReady, { materialId: supplyMaterial.materialId });
    const supplyCollection = await owner.as.mutation(api.adminContent.createCollection, {
      title: "게시 회귀 테스트 공급",
      tags: ["테스트"],
      sourceMaterialIds: [supplyMaterial.materialId],
    });
    const supplied = await owner.as.mutation(api.adminContent.addManualPiece, {
      collectionId: supplyCollection.collectionId,
      sourceMaterialIds: [supplyMaterial.materialId],
      productId: p1,
      channel: "THREADS",
      caption: threads.caption,
      hashtags: threads.hashtags,
    });
    await owner.as.mutation(api.adminContent.submitCollection, { collectionId: supplyCollection.collectionId });
    await owner.as.mutation(api.content.approve, {
      pieceId: supplied.pieceId,
      expectedOutputHash: supplied.outputHash,
      reviewChecklist: REVIEW_CHECKLIST,
    });
    await owner.as.mutation(api.adminContent.publishCollection, { collectionId: supplyCollection.collectionId });
    const supplyPieceId = supplied.pieceId;

    const { deviceToken: otherToken } = await pairDevice(t, other);
    const { spaceId, jobId: createJob } = await other.as.mutation(api.spaces.create, { platform: "THREADS", name: "메인" });
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "준비 전 게시", mediaUrls: [] })).rejects.toThrow(/정상 상태/);
    await t.fetch("/agent/claim", authed(otherToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(otherToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "demo" } }) }));
    const matchingLink = await other.as.action(api.links.issue, { productId: p1 });
    const mismatchedLink = await other.as.action(api.links.issue, { productId: p2 });
    const links = await other.as.query(api.links.listMine, {});
    const matchingLinkId = links.find((link) => link.shortCode === matchingLink.shortCode)!._id;
    const mismatchedLinkId = links.find((link) => link.shortCode === mismatchedLink.shortCode)!._id;
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "승인되지 않은 덮어쓰기", mediaUrls: [], pieceId: supplyPieceId, linkId: matchingLinkId })).rejects.toThrow(/승인된 revision/);
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: supplyPieceId, linkId: mismatchedLinkId })).rejects.toThrow(/상품.*일치/);
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "DISABLED" });
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: supplyPieceId, linkId: matchingLinkId })).rejects.toThrow(/활성 상태/);
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "ACTIVE" });
    const pubJob = await other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: supplyPieceId, linkId: matchingLinkId });
    const job = await t.run(async (ctx) => ctx.db.get(pubJob));
    expect((job!.payload as { text: string }).text).toContain("#광고");
    expect((job!.payload as { pieceId: string }).pieceId).toBe(supplyPieceId);
    expect((job!.payload as { pieceOutputHash: string }).pieceOutputHash).toMatch(/^[a-f0-9]{64}$/);
    expect((job!.payload as { pieceSnapshotHash: string }).pieceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await user.as.query(api.content.getPiece, { pieceId: supplyPieceId })).usageCount).toBe(0);
    await other.as.mutation(api.jobs.approve, { jobId: pubJob });
    const publishClaim = (await (await t.fetch("/agent/claim", authed(otherToken, { method: "POST", body: "{}" }))).json()).data;
    expect(publishClaim.id).toBe(pubJob);
    expect((await t.fetch(`/agent/jobs/${pubJob}/preflight`, authed(otherToken, { method: "POST", body: JSON.stringify({ attemptNo: publishClaim.attemptNo, leaseToken: publishClaim.leaseToken }) }))).status).toBe(200);
    expect((await t.fetch(`/agent/jobs/${pubJob}/publish-attempt`, authed(otherToken, { method: "POST", body: JSON.stringify({ attemptNo: publishClaim.attemptNo, leaseToken: publishClaim.leaseToken }) }))).status).toBe(200);
    await t.fetch(`/agent/jobs/${pubJob}/complete`, authed(otherToken, { method: "POST", body: JSON.stringify({ attemptNo: publishClaim.attemptNo, leaseToken: publishClaim.leaseToken, status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok", data: { postUrl: "https://threads.net/@demo/post/1" } } }) }));
    expect((await user.as.query(api.content.getPiece, { pieceId: supplyPieceId })).usageCount).toBe(1);

    // 이미 큐잉된 작업도 실행 직전에 현재 상품 상태를 다시 확인한다.
    const inactiveProductJob = await other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: supplyPieceId, linkId: matchingLinkId });
    await other.as.mutation(api.jobs.approve, { jobId: inactiveProductJob });
    const inactiveClaim = (await (await t.fetch("/agent/claim", authed(otherToken, { method: "POST", body: "{}" }))).json()).data;
    await t.run((ctx) => ctx.db.patch(p1, { status: "INACTIVE" }));
    const inactivePreflight = await t.fetch(`/agent/jobs/${inactiveProductJob}/preflight`, authed(otherToken, { method: "POST", body: JSON.stringify(inactiveClaim) }));
    expect(inactivePreflight.status).toBe(409);
    expect((await inactivePreflight.json()).error.code).toBe("CONTENT_PRODUCT_INACTIVE");
    await t.run((ctx) => ctx.db.patch(p1, { status: "ACTIVE" }));
    await t.run(async (ctx) => {
      const reservations = await ctx.db.query("publishReservations").collect();
      for (const reservation of reservations) {
        if (reservation.state === "COMMITTED") await ctx.db.patch(reservation._id, { committedAt: Date.now() - 16 * 60_000 });
      }
    });
    expect((await t.fetch(`/agent/jobs/${inactiveProductJob}/preflight`, authed(otherToken, { method: "POST", body: JSON.stringify(inactiveClaim) }))).status).toBe(200);
    await t.run((ctx) => ctx.db.patch(p1, { status: "INACTIVE" }));
    expect(await t.run(async (ctx) => validatePublishAttemptPolicy(ctx, (await ctx.db.get(inactiveProductJob))!, Date.now())))
      .toEqual({ ok: false, reason: "CONTENT_PRODUCT_INACTIVE" });
    const inactiveAttempt = await t.fetch(`/agent/jobs/${inactiveProductJob}/publish-attempt`, authed(otherToken, { method: "POST", body: JSON.stringify(inactiveClaim) }));
    expect(inactiveAttempt.status).toBe(409);
    expect((await inactiveAttempt.json()).error.code).toBe("CONFLICT");
    await t.run((ctx) => ctx.db.patch(p1, { status: "ACTIVE" }));
    await t.fetch(`/agent/jobs/${inactiveProductJob}/complete`, authed(otherToken, { method: "POST", body: JSON.stringify({ ...inactiveClaim, status: "FAILED", errorCode: "CONTENT_PRODUCT_INACTIVE" }) }));

    const instagram = await other.as.mutation(api.spaces.create, { platform: "INSTAGRAM", name: "인스타" });
    await t.run((ctx) => ctx.db.patch(instagram.spaceId, { sessionState: "HEALTHY", handle: "ig_demo" }));
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId: instagram.spaceId, text: "", mediaUrls: [], pieceId: supplyPieceId })).rejects.toThrow(/플랫폼/);
    const schedule = { kind: "DAILY" as const, timeOfDay: "10:00", daysOfWeek: [], jitterMinutes: 0, text: "", mediaUrls: [], autoApprove: false };
    await expect(other.as.mutation(api.schedules.upsert, { ...schedule, spaceId: instagram.spaceId, pieceId: supplyPieceId })).rejects.toThrow(/플랫폼/);
    await expect(other.as.mutation(api.schedules.upsert, { ...schedule, spaceId, pieceId: supplyPieceId, linkId: mismatchedLinkId })).rejects.toThrow(/상품.*일치/);
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "DISABLED" });
    await expect(other.as.mutation(api.schedules.upsert, { ...schedule, spaceId, pieceId: supplyPieceId, linkId: matchingLinkId })).rejects.toThrow(/활성 상태/);
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "ACTIVE" });
    const validSchedule = await other.as.mutation(api.schedules.upsert, { ...schedule, spaceId, pieceId: supplyPieceId, linkId: matchingLinkId });
    expect(await t.run(async (ctx) => ctx.db.get(validSchedule.scheduleId))).toMatchObject({ pieceOutputHash: (job!.payload as { pieceOutputHash: string }).pieceOutputHash });
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "DISABLED" });
    expect(await t.mutation(internal.schedules.tick, { now: validSchedule.nextRunAt! + 1 })).toMatchObject({ created: 0, skipped: 1 });
    expect((await other.as.query(api.schedules.listMine, {}))[0]?.lastSkipReason).toBe("LINK_INACTIVE");
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "ACTIVE" });
    await t.run(async (ctx) => ctx.db.patch(supplyPieceId, { caption: `${threads.caption} 변경됨` }));
    const revisedSchedule = (await other.as.query(api.schedules.listMine, {}))[0]!;
    expect(await t.mutation(internal.schedules.tick, { now: revisedSchedule.nextRunAt! + 1 })).toMatchObject({ created: 0, skipped: 1 });
    expect((await other.as.query(api.schedules.listMine, {}))[0]?.lastSkipReason).toBe("CONTENT_REVISION_CHANGED");
    await t.run((ctx) => ctx.db.patch(p1, { status: "INACTIVE" }));
    const inactiveProductSchedule = (await other.as.query(api.schedules.listMine, {}))[0]!;
    expect(await t.mutation(internal.schedules.tick, { now: inactiveProductSchedule.nextRunAt! + 1 })).toMatchObject({ created: 0, skipped: 1 });
    expect((await other.as.query(api.schedules.listMine, {}))[0]?.lastSkipReason).toBe("CONTENT_PRODUCT_INACTIVE");
    await t.run((ctx) => ctx.db.patch(p1, { status: "ACTIVE" }));
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: manual.pieceId })).rejects.toThrow();
    // 내 것도 SHARED 도 아닌 조각은 거부
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: x._id })).rejects.toThrow();
  });
});

describe("curation", () => {
  it("parses trends RSS, upserts with dedupe, builds product facts, reports provider status", async () => {
    const { t, owner, p1 } = await setup();
    const parsed = parseTrendsRss(RSS);
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toMatchObject({ title: "한강 불꽃축제", traffic: "200,000+", newsUrl: "https://news.example/1" });
    expect(parsed[1]!.title).toBe("가을 니트 코디");

    const r1 = await t.action(internal.curation.refreshTrends, { xml: RSS });
    expect(r1).toMatchObject({ inserted: 2, updated: 0, count: 2 });
    const r2 = await t.action(internal.curation.refreshTrends, { xml: RSS });
    expect(r2).toMatchObject({ inserted: 0, updated: 2 });
    const user = await signup(t, "c@test.com");
    await t.run((ctx) => ctx.db.patch(p1, { imageUrls: ["https://cdn.example.com/product.jpg"] }));
    const trends = await user.as.query(api.curation.list, { kind: "TREND" });
    expect(trends.map((x) => x.title)).toEqual(["한강 불꽃축제", "가을 니트 코디"]);

    const facts = await user.as.mutation(api.curation.buildProductFacts, { productId: p1 });
    expect(facts.inserted).toBe(4);
    const items = await user.as.query(api.curation.list, { productId: p1, kind: "PRODUCT_FACT" });
    expect(items[0]!.title).toMatch(/가격/);
    expect(items[0]!.body).toMatch(/35,000원/);
    expect(items.map((item) => item.body).join(" ")).not.toMatch(/자체제작|오늘출발|교환 무료/);

    await expect(user.as.mutation(api.curation.addManual, { kind: "MEME", title: "짤", licenseNote: "CC0" })).rejects.toThrow(/권한/);
    await owner.as.mutation(api.curation.addManual, { kind: "MEME", title: "월요병 짤", mediaUrl: "https://img.example/m.gif", licenseNote: "CC0 출처 example" });
    await expect(owner.as.mutation(api.curation.addManual, { kind: "MEME", title: "x", licenseNote: "  " })).rejects.toThrow(/라이선스/);
    expect((await user.as.query(api.curation.list, { kind: "MEME" })).length).toBe(1);

    // 검색 프로바이더 없음 → celebMatch 는 빈 결과(에러 아님)
    delete process.env.BRAVE_API_KEY;
    delete process.env.SERPAPI_KEY;
    expect(await user.as.action(api.curation.celebMatch, { productId: p1 })).toMatchObject({ provider: "none", found: 0 });
    expect(await owner.as.query(api.curation.providerStatus, {})).toMatchObject({ name: "none", available: false });
    // 상품 기준 생성 요청은 PRODUCT_FACT 를 원자로 보강한다
    await pairDevice(t, user);
    const jobId = await user.as.mutation(api.content.requestGenerate, { productId: p1, channels: ["BLOG"] });
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    const payload = job!.payload as { atoms: { atomType: string }[]; products: { name: string }[] };
    expect(payload.products[0]!.name).toBe("테스트 상품 100001");
    expect(payload.atoms.length).toBeGreaterThan(0);
    await t.run((ctx) => ctx.db.patch(jobId, { status: "SUCCEEDED", result: { data: { pieces: [{ channel: "BLOG", caption: "가을 상품을 링크에서 확인하세요", hashtags: ["광고"], script: null }], generatedBy: "template" } } }));
    expect(await t.mutation(internal.content.ingestGenerated, { jobId })).toMatchObject({ saved: 1 });
    expect((await user.as.query(api.content.listLibrary, {}))[0]?.mediaUrls).toEqual(["https://cdn.example.com/product.jpg"]);
  });
});
