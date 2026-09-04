/**
 * 수당 계산. M1 은 단일 유저 요율만 사용하고, M2 에서 3단계(운영사→총판→유저) 분배로 확장한다.
 * 요율은 basis points 정수, 원 단위 내림 (docs/03-settlement.md §2.1).
 */
export function applyRateBps(baseAmount: number, rateBps: number): number {
  if (!Number.isFinite(baseAmount) || baseAmount < 0) throw new Error("baseAmount must be >= 0");
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new Error("rateBps must be an integer in [0, 10000]");
  }
  return Math.floor((baseAmount * rateBps) / 10000);
}

export function estimateUserCommission(commissionableAmount: number, userRateBps: number): number {
  return applyRateBps(commissionableAmount, userRateBps);
}

/** 3단계 분배 (M2 본구현 전 미리 고정한 계약). 반올림 차액은 운영사에 귀속. */
export function splitThreeLevel(input: {
  baseAmount: number;
  attrangsRateBps: number;
  adminRateBps: number | null;
  userRateBps: number;
}): { user: number; admin: number; operator: number; total: number } {
  const total = applyRateBps(input.baseAmount, input.attrangsRateBps);
  const user = applyRateBps(input.baseAmount, input.userRateBps);
  const adminGross = input.adminRateBps === null ? user : applyRateBps(input.baseAmount, input.adminRateBps);
  const admin = Math.max(0, adminGross - user);
  const operator = Math.max(0, total - user - admin);
  return { user, admin, operator, total };
}
