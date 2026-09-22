import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
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
  return await t.mutation(api.devices.pair, { code, deviceName: "PC", platform: "linux", appVersion: "0.1.11" });
}
const authed = (token: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" } });

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
        desktopVersion: "0.1.11",
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
    expect(piece).toMatchObject({ status: "DRAFT", mediaUrls: [], productionMeta: { standardPassed: true } });
    await owner.as.mutation(api.content.approve, { pieceId: piece!._id });
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
    expect((await user.as.query(api.content.getPiece, { pieceId: x._id })).status).toBe("DRAFT");
    await user.as.mutation(api.content.approve, { pieceId: x._id });
    expect((await user.as.query(api.content.getPiece, { pieceId: x._id })).status).toBe("APPROVED");
    await user.as.mutation(api.content.approve, { pieceId: threads._id });
    expect(await user.as.query(api.content.getRun, { runId: threads.runId! })).toMatchObject({ status: "COMPLETED", approvedOutputs: 2 });
    // 중복 ingest 방지
    expect(await t.mutation(internal.content.ingestGenerated, { jobId })).toMatchObject({ saved: 0, duplicate: true });

    // 가시성: 타 유저는 PRIVATE 조각을 볼 수 없음. 수퍼어드민이 SHARED 로 바꾸면 보임
    expect((await other.as.query(api.content.listLibrary, {})).length).toBe(0);
    await expect(other.as.query(api.content.getPiece, { pieceId: threads._id })).rejects.toThrow();
    await expect(user.as.mutation(api.content.setVisibility, { pieceId: threads._id, visibility: "SHARED" })).rejects.toThrow(/권한/);
    await owner.as.mutation(api.content.setVisibility, { pieceId: threads._id, visibility: "SHARED" });
    const otherLib = await other.as.query(api.content.listLibrary, {});
    expect(otherLib.map((p) => p._id)).toEqual([threads._id]);
    const copied = await other.as.mutation(api.content.copyToMine, { pieceId: threads._id });
    const copiedPiece = await other.as.query(api.content.getPiece, { pieceId: copied.pieceId });
    expect(copiedPiece).toMatchObject({ mine: true, visibility: "PRIVATE", status: "APPROVED", generatedBy: "manual" });

    const manual = await other.as.mutation(api.content.createManual, {
      channel: "X",
      caption: "최저가 100% 보장",
      hashtags: ["광고"],
      mediaUrls: [],
    });
    expect(manual.status).toBe("DRAFT");
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
    await user.as.mutation(api.content.reject, { pieceId: x._id, reason: "톤이 안 맞음" });
    expect((await user.as.query(api.content.listLibrary, {})).some((p) => p._id === x._id)).toBe(false);
    const stats = await owner.as.query(api.content.rejectionStats, {});
    expect(stats.total).toBe(1);

    // pieceId 로 발행 잡 채우기(SHARED 조각을 타 유저가 사용, 실제 게시 성공 때만 usageCount 증가)
    const { deviceToken: otherToken } = await pairDevice(t, other);
    const { spaceId, jobId: createJob } = await other.as.mutation(api.spaces.create, { platform: "THREADS", name: "메인" });
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "준비 전 게시", mediaUrls: [] })).rejects.toThrow(/정상 상태/);
    await t.fetch("/agent/claim", authed(otherToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(otherToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY" } }) }));
    const matchingLink = await other.as.action(api.links.issue, { productId: p1 });
    const mismatchedLink = await other.as.action(api.links.issue, { productId: p2 });
    const links = await other.as.query(api.links.listMine, {});
    const matchingLinkId = links.find((link) => link.shortCode === matchingLink.shortCode)!._id;
    const mismatchedLinkId = links.find((link) => link.shortCode === mismatchedLink.shortCode)!._id;
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: threads._id, linkId: mismatchedLinkId })).rejects.toThrow(/상품.*일치/);
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "DISABLED" });
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: threads._id, linkId: matchingLinkId })).rejects.toThrow(/활성 상태/);
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "ACTIVE" });
    const pubJob = await other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: threads._id, linkId: matchingLinkId });
    const job = await t.run(async (ctx) => ctx.db.get(pubJob));
    expect((job!.payload as { text: string }).text).toContain("#광고");
    expect((job!.payload as { pieceId: string }).pieceId).toBe(threads._id);
    expect((await user.as.query(api.content.getPiece, { pieceId: threads._id })).usageCount).toBe(0);
    await other.as.mutation(api.jobs.approve, { jobId: pubJob });
    expect((await (await t.fetch("/agent/claim", authed(otherToken, { method: "POST", body: "{}" }))).json()).data.id).toBe(pubJob);
    await t.fetch(`/agent/jobs/${pubJob}/complete`, authed(otherToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok", data: { postUrl: "https://threads.net/@demo/post/1" } } }) }));
    expect((await user.as.query(api.content.getPiece, { pieceId: threads._id })).usageCount).toBe(1);
    const instagram = await other.as.mutation(api.spaces.create, { platform: "INSTAGRAM", name: "인스타" });
    await t.run((ctx) => ctx.db.patch(instagram.spaceId, { sessionState: "HEALTHY" }));
    await expect(other.as.mutation(api.jobs.enqueuePublish, { spaceId: instagram.spaceId, text: "", mediaUrls: [], pieceId: threads._id })).rejects.toThrow(/플랫폼/);
    const schedule = { kind: "DAILY" as const, timeOfDay: "10:00", daysOfWeek: [], jitterMinutes: 0, text: "", mediaUrls: [], autoApprove: false };
    await expect(other.as.mutation(api.schedules.upsert, { ...schedule, spaceId: instagram.spaceId, pieceId: threads._id })).rejects.toThrow(/플랫폼/);
    await expect(other.as.mutation(api.schedules.upsert, { ...schedule, spaceId, pieceId: threads._id, linkId: mismatchedLinkId })).rejects.toThrow(/상품.*일치/);
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "DISABLED" });
    await expect(other.as.mutation(api.schedules.upsert, { ...schedule, spaceId, pieceId: threads._id, linkId: matchingLinkId })).rejects.toThrow(/활성 상태/);
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "ACTIVE" });
    const validSchedule = await other.as.mutation(api.schedules.upsert, { ...schedule, spaceId, pieceId: threads._id, linkId: matchingLinkId });
    await other.as.mutation(api.links.setStatus, { linkId: matchingLinkId, status: "DISABLED" });
    expect(await t.mutation(internal.schedules.tick, { now: validSchedule.nextRunAt! + 1 })).toMatchObject({ created: 0, skipped: 1 });
    expect((await other.as.query(api.schedules.listMine, {}))[0]?.lastSkipReason).toBe("LINK_INACTIVE");
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
