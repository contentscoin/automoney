"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { ORDER_LABEL, dateTime, errorMessage, won } from "@/lib/format";
import type { Id } from "@/convex/_generated/dataModel";

export default function SuperOrdersPage() {
  const orders = useQuery(api.orders.listAll, { limit: 200 });
  const previewOrders = useMutation(api.imports.previewOrders);
  const applyOrders = useMutation(api.imports.applyOrders);
  const [pending, setPending] = useState<{ batchId: Id<"importBatches">; errorRows: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <h1 className="text-xl font-bold">주문 원장</h1>
      <p className="text-sm text-stone-500">아뜨랑스 웹훅으로 수신한 전체 주문입니다. 어트리뷰션이 없는 주문은 링크 미매칭 또는 24시간 창 초과입니다.</p>
      <div className="card mt-4 flex flex-wrap items-center gap-3">
        <label className="btn-ghost cursor-pointer">주문 CSV 미리보기<input className="hidden" type="file" accept=".csv,text/csv" onChange={async (e) => {
          const file = e.target.files?.[0]; if (!file) return; setBusy(true);
          try { const result = await previewOrders({ csv: await file.text() }); setPending({ batchId: result.batchId, errorRows: result.errorRows }); setMessage(`유효 ${result.validRows} · 오류 ${result.errorRows}${result.duplicate ? " · 기존 배치" : ""}`); }
          catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); e.target.value = ""; }
        }} /></label>
        {pending && <button className="btn-primary" disabled={busy || pending.errorRows > 0} onClick={async () => {
          setBusy(true); try { let completed = false; let applied = 0; let quarantined = 0; while (!completed) { const result = await applyOrders({ batchId: pending.batchId }); completed = result.completed; applied += result.applied; quarantined += result.quarantined; } setMessage(`적용 ${applied} · 격리 ${quarantined}`); setPending(null); } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
        }}>검증된 주문 적용</button>}
        {message && <span className="text-sm text-stone-700">{message}</span>}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="table">
          <thead><tr><th>주문번호</th><th>주문일시</th><th>트래킹코드</th><th>어트리뷰션</th><th>주문금액</th><th>기준금액</th><th>상태</th><th>유저 예상 수당</th></tr></thead>
          <tbody>
            {orders?.length === 0 && <tr><td colSpan={8} className="text-center text-stone-500">수신된 주문이 없습니다.</td></tr>}
            {orders?.map((o) => (
              <tr key={o._id}>
                <td className="font-mono text-xs">{o.attrangsOrderId}</td>
                <td className="text-xs">{dateTime(o.orderedAt)}</td>
                <td className="font-mono text-xs">{o.trackingCode ?? "-"}</td>
                <td>{o.attribution ? <Badge value={o.attribution} label={o.attribution === "DIRECT" ? "직접" : "간접"} /> : <span className="text-xs text-stone-400">없음</span>}</td>
                <td className="tabular-nums">{won(o.orderAmount)}</td>
                <td className="tabular-nums">{won(o.commissionableAmount)}</td>
                <td><Badge value={o.status} label={ORDER_LABEL[o.status]} /></td>
                <td className="tabular-nums">{o.attribution === "DIRECT" ? won(o.estimatedCommission) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
