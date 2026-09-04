"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { ORDER_LABEL, dateTime, won } from "@/lib/format";

export default function OrdersPage() {
  const orders = useQuery(api.orders.listMine, { limit: 100 });
  return (
    <div>
      <h1 className="text-xl font-bold">주문 실적</h1>
      <p className="text-sm text-stone-500">내 링크로 발생한 직접 구매 주문입니다. 취소·반품 주문은 수당에서 제외됩니다.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="table">
          <thead><tr><th>주문번호</th><th>주문일시</th><th>수량</th><th>주문금액</th><th>수당 기준금액</th><th>상태</th><th>예상 수당</th></tr></thead>
          <tbody>
            {orders?.length === 0 && <tr><td colSpan={7} className="text-center text-stone-500">아직 주문이 없습니다.</td></tr>}
            {orders?.map((o) => (
              <tr key={o._id}>
                <td className="font-mono text-xs">{o.attrangsOrderId}</td>
                <td className="text-xs">{dateTime(o.orderedAt)}</td>
                <td className="tabular-nums">{o.quantity}</td>
                <td className="tabular-nums">{won(o.orderAmount)}</td>
                <td className="tabular-nums">{won(o.commissionableAmount)}</td>
                <td><Badge value={o.status} label={ORDER_LABEL[o.status]} /></td>
                <td className="tabular-nums font-medium">{won(o.estimatedCommission)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
