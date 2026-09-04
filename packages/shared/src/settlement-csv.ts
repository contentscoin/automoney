import { parseCsv } from "./csv";

/** 아뜨랑스 월 정산 확정 배치 (docs/04-integrations.md §1.4) — CSV 폴백 형식 */
export interface AttrangsSettlementRow {
  orderId: string;
  commissionableAmount: number;
  attribution: "DIRECT" | "INDIRECT";
  status: "CONFIRMED" | "CANCELLED" | "REFUNDED";
}

export interface AttrangsSettlementBatch {
  month: string;
  grade: string;
  rateBps: number;
  payoutTotal: number;
  orders: AttrangsSettlementRow[];
}

/**
 * 헤더 행: `month,grade,rate_bps,payout_total` + 값 1행, 빈 줄, 그 다음 주문 표 헤더
 * `order_id,commissionable_amount,attribution,status`.
 * 단순화를 위해 두 표를 한 파일에 담되, 첫 표의 컬럼명으로 구분한다.
 */
export function parseAttrangsSettlementCsv(text: string): { ok: true; batch: AttrangsSettlementBatch } | { ok: false; error: string } {
  const rows = parseCsv(text);
  if (rows.length < 4) return { ok: false, error: "too few rows" };
  const h1 = rows[0]!.map((s) => s.trim().toLowerCase());
  const need1 = ["month", "grade", "rate_bps", "payout_total"];
  if (need1.some((c) => !h1.includes(c))) return { ok: false, error: "missing summary columns" };
  const v1 = rows[1]!;
  const get1 = (c: string) => (v1[h1.indexOf(c)] ?? "").trim();
  const month = get1("month");
  const grade = get1("grade");
  const rateBps = Number(get1("rate_bps"));
  const payoutTotal = Number(get1("payout_total"));
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: "month must be YYYY-MM" };
  if (!grade) return { ok: false, error: "grade empty" };
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) return { ok: false, error: "rate_bps invalid" };
  if (!Number.isFinite(payoutTotal) || payoutTotal < 0) return { ok: false, error: "payout_total invalid" };

  const headerIdx = rows.findIndex((r, i) => i >= 2 && r.map((s) => s.trim().toLowerCase()).includes("order_id"));
  if (headerIdx < 0) return { ok: false, error: "missing orders table" };
  const h2 = rows[headerIdx]!.map((s) => s.trim().toLowerCase());
  const need2 = ["order_id", "commissionable_amount", "attribution", "status"];
  if (need2.some((c) => !h2.includes(c))) return { ok: false, error: "missing order columns" };
  const orders: AttrangsSettlementRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const get = (c: string) => (r[h2.indexOf(c)] ?? "").trim();
    const orderId = get("order_id");
    if (!orderId) continue;
    const amt = Number(get("commissionable_amount"));
    const attribution = get("attribution").toUpperCase();
    const status = get("status").toUpperCase();
    if (!Number.isFinite(amt) || amt < 0) return { ok: false, error: `row ${i + 1}: amount invalid` };
    if (attribution !== "DIRECT" && attribution !== "INDIRECT") return { ok: false, error: `row ${i + 1}: attribution invalid` };
    if (!["CONFIRMED", "CANCELLED", "REFUNDED"].includes(status)) return { ok: false, error: `row ${i + 1}: status invalid` };
    orders.push({ orderId, commissionableAmount: amt, attribution, status: status as AttrangsSettlementRow["status"] });
  }
  if (orders.length === 0) return { ok: false, error: "no orders" };
  return { ok: true, batch: { month, grade, rateBps, payoutTotal, orders } };
}

/** 확정 배치 CSV 생성 (테스트·E2E·아뜨랑스 샘플 제공용) */
export function buildAttrangsSettlementCsv(batch: AttrangsSettlementBatch): string {
  const lines = [
    "month,grade,rate_bps,payout_total",
    `${batch.month},${batch.grade},${batch.rateBps},${batch.payoutTotal}`,
    "",
    "order_id,commissionable_amount,attribution,status",
    ...batch.orders.map((o) => `${o.orderId},${o.commissionableAmount},${o.attribution},${o.status}`),
  ];
  return lines.join("\n");
}
