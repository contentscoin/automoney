"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { date, won } from "@/lib/format";
import { BENEFICIARY_LABEL, HELD_LABEL, SETTLEMENT_LABEL } from "@/lib/settlement-format";

export default function SettlementsPage() {
  const rows = useQuery(api.settlements.listMine);
  return (
    <div>
      <h1 className="text-xl font-bold">정산 히스토리</h1>
      <p className="text-sm text-stone-500">매월 초 전월 실적을 집계하고, 아뜨랑스 확정 후 지급됩니다. 원천징수와 지급은 아뜨랑스에서 처리합니다.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="table">
          <thead><tr><th>정산월</th><th>구분</th><th>금액</th><th>상태</th><th>지급일</th><th></th></tr></thead>
          <tbody>
            {rows?.length === 0 && <tr><td colSpan={6} className="text-center text-stone-500">아직 정산 내역이 없습니다.</td></tr>}
            {rows?.map((s) => (
              <tr key={s._id}>
                <td className="font-medium">{s.month}</td>
                <td>{BENEFICIARY_LABEL[s.beneficiaryType]}</td>
                <td className="tabular-nums">{won(s.grossAmount)}</td>
                <td>
                  <Badge value={s.status === "HELD" ? "SUSPENDED" : s.status === "PAID" ? "APPROVED" : "PENDING"} label={SETTLEMENT_LABEL[s.status]} />
                  {s.heldReason && <div className="mt-1 text-xs text-stone-500">{HELD_LABEL[s.heldReason] ?? s.heldReason}</div>}
                </td>
                <td className="text-xs">{s.paidAt ? date(s.paidAt) : "-"}</td>
                <td>{s.status !== "HELD" && <Link href={`/dashboard/settlements/${s._id}`} className="text-xs underline">명세서</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
