"use client";

import { useMutation, useQuery } from "convex/react";
import { DIMENSION_LABEL, VARIANT_LABEL } from "@automoney/shared";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { CHANNEL_LABEL } from "@/lib/content-format";

export default function SuperAnalyticsPage() {
  const data = useQuery(api.analytics.superOverview);
  const setStatus = useMutation(api.analytics.setExperimentStatus);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">실험 원장 · 전역 플레이북</h1>
        <p className="text-sm text-stone-500">모든 유저의 7d 확정 지표를 채널×차원×변형으로 누적합니다. 자동 승격 기준(표본 {data?.minSamples ?? 20}·+15%·유의성) 외에 수동 승격/철회할 수 있으며, 전역 플레이북은 개인 플레이북 뒤에 힌트로 주입됩니다.</p>
      </div>
      <section className="grid gap-3 sm:grid-cols-4">
        {data && [["측정 게시물", data.totals.posts], ["7d 확정", data.totals.done], ["진행 중", data.totals.pending], ["Meta API 게시", data.totals.withApi]].map(([k, v]) => <div key={String(k)} className="card"><div className="text-xs text-stone-500">{k}</div><div className="text-2xl font-bold">{v}</div></div>)}
      </section>
      <section className="card overflow-x-auto">
        <h2 className="font-semibold">전역 실험</h2>
        <table className="table mt-2">
          <thead><tr><th>채널</th><th>차원</th><th>변형</th><th>표본</th><th>평균 클릭</th><th>평균 반응</th><th>주문</th><th>개선</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {data?.experiments.length === 0 && <tr><td colSpan={10} className="text-center text-stone-500">확정된 실험이 없습니다.</td></tr>}
            {data?.experiments.map((e) => (
              <tr key={e._id}>
                <td className="text-xs">{CHANNEL_LABEL[e.channel] ?? e.channel}</td><td className="text-xs">{DIMENSION_LABEL[e.dimension]}</td><td className="text-xs">{VARIANT_LABEL[e.variant] ?? e.variant}</td>
                <td className="text-xs">{e.samples}</td><td className="text-xs">{e.avgClicks.toFixed(2)}</td><td className="text-xs">{e.avgEngagement.toFixed(1)}</td><td className="text-xs">{e.orders}</td>
                <td className="text-xs">{e.lift === null ? "-" : `${e.lift >= 0 ? "+" : ""}${Math.round(e.lift * 100)}%`}</td>
                <td><Badge value={e.status === "PROMOTED" ? "ACTIVE" : e.status === "RETIRED" ? "DISABLED" : "PENDING"} label={e.status === "PROMOTED" ? "승격" : e.status === "RETIRED" ? "철회" : "진행"} /></td>
                <td className="whitespace-nowrap text-xs">
                  {e.status !== "PROMOTED" && <button className="btn-ghost !px-2 !py-1" onClick={() => setStatus({ experimentId: e._id, status: "PROMOTED" })}>승격</button>}
                  {e.status !== "RETIRED" && <button className="btn-ghost !px-2 !py-1" onClick={() => setStatus({ experimentId: e._id, status: "RETIRED" })}>철회</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2 className="font-semibold">전역 플레이북</h2>
        <ul className="mt-2 grid gap-1 text-sm">
          {data?.playbooks.flatMap((p) => p.rules.map((r) => <li key={`${p.channel}-${r.dimension}-${r.variant}`}>[{CHANNEL_LABEL[p.channel] ?? p.channel}] {DIMENSION_LABEL[r.dimension]} · {VARIANT_LABEL[r.variant] ?? r.variant} · +{Math.round(r.lift * 100)}% ({r.samples}건)</li>))}
          {data && data.playbooks.every((p) => p.rules.length === 0) && <li className="text-stone-500">승격된 규칙이 없습니다.</li>}
        </ul>
      </section>
    </div>
  );
}
