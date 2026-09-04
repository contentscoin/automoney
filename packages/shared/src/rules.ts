import type { Attribution } from "./constants";

export type RuleLevel = "ATTRANGS_TO_OPERATOR" | "OPERATOR_TO_ADMIN" | "ADMIN_TO_USER";
export type RuleAttribution = Attribution | "ANY";

/** 요율 규칙 (docs/03-settlement.md §2). Convex `commissionRules` 문서와 필드 계약을 공유한다. */
export interface CommissionRule {
  level: RuleLevel;
  attribution: RuleAttribution;
  grade?: string | null;
  rateBps: number;
  validFrom: number;
  validTo?: number | null;
  scopeUserId?: string | null;
  scopeAdminId?: string | null;
  active: boolean;
}

export interface GradeTier {
  grade: string;
  minMonthlySales: number;
  attrangsRateBps: number;
  active: boolean;
}

export interface RateContext {
  at: number;
  attribution: Attribution;
  userId: string | null;
  adminId: string | null;
  grade: string;
}

function applies(rule: CommissionRule, ctx: RateContext): boolean {
  if (!rule.active) return false;
  if (rule.validFrom > ctx.at) return false;
  if (rule.validTo != null && rule.validTo <= ctx.at) return false;
  if (rule.attribution !== "ANY" && rule.attribution !== ctx.attribution) return false;
  return true;
}

/**
 * 규칙 우선순위: 유저 예외 > 총판 예외 > 전역. 동률이면 validFrom 이 최신, 그다음 나중에 생성된 규칙.
 * 특정 attribution 규칙이 ANY 보다 우선한다.
 */
function pick(rules: CommissionRule[], level: RuleLevel, ctx: RateContext, gradeFilter: boolean): CommissionRule | null {
  const scored = rules
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.level === level && applies(r, ctx))
    .map(({ r, index }) => {
      let score = 0;
      if (r.scopeUserId) {
        if (r.scopeUserId !== ctx.userId) return null;
        score += 1000;
      }
      if (r.scopeAdminId) {
        if (r.scopeAdminId !== ctx.adminId) return null;
        score += 100;
      }
      if (gradeFilter) {
        if (r.grade && r.grade !== ctx.grade) return null;
        if (r.grade) score += 50;
      }
      if (r.attribution !== "ANY") score += 10;
      return { r, score, index };
    })
    .filter((x): x is { r: CommissionRule; score: number; index: number } => x !== null)
    // 동률: validFrom 최신 → 배열 뒤쪽(나중에 생성된 규칙) 우선
    .sort((a, b) => b.score - a.score || b.r.validFrom - a.r.validFrom || b.index - a.index);
  return scored[0]?.r ?? null;
}

export interface ResolvedRates {
  attrangsRateBps: number;
  adminRateBps: number | null;
  userRateBps: number;
  sources: { attrangs: CommissionRule | null; admin: CommissionRule | null; user: CommissionRule | null };
}

/**
 * 주문 하나에 적용할 3단계 요율을 해석한다.
 * - 총판이 없는 유저는 adminRateBps = null (운영사 차액 = 아뜨랑스 − 유저).
 * - 매칭 규칙이 없으면 0bps 로 간주한다(수당 없음). 아뜨랑스 요율은 grade 규칙이 없으면 tier 값을 사용한다.
 */
export function resolveRates(rules: CommissionRule[], tiers: GradeTier[], ctx: RateContext): ResolvedRates {
  const attrangsRule = pick(rules, "ATTRANGS_TO_OPERATOR", ctx, true);
  const tier = tiers.find((t) => t.active && t.grade === ctx.grade) ?? null;
  const attrangsRateBps = attrangsRule?.rateBps ?? tier?.attrangsRateBps ?? 0;
  const adminRule = ctx.adminId ? pick(rules, "OPERATOR_TO_ADMIN", ctx, false) : null;
  const userRule = pick(rules, "ADMIN_TO_USER", ctx, false);
  return {
    attrangsRateBps,
    adminRateBps: ctx.adminId ? (adminRule?.rateBps ?? 0) : null,
    userRateBps: userRule?.rateBps ?? 0,
    sources: { attrangs: attrangsRule, admin: adminRule, user: userRule },
  };
}

/** 월 매출(수당 기준금액 합계)로 그레이드 결정. 구간 하한이 큰 순으로 첫 매칭. */
export function pickGrade(tiers: GradeTier[], monthlySales: number): GradeTier | null {
  const active = tiers.filter((t) => t.active).sort((a, b) => b.minMonthlySales - a.minMonthlySales);
  return active.find((t) => monthlySales >= t.minMonthlySales) ?? active[active.length - 1] ?? null;
}

/** 기본 시드 (수퍼어드민이 변경). 사용자 결정: 간접구매 유저 0bps. */
export const DEFAULT_COMMISSION_RULES: Omit<CommissionRule, "validFrom">[] = [
  { level: "ADMIN_TO_USER", attribution: "DIRECT", rateBps: 500, active: true },
  { level: "ADMIN_TO_USER", attribution: "INDIRECT", rateBps: 0, active: true },
  { level: "OPERATOR_TO_ADMIN", attribution: "DIRECT", rateBps: 800, active: true },
  { level: "OPERATOR_TO_ADMIN", attribution: "INDIRECT", rateBps: 300, active: true },
];

export const DEFAULT_GRADE_TIERS: GradeTier[] = [
  { grade: "G1", minMonthlySales: 0, attrangsRateBps: 1500, active: true },
  { grade: "G2", minMonthlySales: 30_000_000, attrangsRateBps: 1800, active: true },
  { grade: "G3", minMonthlySales: 100_000_000, attrangsRateBps: 2000, active: true },
];
