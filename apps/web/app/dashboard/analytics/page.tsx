"use client";

import { useQuery } from "convex/react";
import { DIMENSION_LABEL, VARIANT_LABEL } from "@automoney/shared";
import { api } from "@/convex/_generated/api";
import { dateTime } from "@/lib/format";
import { CHANNEL_LABEL } from "@/lib/content-format";

export default function AnalyticsPage() {
  const data = useQuery(api.analytics.listMine, { limit: 100 });
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">성과 분석</h1>
        <p className="text-sm text-stone-500">게시 후 24h·72h·7d 지표(좋아요·댓글 등은 Meta API 또는 브라우저 readback, 클릭·주문·매출은 자체 원장)를 모으고, 훅·CTA·시간대별로 검증된 패턴을 플레이북으로 승격해 다음 생성에 반영합니다.</p>
      </div>
      <section className="grid gap-3 lg:grid-cols-3">
        {(["HOOK", "CTA", "HOUR"] as const).map((dim) => (
          <div key={dim} className="card">
            <h2 className="font-semibold">{DIMENSION_LABEL[dim]}</h2>
            <table className="table mt-2"><thead><tr><th>변형</th><th>게시</th><th>클릭</th><th>반응</th></tr></thead>
              <tbody>
                {Object.entries(data?.byDim[dim] ?? {}).length === 0 && <tr><td colSpan={4} className="text-center text-xs text-stone-500">측정된 게시물이 없습니다.</td></tr>}
                {Object.entries(data?.byDim[dim] ?? {}).sort((a, b) => b[1].clicks - a[1].clicks).map(([k, v]) => <tr key={k}><td className="text-xs">{VARIANT_LABEL[k] ?? k}</td><td className="text-xs">{v.posts}</td><td className="text-xs">{v.clicks}</td><td className="text-xs">{v.engagement}</td></tr>)}
              </tbody>
            </table>
          </div>
        ))}
      </section>
      <section className="card">
        <h2 className="font-semibold">내 플레이북</h2>
        <p className="text-xs text-stone-500">표본 {data?.minSamples ?? 20}건 이상 · 대조군 대비 15% 이상 · 유의성 통과 시 자동 승격. 콘텐츠 생성 프롬프트에 「검증된 패턴」으로 주입됩니다.</p>
        <ul className="mt-2 grid gap-1 text-sm">
          {(data?.playbooks ?? []).flatMap((p) => p.rules.map((r) => <li key={`${p.channel}-${r.dimension}-${r.variant}`}>[{CHANNEL_LABEL[p.channel] ?? p.channel}] {DIMENSION_LABEL[r.dimension]} · {VARIANT_LABEL[r.variant] ?? r.variant} · +{Math.round(r.lift * 100)}% ({r.samples}건)</li>))}
          {(data?.globalPlaybooks ?? []).flatMap((p) => p.rules.map((r) => <li key={`g-${p.channel}-${r.dimension}-${r.variant}`} className="text-stone-600">[전역 · {CHANNEL_LABEL[p.channel] ?? p.channel}] {DIMENSION_LABEL[r.dimension]} · {VARIANT_LABEL[r.variant] ?? r.variant} · +{Math.round(r.lift * 100)}%</li>))}
          {data && data.playbooks.length === 0 && data.globalPlaybooks.length === 0 && <li className="text-stone-500">아직 승격된 패턴이 없습니다.</li>}
        </ul>
      </section>
      <section className="card overflow-x-auto">
        <h2 className="font-semibold">게시물별 지표</h2>
        <table className="table mt-2">
          <thead><tr><th>게시</th><th>채널</th><th>훅/CTA/시간대</th><th>24h</th><th>72h</th><th>7d</th><th>다음</th></tr></thead>
          <tbody>
            {data?.posts.length === 0 && <tr><td colSpan={7} className="text-center text-stone-500">게시 완료된 작업이 없습니다.</td></tr>}
            {data?.posts.map((p) => {
              const cell = (w: "24h" | "72h" | "7d") => {
                const s = p.snapshots.find((x) => x.window === w);
                if (!s) return <span className="text-stone-400">-</span>;
                return <span title={s.source}>👍{s.likes ?? "-"} 💬{s.comments ?? "-"} · 클릭 {s.clicks} · 주문 {s.orders}</span>;
              };
              return (
                <tr key={p._id}>
                  <td className="text-xs"><a className="underline" href={p.postUrl} target="_blank" rel="noreferrer">{dateTime(p.postedAt)}</a><div className="text-stone-500">{p.spaceName ?? ""}</div></td>
                  <td className="text-xs">{CHANNEL_LABEL[p.channel] ?? p.channel}</td>
                  <td className="text-xs">{VARIANT_LABEL[p.hookType]} / {VARIANT_LABEL[p.ctaType]} / {VARIANT_LABEL[p.hourBucket]}</td>
                  <td className="text-xs">{cell("24h")}</td><td className="text-xs">{cell("72h")}</td><td className="text-xs">{cell("7d")}</td>
                  <td className="text-xs">{p.done ? "완료" : p.nextWindowAt ? `${p.nextWindow} · ${dateTime(p.nextWindowAt)}` : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
