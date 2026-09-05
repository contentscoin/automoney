/**
 * 분석 루프(docs/06 §5): 훅·CTA 분류, 시간대 버킷, 실험 승격 판정(growth-engine 규칙: 유의성 + 15% 개선).
 */
export const HOOK_TYPES = ["QUESTION", "NUMBER", "CONTRAST", "TREND", "PRICE", "STATEMENT"] as const;
export type HookType = (typeof HOOK_TYPES)[number];
export const CTA_TYPES = ["LINK", "PROFILE", "SAVE", "COMMENT", "NONE"] as const;
export type CtaType = (typeof CTA_TYPES)[number];

export function classifyHook(caption: string): HookType {
  const first = (caption.split(/\n/).find((l) => l.trim().length > 0) ?? "").trim();
  if (/[?？]|까요|나요|일까|할까/.test(first)) return "QUESTION";
  if (/\d[\d,]*\s*원|할인|세일|특가|가격/.test(first)) return "PRICE";
  if (/\d+\s*(가지|개|초|분|%|일|주)/.test(first) || /^\d+/.test(first)) return "NUMBER";
  if (/vs|말고|대신|보다|아니라|말고요|아닌/.test(first)) return "CONTRAST";
  if (/요즘|올해|올가을|올여름|올겨울|이번 시즌|트렌드|유행|대세/.test(first)) return "TREND";
  return "STATEMENT";
}

export function classifyCta(caption: string): CtaType {
  const tail = caption.split(/\n/).filter((l) => l.trim()).slice(-3).join(" ");
  if (/링크|link|https?:\/\//i.test(tail)) return "LINK";
  if (/프로필|프사|바이오|bio/i.test(tail)) return "PROFILE";
  if (/저장|save/i.test(tail)) return "SAVE";
  if (/댓글|의견|알려주세요|남겨/.test(tail)) return "COMMENT";
  return "NONE";
}

/** KST 시각 → 4개 버킷 */
export function hourBucket(hourKst: number): "MORNING" | "DAY" | "EVENING" | "NIGHT" {
  if (hourKst >= 6 && hourKst < 11) return "MORNING";
  if (hourKst >= 11 && hourKst < 17) return "DAY";
  if (hourKst >= 17 && hourKst < 23) return "EVENING";
  return "NIGHT";
}

export function kstHour(ts: number): number {
  return new Date(ts + 9 * 3600_000).getUTCHours();
}

export interface VariantStats {
  /** 게시물 수 */
  samples: number;
  /** 게시물당 지표 합계(클릭 등) */
  sum: number;
}

export interface LiftVerdict {
  lift: number;
  z: number;
  promote: boolean;
  reason: "OK" | "MIN_SAMPLES" | "MIN_LIFT" | "NOT_SIGNIFICANT" | "NO_CONTROL";
}

/**
 * 변형 vs 대조군(나머지 전체) 게시물당 평균 비교. 포아송 근사 z = (m1-m2)/sqrt(m1/n1 + m2/n2).
 * 승격 조건: 표본 ≥ minSamples, 개선 ≥ minLift(기본 15%), z ≥ 1.96(양측 5%).
 */
export function evaluateLift(variant: VariantStats, control: VariantStats, opts: { minSamples?: number; minLift?: number; z?: number } = {}): LiftVerdict {
  const minSamples = opts.minSamples ?? 20;
  const minLift = opts.minLift ?? 0.15;
  const zMin = opts.z ?? 1.96;
  if (variant.samples < minSamples || control.samples < minSamples) return { lift: 0, z: 0, promote: false, reason: "MIN_SAMPLES" };
  const m1 = variant.sum / variant.samples;
  const m2 = control.sum / control.samples;
  if (m2 <= 0) return { lift: m1 > 0 ? 1 : 0, z: 0, promote: false, reason: "NO_CONTROL" };
  const lift = (m1 - m2) / m2;
  const se = Math.sqrt(Math.max(m1, 1e-9) / variant.samples + Math.max(m2, 1e-9) / control.samples);
  const z = (m1 - m2) / se;
  if (lift < minLift) return { lift, z, promote: false, reason: "MIN_LIFT" };
  if (z < zMin) return { lift, z, promote: false, reason: "NOT_SIGNIFICANT" };
  return { lift, z, promote: true, reason: "OK" };
}

export const DIMENSION_LABEL: Record<string, string> = { HOOK: "훅 유형", CTA: "CTA 유형", HOUR: "게시 시간대" };
export const VARIANT_LABEL: Record<string, string> = {
  QUESTION: "질문형", NUMBER: "숫자형", CONTRAST: "대비형", TREND: "트렌드형", PRICE: "가격형", STATEMENT: "서술형",
  LINK: "링크 유도", PROFILE: "프로필 유도", SAVE: "저장 유도", COMMENT: "댓글 유도", NONE: "CTA 없음",
  MORNING: "오전(06-11)", DAY: "낮(11-17)", EVENING: "저녁(17-23)", NIGHT: "밤(23-06)",
};

/** 플레이북 규칙 → 생성 프롬프트 힌트 문장 */
export function playbookHint(rule: { dimension: string; variant: string; lift: number; samples: number }): string {
  const d = DIMENSION_LABEL[rule.dimension] ?? rule.dimension;
  const vlabel = VARIANT_LABEL[rule.variant] ?? rule.variant;
  return `${d} "${vlabel}" 이 대조군 대비 클릭 +${Math.round(rule.lift * 100)}% (게시물 ${rule.samples}건 기준) — 우선 적용`;
}
