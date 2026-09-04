"use client";

import Link from "next/link";
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage, pct, won } from "@/lib/format";
import { BENEFICIARY_LABEL, HELD_LABEL, SETTLEMENT_LABEL } from "@/lib/settlement-format";

export default function SuperSettlementsPage() {
  const months = useQuery(api.settlements.listMonths);
  const [month, setMonth] = useState<string | null>(null);
  const selected = month ?? months?.[1] ?? months?.[0] ?? null;
  const data = useQuery(api.settlements.superMonth, selected ? { month: selected } : "skip");
  const closeMonth = useMutation(api.settlements.closeMonth);
  const upload = useMutation(api.settlements.uploadBatchCsv);
  const reconcile = useMutation(api.settlements.reconcile);
  const approve = useMutation(api.settlements.approve);
  const exportPayout = useAction(api.settlements.exportPayout);
  const markPaid = useMutation(api.settlements.markPaid);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg(`${label} 완료${r && typeof r === "object" ? `: ${JSON.stringify(r).slice(0, 200)}` : ""}`);
    } catch (e) {
      setMsg(`${label} 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!months || !selected) return <p className="text-sm text-stone-500">불러오는 중…</p>;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">정산 관리</h1>
          <p className="text-sm text-stone-500">마감 → 아뜨랑스 확정 배치 업로드 → 리컨실(0원 오차) → 승인 → 지급 파일 → 지급 완료</p>
        </div>
        <select className="input !w-auto" value={selected} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => <option key={m}>{m}</option>)}
        </select>
      </div>

      {data && (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="stat"><span className="k">그레이드</span><span className="v">{data.grade}</span><span className="text-xs text-stone-500">{data.gradeSource === "ATTRANGS" ? "아뜨랑스 확정" : "잠정(누계 기준)"} · v{data.computationVersion}</span></div>
            <div className="stat"><span className="k">아뜨랑스 수취 총액(원장)</span><span className="v">{won(data.totals.total)}</span></div>
            <div className="stat"><span className="k">운영사 차액</span><span className="v" style={{ color: "var(--accent)" }}>{won(data.totals.operator)}</span></div>
            <div className="stat"><span className="k">총판 차액 합계</span><span className="v">{won(data.totals.admin)}</span></div>
            <div className="stat"><span className="k">유저 수당 합계</span><span className="v">{won(data.totals.user)}</span></div>
          </section>
          <section className="grid gap-4 md:grid-cols-2">
            <div className="card text-sm">
              <div className="flex justify-between"><span className="text-stone-500">직접구매 수당 총액</span><b className="tabular-nums">{won(data.totals.directTotal)}</b></div>
              <div className="mt-1 flex justify-between"><span className="text-stone-500">간접구매 수당 총액 (수퍼어드민 전용)</span><b className="tabular-nums">{won(data.totals.indirectTotal)}</b></div>
              <div className="mt-1 flex justify-between"><span className="text-stone-500">마감</span><span>{data.closedAt ? dateTime(data.closedAt) : "미마감"}</span></div>
            </div>
            <div className="card text-sm">
              <div className="font-semibold">아뜨랑스 확정 배치</div>
              {data.batch ? (
                <dl className="mt-1 grid grid-cols-2 gap-y-1">
                  <dt className="text-stone-500">그레이드 / 요율</dt><dd>{data.batch.grade} / {pct(data.batch.rateBps)}</dd>
                  <dt className="text-stone-500">payout_total</dt><dd className="tabular-nums">{won(data.batch.payoutTotal)}</dd>
                  <dt className="text-stone-500">주문 수</dt><dd>{data.batch.orders}</dd>
                  <dt className="text-stone-500">리컨실</dt><dd>{data.batch.reconciledAt ? `${dateTime(data.batch.reconciledAt)} · 차이 ${won(data.batch.diffAmount ?? 0)}` : "미실행"}</dd>
                </dl>
              ) : <p className="mt-1 text-stone-500">업로드된 배치가 없습니다.</p>}
            </div>
          </section>

          <section className="card flex flex-wrap items-center gap-2">
            <button className="btn-ghost" disabled={busy} onClick={() => run("월 마감", () => closeMonth({ month: selected }))}>① 월 마감</button>
            <label className="btn-ghost cursor-pointer">
              ② 확정 배치 CSV 업로드
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; await run("배치 업로드", async () => upload({ csv: await f.text() })); e.target.value = ""; }} />
            </label>
            <button className="btn-ghost" disabled={busy || !data.batch} onClick={() => run("리컨실", () => reconcile({ month: selected }))}>③ 리컨실</button>
            <button className="btn-ghost" disabled={busy} onClick={() => run("승인", () => approve({ month: selected }))}>④ 승인</button>
            <button className="btn-ghost" disabled={busy} onClick={() => run("지급 파일", async () => { const r = await exportPayout({ month: selected }); if (r.url) window.open(r.url, "_blank"); return r; })}>⑤ 지급 파일(아뜨랑스 전달)</button>
            <button className="btn-primary" disabled={busy} onClick={() => { const ref = prompt("아뜨랑스 지급 참조번호"); if (ref) void run("지급 완료", () => markPaid({ month: selected, paidRef: ref })); }}>⑥ 지급 완료</button>
            <a className="text-xs underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent("month,grade,rate_bps,payout_total\n2026-08,G1,1500,0\n\norder_id,commissionable_amount,attribution,status\nA20260801-0001,35000,DIRECT,CONFIRMED\n")}`} download="attrangs-settlement-template.csv">배치 CSV 템플릿</a>
            {msg && <p className="w-full text-sm text-stone-700">{msg}</p>}
          </section>

          {data.batch?.diffs && data.batch.diffs.length > 0 && (
            <section className="card">
              <h2 className="font-semibold text-rose-700">리컨실 불일치 {data.batch.diffs.length}건</h2>
              <table className="table mt-2">
                <thead><tr><th>유형</th><th>주문번호</th><th>내용</th></tr></thead>
                <tbody>{data.batch.diffs.map((d, i) => <tr key={i}><td className="font-mono text-xs">{d.kind}</td><td className="font-mono text-xs">{d.orderId}</td><td className="text-xs">{d.detail}</td></tr>)}</tbody>
              </table>
            </section>
          )}

          <section className="card overflow-x-auto">
            <h2 className="font-semibold">수혜자별 정산 ({data.settlements.length})</h2>
            <table className="table mt-2">
              <thead><tr><th>구분</th><th>수혜자</th><th>금액</th><th>항목</th><th>상태</th><th>지급</th><th></th></tr></thead>
              <tbody>
                {data.settlements.map((s) => (
                  <tr key={s._id}>
                    <td>{BENEFICIARY_LABEL[s.beneficiaryType]}</td>
                    <td>{s.beneficiary}</td>
                    <td className="tabular-nums">{won(s.grossAmount)}</td>
                    <td className="tabular-nums">{s.entryCount}</td>
                    <td><Badge value={s.status === "HELD" ? "SUSPENDED" : s.status === "PAID" ? "APPROVED" : "PENDING"} label={SETTLEMENT_LABEL[s.status]} />{s.heldReason && <div className="text-xs text-stone-500">{HELD_LABEL[s.heldReason] ?? s.heldReason}</div>}</td>
                    <td className="text-xs">{s.paidAt ? `${dateTime(s.paidAt)} ${s.paidRef ?? ""}` : "-"}</td>
                    <td>{s.status !== "HELD" && <Link href={`/dashboard/settlements/${s._id}`} className="text-xs underline">명세서</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
