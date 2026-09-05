import { PLATFORM_LIMITS, type SnsPlatform } from "./jobs";

/** 채널 (docs/06 §2). SNS 플랫폼 + 릴스 변형 */
export const CHANNELS = ["INSTAGRAM_FEED", "INSTAGRAM_REEL", "THREADS", "X", "TIKTOK", "BLOG"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_PLATFORM: Record<Channel, SnsPlatform> = {
  INSTAGRAM_FEED: "INSTAGRAM",
  INSTAGRAM_REEL: "INSTAGRAM",
  THREADS: "THREADS",
  X: "X",
  TIKTOK: "TIKTOK",
  BLOG: "NAVER_BLOG",
};

export const CHANNEL_SPEC: Record<Channel, { maxChars: number; hashtags: [number, number]; hookChars: number; script: boolean; label: string }> = {
  INSTAGRAM_FEED: { maxChars: 2200, hashtags: [10, 20], hookChars: 125, script: false, label: "인스타그램 피드" },
  INSTAGRAM_REEL: { maxChars: 2200, hashtags: [5, 15], hookChars: 60, script: true, label: "인스타그램 릴스" },
  THREADS: { maxChars: 500, hashtags: [0, 3], hookChars: 80, script: false, label: "쓰레드" },
  X: { maxChars: 280, hashtags: [0, 3], hookChars: 60, script: false, label: "X" },
  TIKTOK: { maxChars: 2200, hashtags: [3, 5], hookChars: 60, script: true, label: "틱톡" },
  BLOG: { maxChars: 20000, hashtags: [0, 10], hookChars: 200, script: false, label: "블로그" },
};

export const ATOM_TYPES = ["HOOK", "STYLE_TIP", "PRODUCT_POINT", "QUOTE", "TREND_TIE_IN"] as const;
export type AtomType = (typeof ATOM_TYPES)[number];

export interface ContentAtom {
  atomType: AtomType;
  text: string;
  productId?: number | null;
  rank: number;
}

export interface ProductBrief {
  attrangsProductId: number;
  name: string;
  price: number;
  salePrice?: number | null;
  category?: string | null;
}

export interface ExtractedMagazine {
  title: string;
  description: string | null;
  heroImage: string | null;
  imageUrls: string[];
  bodyText: string;
  productIds: number[];
  publishedAt: string | null;
}

// ─────────────────────────────── 매거진 추출 (정규식 기반, 라이브러리 없음) ───────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function meta(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i");
  const m = re.exec(html) ?? re2.exec(html);
  return m?.[1] ? decodeEntities(m[1]) : null;
}

function absolutize(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

export function extractMagazine(html: string, baseUrl = "https://attrangs.co.kr/"): ExtractedMagazine {
  const title = meta(html, "og:title") ?? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "") ?? "";
  const description = meta(html, "og:description") ?? meta(html, "description");
  const heroImage = meta(html, "og:image");
  const publishedAt = meta(html, "article:published_time");

  // 본문 후보: <article> > <main> > body. 스크립트/스타일/네비 제거 후 텍스트화
  const pick = (tag: string) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html)?.[1];
  const region = pick("article") ?? pick("main") ?? pick("body") ?? html;
  const stripped = region
    .replace(/<(script|style|nav|header|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const bodyText = decodeEntities(stripped)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .slice(0, 20_000);

  const imageUrls = [...new Set([...region.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi)].map((m) => absolutize(m[1]!, baseUrl)))].filter((u) => !/\.(svg|gif)(\?|$)/i.test(u) && !/icon|logo|btn|blank|spacer/i.test(u)).slice(0, 30);
  const productIds = [...new Set([...html.matchAll(/index_no=(\d+)/g)].map((m) => Number(m[1])))].filter((n) => Number.isInteger(n) && n > 0);
  return { title: title.trim(), description, heroImage: heroImage ? absolutize(heroImage, baseUrl) : imageUrls[0] ?? null, imageUrls, bodyText, productIds, publishedAt };
}

// ─────────────────────────────── 콘텐츠 원자 추출 ───────────────────────────────

