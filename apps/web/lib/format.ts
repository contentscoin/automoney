export const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
export const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
export const dateTime = (ts: number) =>
  new Date(ts).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });
export const date = (ts: number) => new Date(ts).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "data" in e) {
    const data = (e as { data?: unknown }).data;
    if (data && typeof data === "object" && "message" in data) return String((data as { message: unknown }).message);
    if (typeof data === "string") return data;
  }
  if (e instanceof Error) {
    const m = e.message.match(/"message":"([^"]+)"/);
    if (m?.[1]) return m[1];
    if (e.message.includes("InvalidSecret") || e.message.includes("InvalidAccountId")) return "이메일 또는 비밀번호가 올바르지 않습니다.";
    return e.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}

export const KYC_LABEL: Record<string, string> = { SUBMITTED: "검수 대기", APPROVED: "승인", REJECTED: "반려" };
export const ORDER_LABEL: Record<string, string> = { PAID: "결제완료", CANCELLED: "취소", REFUNDED: "반품", CONFIRMED: "구매확정" };
export const ROLE_LABEL: Record<string, string> = { USER: "유저", ADMIN: "총판", SUPER_ADMIN: "수퍼어드민" };
