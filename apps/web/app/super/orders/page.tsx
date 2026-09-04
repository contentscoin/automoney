"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { ORDER_LABEL, dateTime, won } from "@/lib/format";

export default function SuperOrdersPage() {
  const orders = useQuery(api.orders.listAll, { limit: 200 });
  return (
    <div>
      <h1 className="text-xl font-bold">주문 원장</h1>
      <p className="text-sm text-stone-500">아뜨랑스 웹훅으로 수신한 전체 주문입니다. 어트리뷰션이 없는 주문은 링크 미매칭 또는 24시간 창 초과입니다.</p>
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
