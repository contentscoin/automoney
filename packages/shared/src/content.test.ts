import { describe, expect, it } from "vitest";
import { buildGenerationPrompt, evaluatePiece, extractAtoms, extractMagazine, isAutoApprovable, parseGeneratedPieces, templateGenerate, CHANNELS } from "./index";

const HTML = `<!doctype html><html><head><title>fallback</title>
<meta property="og:title" content="가을 하객룩, 이렇게 입으면 실패 없어요" />
<meta property="og:description" content="셔링 원피스와 트위드 자켓 조합" />
<meta property="og:image" content="/img/hero.jpg" />
<meta property="article:published_time" content="2026-09-04T09:00:00+09:00" />
</head><body><nav>메뉴 <a href="/shop/list.php?cate=1">원피스</a></nav>
<article>
<h1>가을 하객룩, 이렇게 입으면 실패 없어요</h1>
<p>요즘 하객룩 고민이라면 플라워 셔링 롱 원피스를 주목하세요. 트위드 크롭 자켓과 매치하면 격식과 트렌드를 동시에 잡을 수 있어요.</p>
<img src="/img/look1.jpg" /><img data-src="https://cdn.attrangs.co.kr/img/look2.jpg" /><img src="/img/icon-heart.svg" />
<p>"올해는 톤온톤이 대세"라는 말처럼 베이지 계열 코디가 인기예요. 하이웨스트 와이드 슬랙스는 오피스룩에도 잘 어울립니다.</p>
<a href="/shop/view.php?index_no=100001">플라워 셔링 롱 원피스</a>
<a href="https://attrangs.co.kr/shop/view.php?index_no=100004">트위드 크롭 자켓</a>
<a href="/shop/view.php?index_no=100003">슬랙스</a>
<script>var x = "index_no=999999";</script>
</article><footer>회사정보</footer></body></html>`;

const products = [
  { attrangsProductId: 100001, name: "플라워 셔링 롱 원피스", price: 49000, salePrice: 44100, category: "원피스" },
  { attrangsProductId: 100004, name: "트위드 크롭 자켓", price: 69000, salePrice: null, category: "아우터" },
];

describe("extractMagazine", () => {
  it("pulls og meta, article text, images and product ids", () => {
    const m = extractMagazine(HTML, "https://attrangs.co.kr/magazine/1");
    expect(m.title).toBe("가을 하객룩, 이렇게 입으면 실패 없어요");
    expect(m.heroImage).toBe("https://attrangs.co.kr/img/hero.jpg");
    expect(m.imageUrls).toEqual(["https://attrangs.co.kr/img/look1.jpg", "https://cdn.attrangs.co.kr/img/look2.jpg"]);
    expect(m.productIds).toEqual([100001, 100004, 100003, 999999].filter((n) => n !== 0));
    expect(m.bodyText).toContain("플라워 셔링 롱 원피스");
    expect(m.bodyText).not.toContain("메뉴");
    expect(m.bodyText).not.toContain("회사정보");
    expect(m.publishedAt).toBe("2026-09-04T09:00:00+09:00");
  });
});

describe("extractAtoms", () => {
  it("classifies sentences and links products", () => {
    const m = extractMagazine(HTML);
    const atoms = extractAtoms(m.bodyText, products);
    expect(atoms.length).toBeGreaterThanOrEqual(3);
    const pp = atoms.find((a) => a.atomType === "PRODUCT_POINT");
    expect(pp?.productId).toBe(100001);
    expect(atoms.some((a) => a.atomType === "TREND_TIE_IN" || a.atomType === "STYLE_TIP")).toBe(true);
    expect(atoms[0]?.rank).toBe(1);
  });
});

describe("evaluatePiece", () => {
  it("adds ad disclosure, trims hashtags, and passes a clean caption", () => {
    const r = evaluatePiece({ channel: "THREADS", caption: "가을 하객룩 고민이라면?\n셔링 원피스로 해결. 링크에서 확인해 보세요", hashtags: ["아뜨랑스", "하객룩", "코디", "원피스"] });
    expect(r.hashtags).toEqual(["아뜨랑스", "하객룩", "광고"]);
    expect(r.fixed.length).toBeGreaterThan(0);
    expect(r.violations.filter((v) => v.severity === "block")).toEqual([]);
    expect(isAutoApprovable(r)).toBe(true);
  });
  it("blocks banned claims and over-length captions", () => {
    const bad = evaluatePiece({ channel: "X", caption: "최저가 보장! 직접 입어 봤는데 100% 만족 " + "x".repeat(300), hashtags: [] });
    expect(bad.violations.map((v) => v.code)).toEqual(expect.arrayContaining(["PRICE_CLAIM", "PERSONAL_USE_CLAIM", "ABSOLUTE_CLAIM"]));
    expect([...bad.caption].length).toBeLessThanOrEqual(280);
    expect(isAutoApprovable(bad)).toBe(false);
    const long = evaluatePiece({ channel: "THREADS", caption: "가을 룩 추천 " + "좋아요 ".repeat(150), hashtags: ["a"] });
    expect(long.fixed.some((f) => f.includes("축약"))).toBe(true);
    expect([...long.caption].length).toBeLessThan(500);
  });
});

describe("templateGenerate + prompt/parse", () => {
  it("produces spec-compliant pieces for every channel", () => {
    const m = extractMagazine(HTML);
    const atoms = extractAtoms(m.bodyText, products);
    const pieces = templateGenerate({ channels: [...CHANNELS], atoms, products, magazineTitle: m.title });
    expect(pieces).toHaveLength(CHANNELS.length);
    for (const p of pieces) {
      const r = evaluatePiece(p, { linkExpected: true });
      expect(r.violations.filter((v) => v.severity === "block"), p.channel).toEqual([]);
      if (p.channel === "TIKTOK" || p.channel === "INSTAGRAM_REEL") expect(p.script).toBeTruthy();
    }
  });
  it("builds a prompt and parses model output", () => {
    const prompt = buildGenerationPrompt({ channels: ["X", "THREADS"], atoms: [], products, magazineTitle: "t" });
    expect(prompt).toContain("#광고");
    expect(prompt).toContain("X: 최대 280자");
    const parsed = parseGeneratedPieces('설명…\n[{"channel":"X","caption":"hi","hashtags":["a"],"script":null},{"channel":"TIKTOK","caption":"no"},{"channel":"THREADS","caption":""}]', ["X", "THREADS"]);
    expect(parsed).toEqual([{ channel: "X", caption: "hi", hashtags: ["a"], script: null }]);
    expect(parseGeneratedPieces("garbage", ["X"])).toEqual([]);
  });
});
