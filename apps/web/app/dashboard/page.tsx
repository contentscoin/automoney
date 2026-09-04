"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { KYC_LABEL, pct, won } from "@/lib/format";

export default function DashboardPage() {
  const s = useQuery(api.dashboard.userSummary);
  if (!s) return <p className="text-sm text-stone-500">불러오는 중…</p>;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">대시보드</h1>
        <p className="text-sm text-stone-500">{s.month} · 내 요율 {pct(s.rateBps)} · 실적은 아뜨랑스 확정 전 추정치입니다.</p>
      </div>

      {s.kycStatus !== "APPROVED" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {s.kycStatus === null && (
            <>정산을 받으려면 <Link href="/dashboard/kyc" className="font-medium underline">정산 정보(KYC)</Link>를 등록해야 합니다. 등록 전에도 링크 발급과 실적 집계는 가능합니다.</>
          )}
          {s.kycStatus === "SUBMITTED" && <>정산 정보가 검수 대기 중입니다. 승인되면 정산이 지급됩니다.</>}
          {s.kycStatus === "REJECTED" && (
            <>정산 정보가 반려되었습니다. <Link href="/dashboard/kyc" className="font-medium underline">다시 제출</Link>해 주세요.</>
          )}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="stat"><span className="k">이번 달 클릭</span><span className="v">{s.current.clicks.toLocaleString()}</span></div>
        <div className="stat"><span className="k">이번 달 주문</span><span className="v">{s.current.orders.toLocaleString()}</span></div>
        <div className="stat"><span className="k">이번 달 매출</span><span className="v">{won(s.current.sales)}</span></div>
        <div className="stat"><span className="k">이번 달 예상 수당</span><span className="v" style={{ color: "var(--accent)" }}>{won(s.current.estimatedCommission)}</span></div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <h2 className="font-semibold">다음 달 정산 예정 ({s.nextSettlement.month} 실적)</h2>
          <p className="mt-2 text-3xl font-bold tabular-nums">{won(s.nextSettlement.estimatedCommission)}</p>
          <p className="mt-1 text-xs text-stone-500">
            주문 {s.nextSettlement.orders}건 · 매출 {won(s.nextSettlement.sales)} · 아뜨랑스 확정 후 금액이 변동될 수 있습니다.
          </p>
          <div className="mt-3 text-sm">
            지급 조건: <Badge value={s.kycStatus ?? "PENDING"} label={s.kycStatus ? KYC_LABEL[s.kycStatus] : "KYC 미등록"} />
          </div>
        </div>
        <div className="card">
          <h2 className="font-semibold">내 링크</h2>
          <p className="mt-2 text-3xl font-bold tabular-nums">{s.activeLinkCount} <span className="text-base font-normal text-stone-500">/ {s.linkCount}개 활성</span></p>
          <Link href="/dashboard/links" className="btn-primary mt-3">상품 고르고 링크 발급</Link>
        </div>
      </section>
    </div>
  );
}
