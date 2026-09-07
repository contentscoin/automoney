import type { ContentAtom, ProductBrief } from "./content";

/**
 * 코디 제안 카드 (docs/06 §4): 매거진 테마룩 + 상품 조합 → 코디 세트.
 * 규칙 기반(LLM 없음): 본문에서 테마를 감지하고, 상품을 역할(원피스·상의·하의·아우터·신발·가방·액세서리)로 분류해
 * 어울리는 조합을 만든다. 매거진 발행(수집) 시 생성되며 큐레이션 `OUTFIT` 항목으로 저장된다.
 */

export const OUTFIT_THEMES = ["하객룩", "오피스룩", "데이트룩", "여행룩", "캠퍼스룩", "데일리룩"] as const;
export type OutfitTheme = (typeof OUTFIT_THEMES)[number];

const THEME_RE: Record<Exclude<OutfitTheme, "데일리룩">, RegExp> = {
  하객룩: /(하객|결혼식|웨딩|예식|축의)/g,
  오피스룩: /(오피스|출근|회사|비즈니스|미팅|직장)/g,
  데이트룩: /(데이트|소개팅|기념일|연인)/g,
  여행룩: /(여행|휴가|바캉스|공항|리조트)/g,
  캠퍼스룩: /(캠퍼스|개강|학교|대학)/g,
};

const THEME_TIP: Record<OutfitTheme, string> = {
  하객룩: "화이트·아이보리 톤은 피하고, 과한 노출 없이 단정하게. 미니백과 낮은 굽으로 마무리하면 예식장에서 편해요.",
  오피스룩: "톤온톤으로 정돈하고 아우터 한 벌로 격식을 더하세요. 실루엣은 슬림보다 편안한 핏이 하루 종일 무난해요.",
  데이트룩: "포인트는 한 군데만. 원피스면 액세서리를 줄이고, 상하의 조합이면 컬러 하나를 튀게 잡아 보세요.",
  여행룩: "구김 적은 소재와 겹쳐 입기 좋은 아이템 위주로. 낮과 밤 기온차를 아우터로 커버하세요.",
  캠퍼스룩: "활동성이 먼저. 편한 하의에 상의로 분위기를 바꾸고 아우터는 가볍게 걸치는 정도면 충분해요.",
  데일리룩: "기본 아이템끼리 묶으면 어디에나 어울려요. 소재감 차이(니트×데님, 새틴×코튼)로 단조로움을 피하세요.",
};

