"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { pct, won } from "@/lib/format";

export default function SuperPage() {
  const s = useQuery(api.dashboard.superSummary, {});
  if (!s) return <p className="text-sm text-stone-500">불러오는 중…</p>;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">운영 대시보드</h1>
        <p className="text-sm text-stone-500">{s.month} · 기본 유저 요율 {pct(s.rateBps)} · 간접구매와 운영사 차액은 이 화면에서만 표시됩니다.</p>
      </div>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="stat"><span className="k">유저 / 총판</span><span className="v">{s.counts.users} / {s.counts.admins}</span></div>
        <div className="stat"><span className="k">KYC 대기</span><span className="v">{s.counts.pendingKyc}</span><Link href="/super/kyc" className="text-xs underline">검수하기</Link></div>
        <div className="stat"><span className="k">활성 상품</span><span className="v">{s.counts.activeProducts}</span></div>
        <div className="stat"><span className="k">발급 링크</span><span className="v">{s.counts.links}</span></div>
        <div className="stat"><span className="k">이번 달 클릭</span><span className="v">{s.clicks.toLocaleString()}</span></div>
      </section>
      <section className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <h2 className="font-semibold">직접구매 (유저 노출)</h2>
          <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-stone-500">주문</dt><dd className="tabular-nums">{s.direct.orders}</dd>
            <dt className="text-stone-500">매출</dt><dd className="tabular-nums">{won(s.direct.sales)}</dd>
            <dt className="text-stone-500">수당 기준금액</dt><dd className="tabular-nums">{won(s.direct.commissionable)}</dd>
            <dt className="text-stone-500">유저 예상 수당 합계</dt><dd className="tabular-nums font-medium">{won(s.direct.estimatedUserCommission)}</dd>
          </dl>
        </div>
        <div className="card border-violet-200 bg-violet-50/40">
          <h2 className="font-semibold">간접구매 (24h · 수퍼어드민 전용)</h2>
          <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-stone-500">주문</dt><dd className="tabular-nums">{s.indirect.orders}</dd>
            <dt className="text-stone-500">매출</dt><dd className="tabular-nums">{won(s.indirect.sales)}</dd>
            <dt className="text-stone-500">수당 기준금액</dt><dd className="tabular-nums">{won(s.indirect.commissionable)}</dd>
          </dl>
          <dl className="mt-3 grid grid-cols-2 gap-y-1 border-t border-violet-200 pt-2 text-sm">
            <dt className="text-stone-500">운영사 차액(원장)</dt><dd className="tabular-nums font-medium">{won(s.margins.operator)}</dd>
            <dt className="text-stone-500">└ 간접구매 기여</dt><dd className="tabular-nums">{won(s.margins.operatorIndirect)}</dd>
            <dt className="text-stone-500">총판 차액 합계</dt><dd className="tabular-nums">{won(s.margins.admin)}</dd>
            <dt className="text-stone-500">유저 수당 합계</dt><dd className="tabular-nums">{won(s.margins.user)}</dd>
          </dl>
          <Link href="/super/settlements" className="mt-2 inline-block text-xs underline">정산 관리로</Link>
        </div>
      </section>
    </div>
  );
}
