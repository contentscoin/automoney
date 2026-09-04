"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { errorMessage, pct, won } from "@/lib/format";
import { LEVEL_LABEL } from "@/lib/settlement-format";

type Level = "ATTRANGS_TO_OPERATOR" | "OPERATOR_TO_ADMIN" | "ADMIN_TO_USER";
type Attr = "DIRECT" | "INDIRECT" | "ANY";

export default function RulesPage() {
  const data = useQuery(api.commissionRules.list);
  const seed = useMutation(api.commissionRules.seedDefaults);
  const upsertRule = useMutation(api.commissionRules.upsertRule);
  const setActive = useMutation(api.commissionRules.setRuleActive);
  const upsertTier = useMutation(api.commissionRules.upsertTier);
  const recompute = useMutation(api.commissionRules.recompute);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<{ level: Level; attribution: Attr; grade: string; rateBps: string; note: string }>({ level: "ADMIN_TO_USER", attribution: "DIRECT", grade: "", rateBps: "", note: "" });
  const [tier, setTier] = useState({ grade: "", minMonthlySales: "", attrangsRateBps: "" });
  const [month, setMonth] = useState("");

  const wrap = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); } catch (e) { setMsg(errorMessage(e)); } };
  if (!data) return <p className="text-sm text-stone-500">불러오는 중…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">요율 · 그레이드</h1>
          <p className="text-sm text-stone-500">3단계 마진: 아뜨랑스→운영사(그레이드별) → 운영사→총판 → 총판→유저. 간접구매 유저 요율은 기본 0.</p>
        </div>
        {data.rules.length === 0 && <button className="btn-primary" onClick={() => wrap(() => seed({}), "기본 요율을 시드했습니다.")}>기본 요율 시드</button>}
      </div>
      {msg && <p className="text-sm text-stone-700">{msg}</p>}

      <section className="card overflow-x-auto">
        <h2 className="font-semibold">요율 규칙</h2>
        <table className="table mt-2">
          <thead><tr><th>단계</th><th>구분</th><th>그레이드</th><th>요율</th><th>범위</th><th>유효</th><th>메모</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r._id} className={r.active ? "" : "opacity-50"}>
                <td>{LEVEL_LABEL[r.level]}</td>
                <td>{r.attribution === "ANY" ? "전체" : r.attribution === "DIRECT" ? "직접" : "간접"}</td>
                <td>{r.grade ?? "-"}</td>
                <td className="tabular-nums">{pct(r.rateBps)} <span className="text-xs text-stone-400">({r.rateBps}bps)</span></td>
                <td className="text-xs">{r.scopeUserId ? "유저 예외" : r.scopeAdminId ? "총판 예외" : "전역"}</td>
                <td className="text-xs">{r.validFrom ? new Date(r.validFrom).toLocaleDateString("ko-KR") : "-"} ~ {r.validTo ? new Date(r.validTo).toLocaleDateString("ko-KR") : ""}</td>
                <td className="text-xs">{r.note ?? ""}</td>
                <td className="text-xs">{r.active ? "활성" : "중지"}</td>
                <td><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => wrap(() => setActive({ id: r._id, active: !r.active }), "변경했습니다.")}>{r.active ? "중지" : "활성"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void wrap(() => upsertRule({ level: form.level, attribution: form.attribution, grade: form.grade || undefined, rateBps: Number(form.rateBps), validFrom: Date.now(), note: form.note || undefined }), "규칙을 추가했습니다. 미정산 월은 아래에서 재계산하세요."); }}>
          <div><label className="label">단계</label><select className="input" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as Level })}>{Object.entries(LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label className="label">구분</label><select className="input" value={form.attribution} onChange={(e) => setForm({ ...form, attribution: e.target.value as Attr })}><option value="DIRECT">직접</option><option value="INDIRECT">간접</option><option value="ANY">전체</option></select></div>
          <div><label className="label">그레이드(아뜨랑스 단계만)</label><input className="input" value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} placeholder="G1" /></div>
          <div><label className="label">요율(bps)</label><input className="input" type="number" min={0} max={10000} required value={form.rateBps} onChange={(e) => setForm({ ...form, rateBps: e.target.value })} /></div>
          <div><label className="label">메모</label><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          <button className="btn-primary">규칙 추가 (지금부터 유효)</button>
        </form>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold">그레이드 구간 (운영사 월 수당 기준금액 합계)</h2>
        <table className="table mt-2">
          <thead><tr><th>그레이드</th><th>월 기준금액 하한</th><th>아뜨랑스 지급률</th><th>상태</th></tr></thead>
          <tbody>{data.tiers.map((t) => <tr key={t._id}><td>{t.grade}</td><td className="tabular-nums">{won(t.minMonthlySales)}</td><td className="tabular-nums">{pct(t.attrangsRateBps)}</td><td className="text-xs">{t.active ? "활성" : "중지"}</td></tr>)}</tbody>
        </table>
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const ex = data.tiers.find((t) => t.grade === tier.grade); void wrap(() => upsertTier({ id: ex?._id, grade: tier.grade, minMonthlySales: Number(tier.minMonthlySales), attrangsRateBps: Number(tier.attrangsRateBps), active: true }), "그레이드를 저장했습니다."); }}>
          <div><label className="label">그레이드</label><input className="input" required value={tier.grade} onChange={(e) => setTier({ ...tier, grade: e.target.value })} /></div>
          <div><label className="label">하한(원)</label><input className="input" type="number" min={0} required value={tier.minMonthlySales} onChange={(e) => setTier({ ...tier, minMonthlySales: e.target.value })} /></div>
          <div><label className="label">지급률(bps)</label><input className="input" type="number" min={0} max={10000} required value={tier.attrangsRateBps} onChange={(e) => setTier({ ...tier, attrangsRateBps: e.target.value })} /></div>
          <button className="btn-primary">저장</button>
        </form>
      </section>

      <section className="card flex flex-wrap items-end gap-2">
        <div><label className="label">미정산 월 재계산 (YYYY-MM)</label><input className="input" placeholder="2026-09" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
        <button className="btn-ghost" onClick={() => wrap(() => recompute({ month }), `${month} 재계산 완료`)}>재계산</button>
        <p className="w-full text-xs text-stone-500">이미 CONFIRMED 이상인 정산 항목은 변경되지 않으며, 차이는 다음 정산의 조정 항목으로 남습니다.</p>
      </section>
    </div>
  );
}
