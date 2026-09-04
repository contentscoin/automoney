export const SETTLEMENT_LABEL: Record<string, string> = {
  DRAFT: "집계 완료(확정 대기)",
  CONFIRMED: "아뜨랑스 확정",
  APPROVED: "지급 승인",
  PAID: "지급 완료",
  HELD: "보류",
};
export const HELD_LABEL: Record<string, string> = {
  KYC_INCOMPLETE: "정산 정보(KYC) 미승인 — 승인 후 다음 정산에 합산",
  RECON_MISMATCH: "아뜨랑스 확정 데이터와 불일치 — 운영팀 확인 중",
  NEGATIVE_BALANCE: "차감액이 커서 다음 달로 이월",
};
export const LEVEL_LABEL: Record<string, string> = {
  ATTRANGS_TO_OPERATOR: "아뜨랑스 → 운영사",
  OPERATOR_TO_ADMIN: "운영사 → 총판",
  ADMIN_TO_USER: "총판 → 유저",
};
export const BENEFICIARY_LABEL: Record<string, string> = { USER: "유저", ADMIN: "총판", OPERATOR: "운영사" };