/** 본문·제목에서 테마를 최대 max 개 감지. 없으면 데일리룩. */
export function detectThemes(text: string, max = 2): OutfitTheme[] {
  const scored = (Object.entries(THEME_RE) as [OutfitTheme, RegExp][])
    .map(([theme, re]) => [theme, (text.match(re) ?? []).length] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const themes = scored.slice(0, max).map(([t]) => t);
  return themes.length > 0 ? themes : ["데일리룩"];
}

export type OutfitRole = "DRESS" | "TOP" | "BOTTOM" | "OUTER" | "SHOES" | "BAG" | "ACC";

const ROLE_RULES: [OutfitRole, RegExp][] = [
  ["DRESS", /(원피스|드레스|점프수트|점프슈트)/],
  ["OUTER", /(자켓|재킷|코트|가디건|점퍼|블레이저|아우터|패딩|트렌치|베스트|조끼)/],
  ["BOTTOM", /(스커트|치마|팬츠|슬랙스|데님|청바지|바지|쇼츠|반바지|레깅스|하의)/],
  ["TOP", /(니트|티셔츠|티|블라우스|셔츠|탑|톱|맨투맨|후드|스웨터|상의|나시|슬리브리스)/],
  ["SHOES", /(신발|슈즈|부츠|로퍼|샌들|스니커즈|힐|플랫|뮬)/],
  ["BAG", /(가방|백|토트|숄더|크로스|클러치|파우치)/],
  ["ACC", /(귀걸이|목걸이|반지|팔찌|모자|스카프|머플러|벨트|양말|헤어|액세서리|악세사리|주얼리)/],
];

/** 카테고리 → 상품명 순으로 역할 판정. 못 찾으면 ACC. */
export function outfitRole(p: Pick<ProductBrief, "name" | "category">): OutfitRole {
  for (const src of [p.category ?? "", p.name]) for (const [role, re] of ROLE_RULES) if (re.test(src)) return role;
  return "ACC";
}

export interface OutfitSet {
  key: string;
  theme: OutfitTheme;
  title: string;
  body: string;
  productIds: number[]; // attrangsProductId
  total: number; // 세일가 반영 합계
  score: number;
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const priceOf = (p: ProductBrief) => p.salePrice ?? p.price;
const short = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 24);

function tipFor(products: ProductBrief[], atoms: ContentAtom[]): string | null {
  const tips = atoms.filter((a) => a.atomType === "STYLE_TIP" || a.atomType === "PRODUCT_POINT");
  for (const p of products) {
    const head = p.name.split(" ")[0]!;
    const hit = tips.find((a) => a.productId === p.attrangsProductId || a.text.includes(head));
    if (hit) return hit.text;
  }
  return tips[0]?.text ?? null;
}

function compose(theme: OutfitTheme, items: ProductBrief[], atoms: ContentAtom[]): OutfitSet {
  const total = items.reduce((s, p) => s + priceOf(p), 0);
  const names = items.map((p) => short(p.name));
  const lines = [`구성: ${items.map((p) => `${short(p.name)} ${won(priceOf(p))}${p.salePrice && p.salePrice < p.price ? "(세일)" : ""}`).join(" · ")}`, `합계: ${won(total)}`];
  const tip = tipFor(items, atoms);
  if (tip) lines.push(`매거진 팁: ${tip}`);
  lines.push(`스타일링: ${THEME_TIP[theme]}`);
  const onSale = items.filter((p) => p.salePrice && p.salePrice < p.price).length;
  const score = Math.min(100, 60 + items.length * 8 + onSale * 5 + (theme === "데일리룩" ? 0 : 6));
  return { key: items.map((p) => p.attrangsProductId).sort((a, b) => a - b).join("+"), theme, title: `${theme} 코디 · ${names.join(" + ")}`, body: lines.join("\n"), productIds: items.map((p) => p.attrangsProductId), total, score };
}

/**
 * 상품 조합 → 코디 세트. 원피스 중심(원피스+아우터+가방/신발) 과 상하의 중심(상의+하의+아우터) 을 만든다.
 * 상품이 2개 미만이거나 조합 가능한 역할이 없으면 빈 배열.
 */
export function buildOutfitSets(products: ProductBrief[], themes: OutfitTheme[], atoms: ContentAtom[] = [], max = 6): OutfitSet[] {
  const byRole = new Map<OutfitRole, ProductBrief[]>();
  for (const p of products) {
    const r = outfitRole(p);
    byRole.set(r, [...(byRole.get(r) ?? []), p]);
  }
  const pick = (r: OutfitRole, i = 0) => byRole.get(r)?.[i];
  const combos: ProductBrief[][] = [];
  for (const dress of byRole.get("DRESS") ?? []) {
    const extras = [pick("OUTER"), pick("BAG") ?? pick("SHOES") ?? pick("ACC")].filter((x): x is ProductBrief => !!x);
    if (extras.length > 0) combos.push([dress, ...extras]);
  }
  for (const top of (byRole.get("TOP") ?? []).slice(0, 3)) {
    for (const bottom of (byRole.get("BOTTOM") ?? []).slice(0, 3)) {
      const outer = pick("OUTER");
      combos.push([top, bottom, ...(outer ? [outer] : [])]);
    }
  }
  // 상하의 중 한쪽만 있고 아우터가 있으면 2피스
  if ((byRole.get("TOP")?.length ?? 0) === 0 || (byRole.get("BOTTOM")?.length ?? 0) === 0) {
    const single = pick("TOP") ?? pick("BOTTOM");
    const outer = pick("OUTER");
    if (single && outer && !combos.some((c) => c.includes(single))) combos.push([single, outer]);
  }
  const seen = new Set<string>();
  const sets: OutfitSet[] = [];
  const theme0 = themes[0] ?? "데일리룩";
  combos.forEach((items, i) => {
    const key = items.map((p) => p.attrangsProductId).sort((a, b) => a - b).join("+");
    if (seen.has(key) || items.length < 2) return;
    seen.add(key);
    sets.push(compose(themes[i % themes.length] ?? theme0, items, atoms));
  });
  return sets.sort((a, b) => b.score - a.score).slice(0, max);
}
