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
  return await t.mutation(api.devices.pair, { code, deviceName: "PC", platform: "linux", appVersion: "0.1.0" });
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
});

describe("content generation gate", () => {
  it("requires a paired device, enqueues content.generate, ingests results with quality gate and honors visibility", async () => {
    const { t, owner, p1 } = await setup();
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
      { channel: "THREADS", caption: "가을 니트는 루즈핏이 정답. 와이드 슬랙스랑 매치하면 편하면서 단정해요. 링크에서 확인 👉", hashtags: ["가을코디", "니트", "아뜨랑스"], mediaUrls: [] },
      { channel: "X", caption: "최저가 보장! 직접 입어봤는데 100% 만족", hashtags: ["광고"], mediaUrls: [] },
      { channel: "NOPE", caption: "x", hashtags: [], mediaUrls: [] },
    ];
    const done = await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok", data: { pieces, generatedBy: "template" } } }) }));
    expect(done.status).toBe(200);
    const lib = await user.as.query(api.content.listLibrary, {});
    expect(lib.length).toBe(2);
    const threads = lib.find((p) => p.channel === "THREADS")!;
    const x = lib.find((p) => p.channel === "X")!;
    expect(threads.status).toBe("APPROVED");
    expect(threads.hashtags).toContain("광고");
    expect(x.status).toBe("DRAFT");
    expect(x.qualityScore).toBeLessThan(90);
    // 금칙 위반 조각은 유저가 승인 불가, 수정 후 승인 가능
    await expect(user.as.mutation(api.content.approve, { pieceId: x._id })).rejects.toThrow(/금칙/);
    await user.as.mutation(api.content.edit, { pieceId: x._id, caption: "가을 니트 셀렉션, 링크에서 확인하세요", hashtags: ["광고", "니트"] });
    await user.as.mutation(api.content.approve, { pieceId: x._id });
    expect((await user.as.query(api.content.getPiece, { pieceId: x._id })).status).toBe("APPROVED");
    // 중복 ingest 방지
    expect(await t.mutation(internal.content.ingestGenerated, { jobId })).toMatchObject({ saved: 0, duplicate: true });

    // 가시성: 타 유저는 PRIVATE 조각을 볼 수 없음. 수퍼어드민이 SHARED 로 바꾸면 보임
    expect((await other.as.query(api.content.listLibrary, {})).length).toBe(0);
    await expect(other.as.query(api.content.getPiece, { pieceId: threads._id })).rejects.toThrow();
    await expect(user.as.mutation(api.content.setVisibility, { pieceId: threads._id, visibility: "SHARED" })).rejects.toThrow(/권한/);
    await owner.as.mutation(api.content.setVisibility, { pieceId: threads._id, visibility: "SHARED" });
    const otherLib = await other.as.query(api.content.listLibrary, {});
    expect(otherLib.map((p) => p._id)).toEqual([threads._id]);

    // 거절 → RETIRED + 사유 기록
    await user.as.mutation(api.content.reject, { pieceId: x._id, reason: "톤이 안 맞음" });
    expect((await user.as.query(api.content.listLibrary, {})).some((p) => p._id === x._id)).toBe(false);
    const stats = await owner.as.query(api.content.rejectionStats, {});
    expect(stats.total).toBe(1);

    // pieceId 로 발행 잡 채우기(SHARED 조각을 타 유저가 사용, usageCount 증가)
    const { deviceToken: otherToken } = await pairDevice(t, other);
    void otherToken;
    const { spaceId, jobId: createJob } = await other.as.mutation(api.spaces.create, { platform: "THREADS", name: "메인" });
    void createJob;
    const pubJob = await other.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: threads._id });
    const job = await t.run(async (ctx) => ctx.db.get(pubJob));
    expect((job!.payload as { text: string }).text).toContain("#광고");
    expect((job!.payload as { pieceId: string }).pieceId).toBe(threads._id);
    expect((await user.as.query(api.content.getPiece, { pieceId: threads._id })).usageCount).toBe(1);
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
    const trends = await user.as.query(api.curation.list, { kind: "TREND" });
    expect(trends.map((x) => x.title)).toEqual(["한강 불꽃축제", "가을 니트 코디"]);

    const facts = await user.as.mutation(api.curation.buildProductFacts, { productId: p1 });
    expect(facts.inserted).toBe(5);
    const items = await user.as.query(api.curation.list, { productId: p1, kind: "PRODUCT_FACT" });
    expect(items[0]!.title).toMatch(/가격/);
    expect(items[0]!.body).toMatch(/35,000원/);

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
  });
});
