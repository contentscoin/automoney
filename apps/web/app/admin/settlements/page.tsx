"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { won } from "@/lib/format";
import { SETTLEMENT_LABEL } from "@/lib/settlement-format";

function monthOptions(n = 6) {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export default function AdminSettlementsPage() {
  const [month, setMonth] = useState(monthOptions()[0]!);
  const data = useQuery(api.settlements.adminMonth, { month });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">총판 정산</h1>
          <p className="text-sm text-stone-500">하부 유저 실적에서 발생한 총판 차액(운영사→총판 요율 − 유저 요율)입니다.</p>
        </div>
        <select className="input !w-auto" value={month} onChange={(e) => setMonth(e.target.value)}>
          {monthOptions().map((m) => <option key={m}>{m}</option>)}
        </select>
      </div>
      {data && (
        <>
          <section className="grid gap-4 sm:grid-cols-3">
            <div className="stat"><span className="k">이번 달 총판 차액</span><span className="v" style={{ color: "var(--accent)" }}>{won(data.adminMargin)}</span></div>
            <div className="stat"><span className="k">직접구매 기여분</span><span className="v">{won(data.adminMarginDirect)}</span></div>
            <div className="stat"><span className="k">정산 상태</span><span className="v text-base">{data.settlement ? <Badge value={data.settlement.status === "PAID" ? "APPROVED" : "PENDING"} label={SETTLEMENT_LABEL[data.settlement.status]} /> : <span className="text-stone-400">미마감</span>}</span></div>
          </section>
          <section className="card overflow-x-auto">
            <h2 className="font-semibold">하부 유저별 유저 수당 ({data.memberCount}명)</h2>
            <table className="table mt-3">
              <thead><tr><th>유저</th><th>수당 항목</th><th>유저 수당</th></tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={3} className="text-center text-stone-500">하부 유저가 없습니다.</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.userId}><td>{r.name || r.email}</td><td className="tabular-nums">{r.orders}</td><td className="tabular-nums">{won(r.userCommission)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