const HOOK_RE = /(\?|요즘|올해|지금|이번 시즌|비밀|꿀팁|주목|필수|인기|화제|드디어)/;
const TIP_RE = /(코디|매치|스타일링|레이어드|이너|아우터|믹스|연출|룩|핏|컬러|소재|착용|입으면|입어)/;
const QUOTE_RE = /["“”']/;
const TREND_RE = /(트렌드|유행|SNS|틱톡|인스타|릴스|셀럽|연예인|공항패션|Y2K|하객룩|오피스룩|데이트룩)/i;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?。]|다\.|요\.|죠\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 160);
}

export function extractAtoms(text: string, products: ProductBrief[] = [], max = 20): ContentAtom[] {
  const sentences = splitSentences(text);
  const atoms: ContentAtom[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    if (seen.has(s)) continue;
    seen.add(s);
    const product = products.find((p) => p.name && s.includes(p.name.split(" ")[0]!) && s.includes(p.name.split(" ").at(-1)!));
    let type: AtomType | null = null;
    if (product) type = "PRODUCT_POINT";
    else if (TREND_RE.test(s)) type = "TREND_TIE_IN";
    else if (QUOTE_RE.test(s) && s.length < 80) type = "QUOTE";
    else if (TIP_RE.test(s)) type = "STYLE_TIP";
    else if (HOOK_RE.test(s) && s.length < 90) type = "HOOK";
    if (!type) continue;
    atoms.push({ atomType: type, text: s, productId: product?.attrangsProductId ?? null, rank: 0 });
  }
  // 랭킹: 훅·상품 포인트 우선, 짧을수록 가산
  const weight: Record<AtomType, number> = { HOOK: 5, PRODUCT_POINT: 4, STYLE_TIP: 3, TREND_TIE_IN: 3, QUOTE: 2 };
  return atoms
    .map((a) => ({ ...a, rank: weight[a.atomType] * 100 - Math.min(a.text.length, 99) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, max)
    .map((a, i) => ({ ...a, rank: i + 1 }));
}

// ─────────────────────────────── 품질 게이트 ───────────────────────────────

export interface GeneratedPiece {
  channel: Channel;
  caption: string;
  hashtags: string[];
  script?: string | null;
  mediaHints?: string[];
}

export interface QualityReport {
  score: number;
  violations: { code: string; message: string; severity: "block" | "warn" }[];
  fixed: string[];
  caption: string;
  hashtags: string[];
}

/** 근거 없는 주장 금지 (blogautomcp product-photo-thumbnail-copywriting 금칙어 계승) */
export const BANNED_CLAIMS: { re: RegExp; code: string; message: string }[] = [
  { re: /최저가|역대급 할인|파격 세일/, code: "PRICE_CLAIM", message: "가격 우위 주장은 카탈로그 근거 없이는 금지" },
  { re: /1위|1등|판매량 최고|베스트셀러 1/, code: "RANK_CLAIM", message: "순위 주장 금지" },
  { re: /직접 (입어|써|사용해|착용해)\s?(봤|보니|본)/, code: "PERSONAL_USE_CLAIM", message: "미검증 직접 사용 경험 주장 금지" },
  { re: /100%|완벽하게|무조건|절대/, code: "ABSOLUTE_CLAIM", message: "절대 표현 금지" },
  { re: /효능|치료|다이어트 효과|살 빠지/, code: "HEALTH_CLAIM", message: "효능·건강 주장 금지" },
];
export const AD_DISCLOSURE_RE = /#광고|#협찬|광고 포함|제휴 링크/;

export function evaluatePiece(piece: GeneratedPiece, opts: { linkExpected?: boolean } = {}): QualityReport {
  const spec = CHANNEL_SPEC[piece.channel];
  const violations: QualityReport["violations"] = [];
  const fixed: string[] = [];
  let caption = (piece.caption ?? "").trim();
  let hashtags = [...new Set((piece.hashtags ?? []).map((h) => h.trim().replace(/^#/, "")).filter(Boolean))];

  if (!caption) violations.push({ code: "EMPTY", message: "본문이 비어 있습니다.", severity: "block" });
  for (const b of BANNED_CLAIMS) if (b.re.test(caption)) violations.push({ code: b.code, message: b.message, severity: "block" });

  // 광고 표기 자동 삽입 (표시광고법)
  if (!AD_DISCLOSURE_RE.test(caption) && !hashtags.includes("광고")) {
    hashtags = [...hashtags, "광고"];
    fixed.push("#광고 해시태그 추가");
  }
  // 해시태그 개수 규격
  const [minH, maxH] = spec.hashtags;
  if (hashtags.length > maxH) {
    const keepAd = hashtags.includes("광고");
    hashtags = hashtags.filter((h) => h !== "광고").slice(0, keepAd ? Math.max(maxH - 1, 0) : maxH);
    if (keepAd) hashtags.push("광고"); // 광고 표기는 축소 대상에서 제외
    fixed.push(`해시태그 ${maxH}개로 축소`);
  }
  if (hashtags.length < minH) violations.push({ code: "HASHTAGS_FEW", message: `해시태그 ${minH}개 이상 권장`, severity: "warn" });

  // 길이: 본문 + 해시태그 + 링크 여유(30자)
  const tagText = hashtags.map((h) => `#${h}`).join(" ");
  const total = [...`${caption}\n${tagText}`].length + (opts.linkExpected ? 30 : 0);
  if (total > spec.maxChars) {
    const room = spec.maxChars - [...tagText].length - (opts.linkExpected ? 30 : 0) - 2;
    if (room > 40) {
      caption = [...caption].slice(0, room - 1).join("") + "…";
      fixed.push(`본문을 ${spec.maxChars}자 규격에 맞게 축약`);
    } else violations.push({ code: "TOO_LONG", message: `채널 한도 ${spec.maxChars}자 초과`, severity: "block" });
  }
  if (spec.script && !(piece.script ?? "").trim()) violations.push({ code: "SCRIPT_MISSING", message: "숏폼 스크립트가 필요합니다.", severity: "warn" });

  // 점수: 훅 길이, 줄바꿈 가독성, CTA, AI 상투어
  let score = 100;
  const firstLine = caption.split("\n")[0] ?? "";
  if ([...firstLine].length > spec.hookChars) score -= 10;
  if (!/\n/.test(caption) && [...caption].length > 120) score -= 5;
  if (!/(확인|보러|링크|프로필|댓글|저장|공유|클릭|구경)/.test(caption)) score -= 8;
  const cliches = (caption.match(/(완벽한 선택|특별한 순간|일상 속|여러분의|놓치지 마세요|지금 바로)/g) ?? []).length;
  score -= Math.min(cliches * 6, 18);
  for (const v of violations) score -= v.severity === "block" ? 40 : 5;
  score = Math.max(0, Math.min(100, score));
  return { score, violations, fixed, caption, hashtags };
}

export const QUALITY_PASS_SCORE = 90;
export function isAutoApprovable(r: QualityReport): boolean {
  return r.score >= QUALITY_PASS_SCORE && r.violations.every((v) => v.severity !== "block");
}

// ─────────────────────────────── 템플릿 생성기 (LLM 없는 환경·테스트) ───────────────────────────────

export interface GenerationInput {
  channels: Channel[];
  atoms: ContentAtom[];
  products: ProductBrief[];
  magazineTitle?: string | null;
  tone?: "polite" | "casual";
  brand?: string;
}

function won(n: number): string {
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

export function templateGenerate(input: GenerationInput): GeneratedPiece[] {
  const brand = input.brand ?? "아뜨랑스";
  const product = input.products[0] ?? null;
  const hook = input.atoms.find((a) => a.atomType === "HOOK")?.text ?? (input.magazineTitle ? `${input.magazineTitle}` : `${brand} 이번 주 추천`);
  const points = input.atoms.filter((a) => a.atomType === "PRODUCT_POINT" || a.atomType === "STYLE_TIP").slice(0, 3).map((a) => a.text);
  const tip = input.atoms.find((a) => a.atomType === "TREND_TIE_IN")?.text ?? null;
  const priceLine = product ? `${product.name} · ${product.salePrice ? `${won(product.salePrice)} (정가 ${won(product.price)})` : won(product.price)}` : null;
  const base = [brand, product?.category?.replace(/\s/g, "") ?? "데일리룩", "코디", "여성의류", "패션스타그램", "오오티디", "쇼핑", "스타일링"].filter(Boolean);
  const out: GeneratedPiece[] = [];
  for (const channel of input.channels) {
    const spec = CHANNEL_SPEC[channel];
    const tags = base.slice(0, Math.max(spec.hashtags[0], Math.min(spec.hashtags[1], 8)));
    let caption: string;
    let script: string | null = null;
    switch (channel) {
      case "X":
        caption = `${hook.slice(0, 60)}\n${points[0] ?? priceLine ?? ""}\n링크에서 확인 👇`.trim();
        break;
      case "THREADS":
        caption = [hook, ...points.slice(0, 2), priceLine, "자세한 건 링크 참고 🙂"].filter(Boolean).join("\n");
        break;
      case "INSTAGRAM_FEED":
        caption = [hook, "", ...points.map((p) => `• ${p}`), tip ? `\n${tip}` : "", priceLine ? `\n${priceLine}` : "", "\n👉 프로필 링크에서 확인하세요"].filter((l) => l !== null).join("\n");
        break;
      case "INSTAGRAM_REEL":
      case "TIKTOK":
        caption = [hook, priceLine, "프로필 링크에서 확인 👀"].filter(Boolean).join("\n");
        script = [`[0-3초] ${hook}`, ...points.map((p, i) => `[${3 + i * 5}-${8 + i * 5}초] ${p}`), `[마무리] ${priceLine ?? "링크에서 확인"} — 저장·공유 유도`].join("\n");
        break;
      case "BLOG":
        caption = [`${input.magazineTitle ?? hook}`, "", hook, "", ...points.map((p) => `${p}\n`), tip ? `${tip}\n` : "", priceLine ? `상품 정보: ${priceLine}` : "", "", "구매 링크는 본문 하단을 확인해 주세요."].join("\n");
        break;
    }
    out.push({ channel, caption, hashtags: tags, script });
  }
  return out;
}

// ─────────────────────────────── Codex 프롬프트 · 파서 ───────────────────────────────

export function buildGenerationPrompt(input: GenerationInput): string {
  const spec = input.channels.map((c) => `- ${c}: 최대 ${CHANNEL_SPEC[c].maxChars}자, 해시태그 ${CHANNEL_SPEC[c].hashtags[0]}~${CHANNEL_SPEC[c].hashtags[1]}개, 첫 줄 훅 ${CHANNEL_SPEC[c].hookChars}자 이내${CHANNEL_SPEC[c].script ? ", script(15~30초 숏폼 대본) 필수" : ""}`).join("\n");
  return [
    "당신은 20~30대 여성 패션 쇼핑몰의 SNS 마케팅 카피라이터입니다. 아래 소재만 근거로 채널별 게시물을 작성하세요.",
    "규칙: 최저가·1위·직접 착용 경험·절대 표현·효능 주장 금지. 가격은 제공된 값만 사용. 광고임을 알 수 있게 #광고 해시태그 포함. AI 상투어(완벽한 선택, 특별한 순간, 지금 바로) 금지. 자연스러운 한국어, 이모지는 채널당 2개 이하.",
    `브랜드: ${input.brand ?? "아뜨랑스"}${input.magazineTitle ? ` / 매거진: ${input.magazineTitle}` : ""}`,
    `상품: ${JSON.stringify(input.products)}`,
    `소재(원자): ${JSON.stringify(input.atoms.map((a) => ({ type: a.atomType, text: a.text })))}`,
    `채널 규격:\n${spec}`,
    '출력: JSON 배열만. 각 원소 {"channel":"<채널>","caption":"본문(줄바꿈 \\n)","hashtags":["태그"],"script":"숏폼 대본 또는 null"}',
  ].join("\n\n");
}

export function parseGeneratedPieces(raw: string, allowed: Channel[]): GeneratedPiece[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => ({
        channel: String(p.channel) as Channel,
        caption: String(p.caption ?? ""),
        hashtags: Array.isArray(p.hashtags) ? p.hashtags.map(String) : [],
        script: typeof p.script === "string" ? p.script : null,
      }))
      .filter((p) => allowed.includes(p.channel) && p.caption.trim().length > 0);
  } catch {
    return [];
  }
}
