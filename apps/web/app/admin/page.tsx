"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { KYC_LABEL, dateTime, errorMessage, won } from "@/lib/format";

export default function AdminPage() {
  const me = useQuery(api.users.me);
  const summary = useQuery(api.dashboard.adminSummary, {});
  const invites = useQuery(api.invites.listMine);
  const team = useQuery(api.users.listTeam, {});
  const create = useMutation(api.invites.create);
  const deactivate = useMutation(api.invites.deactivate);
  const [msg, setMsg] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  if (me && me.role === "USER") return <p className="text-sm text-rose-700">총판 권한이 없습니다.</p>;
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-bold">총판 관리</h1>
        <p className="text-sm text-stone-500">{summary?.month} · 하부 유저 {summary?.memberCount ?? 0}명 · 총판 차액 정산은 M2 에서 제공됩니다.</p>
      </div>

      {summary && (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="stat"><span className="k">팀 클릭</span><span className="v">{summary.total.clicks.toLocaleString()}</span></div>
          <div className="stat"><span className="k">팀 주문</span><span className="v">{summary.total.orders.toLocaleString()}</span></div>
          <div className="stat"><span className="k">팀 매출</span><span className="v">{won(summary.total.sales)}</span></div>
          <div className="stat"><span className="k">팀 유저 예상 수당</span><span className="v">{won(summary.total.estimatedCommission)}</span></div>
        </section>
      )}

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">초대 코드</h2>
          <button
            className="btn-primary"
            onClick={async () => {
              try {
                const r = await create({ maxUses: 20, expiresInDays: 30 });
                setMsg(`초대 코드 ${r.code} 가 생성되었습니다.`);
              } catch (e) {
                setMsg(errorMessage(e));
              }
            }}
          >
            새 초대 코드 (20명 · 30일)
          </button>
        </div>
        {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
        <table className="table mt-3">
          <thead><tr><th>코드</th><th>가입 링크</th><th>사용</th><th>만료</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {invites?.map((i) => (
              <tr key={i._id}>
                <td className="font-mono">{i.code}</td>
                <td><button className="text-xs underline" onClick={() => navigator.clipboard.writeText(`${origin}/signup?invite=${i.code}`)}>복사</button></td>
                <td className="tabular-nums">{i.usedCount}/{i.maxUses}</td>
                <td className="text-xs">{i.expiresAt ? dateTime(i.expiresAt) : "-"}</td>
                <td><Badge value={i.active ? "ACTIVE" : "DISABLED"} label={i.active ? "활성" : "중지"} /></td>
                <td>{i.active && <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => deactivate({ id: i._id })}>중지</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold">하부 유저 실적 ({summary?.month})</h2>
        <table className="table mt-3">
          <thead><tr><th>유저</th><th>KYC</th><th>클릭</th><th>주문</th><th>매출</th><th>예상 수당</th><th>가입일</th></tr></thead>
          <tbody>
            {summary?.rows.length === 0 && <tr><td colSpan={7} className="text-center text-stone-500">아직 하부 유저가 없습니다. 초대 코드를 공유하세요.</td></tr>}
            {summary?.rows.map((r) => {
              const u = team?.find((t) => t._id === r.userId);
              return (
                <tr key={r.userId}>
                  <td>{r.name || r.email}</td>
                  <td>{u?.kycStatus ? <Badge value={u.kycStatus} label={KYC_LABEL[u.kycStatus]} /> : <span className="text-xs text-stone-400">미등록</span>}</td>
                  <td className="tabular-nums">{r.clicks}</td>
                  <td className="tabular-nums">{r.orders}</td>
                  <td className="tabular-nums">{won(r.sales)}</td>
                  <td className="tabular-nums">{won(r.estimatedCommission)}</td>
                  <td className="text-xs">{u ? dateTime(u.createdAt) : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
