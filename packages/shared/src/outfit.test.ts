import { describe, expect, it } from "vitest";
import { buildOutfitSets, detectThemes, extractAtoms, outfitRole, type ProductBrief } from "./index";

const P = (attrangsProductId: number, name: string, category: string | null, price: number, salePrice: number | null = null): ProductBrief => ({ attrangsProductId, name, category, price, salePrice });

const BODY = "가을 하객룩 고민이라면 플라워 셔링 롱 원피스를 주목하세요. 결혼식장에서 트위드 크롭 자켓과 매치하면 격식을 갖출 수 있어요. 오피스룩으로도 활용 가능합니다.";

describe("detectThemes", () => {
  it("ranks themes by mention count and falls back to 데일리룩", () => {
    expect(detectThemes(BODY)).toEqual(["하객룩", "오피스룩"]);
    expect(detectThemes("데이트 코디 추천", 1)).toEqual(["데이트룩"]);
    expect(detectThemes("니트 신상 입고")).toEqual(["데일리룩"]);
  });
});

describe("outfitRole", () => {
  it("classifies by category first, then product name", () => {
    expect(outfitRole({ name: "플라워 셔링 롱 원피스", category: "원피스" })).toBe("DRESS");
    expect(outfitRole({ name: "트위드 크롭 자켓", category: "아우터" })).toBe("OUTER");
    expect(outfitRole({ name: "하이웨스트 와이드 슬랙스", category: null })).toBe("BOTTOM");
    expect(outfitRole({ name: "베이직 니트", category: null })).toBe("TOP");
    expect(outfitRole({ name: "미니 토트백", category: null })).toBe("BAG");
    expect(outfitRole({ name: "정체불명 아이템", category: null })).toBe("ACC");
  });
});

describe("buildOutfitSets", () => {
  const products = [P(1, "플라워 셔링 롱 원피스", "원피스", 49000, 44100), P(2, "트위드 크롭 자켓", "아우터", 69000), P(3, "하이웨스트 와이드 슬랙스", "하의", 39000), P(4, "베이직 니트", "상의", 29000), P(5, "미니 토트백", "가방", 35000)];

  it("builds dress-led and top+bottom sets with prices, tips and dedupe keys", () => {
    const atoms = extractAtoms(BODY, products);
    const sets = buildOutfitSets(products, detectThemes(BODY), atoms);
    expect(sets.length).toBeGreaterThanOrEqual(2);
    const dress = sets.find((s) => s.productIds.includes(1))!;
    expect(dress.productIds).toContain(2); // 원피스 + 아우터
    expect(dress.title).toMatch(/^(하객룩|오피스룩) 코디 · /);
    expect(dress.body).toContain("44,100원(세일)");
    expect(dress.body).toMatch(/합계: [\d,]+원/);
    expect(dress.body).toContain("스타일링:");
    const pair = sets.find((s) => s.productIds.includes(4) && s.productIds.includes(3))!;
    expect(pair.total).toBe(29000 + 39000 + 69000);
    expect(new Set(sets.map((s) => s.key)).size).toBe(sets.length);
    expect(sets).toEqual([...sets].sort((a, b) => b.score - a.score));
  });

  it("returns nothing when a set cannot be composed", () => {
    expect(buildOutfitSets([P(9, "베이직 니트", "상의", 29000)], ["데일리룩"])).toEqual([]);
    expect(buildOutfitSets([], ["데일리룩"])).toEqual([]);
  });

  it("caps the number of sets", () => {
    const many = [P(1, "니트 A", "상의", 1000), P(2, "니트 B", "상의", 1000), P(3, "니트 C", "상의", 1000), P(4, "슬랙스 A", "하의", 1000), P(5, "슬랙스 B", "하의", 1000), P(6, "슬랙스 C", "하의", 1000)];
    expect(buildOutfitSets(many, ["데일리룩"], [], 4).length).toBe(4);
  });
});
