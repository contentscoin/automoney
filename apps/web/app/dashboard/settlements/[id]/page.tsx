"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dateTime, pct, won } from "@/lib/format";
import { BENEFICIARY_LABEL, SETTLEMENT_LABEL } from "@/lib/settlement-format";

export default function StatementPage() {
  const { id } = useParams<{ id: string }>();
  const st = useQuery(api.settlements.getStatement, { id: id as Id<"settlements"> });
  if (st === undefined) return <p className="text-sm text-stone-500">불러오는 중…</p>;
  const s = st.settlement;
  const total = st.lines.reduce((a, l) => a + l.amount, 0);
  return (
    <div className="mx-auto max-w-3xl">
      <style>{`@media print { aside, header, .no-print { display: none !important; } main { padding: 0 !important; } .card { box-shadow: none; border-color: #999; } }`}</style>
      <div className="no-print mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">정산 명세서</h1>
        <button className="btn-primary" onClick={() => window.print()}>PDF로 저장 / 인쇄</button>
      </div>
      <div className="card">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-bold">automoney 정산 명세서</div>
            <div className="text-sm text-stone-600">{s.month} 실적 · {BENEFICIARY_LABEL[s.beneficiaryType]} 수당</div>
          </div>
          <div className="text-right text-sm">
            <div>상태: {SETTLEMENT_LABEL[s.status]}</div>
            {s.paidAt && <div>지급일: {dateTime(s.paidAt)}{s.paidRef ? ` (${s.paidRef})` : ""}</div>}
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-stone-500">수령인</dt><dd>{st.payee?.legalName ?? st.beneficiary?.name ?? "-"} ({st.beneficiary?.email})</dd>
          <dt className="text-stone-500">입금 계좌</dt><dd>{st.payee ? `${st.payee.bankName} ${st.payee.accountNoMasked}` : "-"}</dd>
          <dt className="text-stone-500">항목 수</dt><dd>{st.lines.length}건</dd>
        </dl>
        <table className="table mt-5">
          <thead><tr><th>주문번호</th><th>주문일시</th><th>실적월</th><th>구분</th><th>기준금액</th><th>요율</th><th>수당</th></tr></thead>
          <tbody>
            {st.lines.map((l) => (
              <tr key={l.entryId}>
                <td className="font-mono text-xs">{l.attrangsOrderId}</td>
                <td className="text-xs">{dateTime(l.orderedAt)}</td>
                <td className="text-xs">{l.month}</td>
                <td className="text-xs">{l.attribution === "DIRECT" ? "직접" : "간접"}</td>
                <td className="tabular-nums">{won(l.baseAmount)}</td>
                <td className="tabular-nums">{pct(l.rateBps)}</td>
                <td className={`tabular-nums ${l.amount < 0 ? "text-rose-700" : ""}`}>{won(l.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={6} className="text-right font-semibold">합계</td><td className="tabular-nums font-bold">{won(total)}</td></tr>
          </tfoot>
        </table>
        <p className="mt-4 text-xs text-stone-500">본 금액은 세전 금액이며, 원천징수와 지급은 아뜨랑스에서 처리합니다. 취소·반품 건은 음수로 차감됩니다.</p>
      </div>
    </div>
  );
}
