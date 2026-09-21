"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage, won } from "@/lib/format";
import type { Id } from "@/convex/_generated/dataModel";

export default function SuperProductsPage() {
  const products = useQuery(api.products.listAll);
  const previewProducts = useMutation(api.imports.previewProducts);
  const applyProducts = useMutation(api.imports.applyProducts);
  const previewLinkPool = useMutation(api.imports.previewLinkPool);
  const applyLinkPool = useMutation(api.imports.applyLinkPool);
  const sync = useAction(api.products.syncFromAttrangs);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ batchId: Id<"importBatches">; validRows: number; errorRows: number } | null>(null);
  const [pendingLinks, setPendingLinks] = useState<{ batchId: Id<"importBatches">; errorRows: number } | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">상품</h1>
        <p className="text-sm text-stone-500">아뜨랑스 파트너 API 연동 전까지 CSV 업로드 또는 샘플 동기화로 상품을 등록합니다.</p>
      </div>
      <div className="card flex flex-wrap items-center gap-3">
        <label className="btn-ghost cursor-pointer">
          CSV 업로드
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0]; if (!f) return; setBusy(true);
            try { const r = await previewProducts({ csv: await f.text() }); setPending({ batchId: r.batchId, validRows: r.validRows, errorRows: r.errorRows }); setMsg(`미리보기: 유효 ${r.validRows} · 오류 ${r.errorRows}${r.duplicate ? " · 기존 배치" : ""}`); }
            catch (err) { setMsg(errorMessage(err)); } finally { setBusy(false); e.target.value = ""; }
          }} />
        </label>
        {pending && <button className="btn-primary" disabled={busy || pending.errorRows > 0} onClick={async () => {
          setBusy(true);
          try {
            let completed = false; let applied = 0;
            while (!completed) { const r = await applyProducts({ batchId: pending.batchId }); completed = r.completed; applied += r.applied; }
            setMsg(`상품 배치 적용 완료 · ${applied}행`); setPending(null);
          } catch (err) { setMsg(errorMessage(err)); } finally { setBusy(false); }
        }}>검증된 배치 적용</button>}
        <label className="btn-ghost cursor-pointer">링크 풀 CSV<input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => {
          const file = e.target.files?.[0]; if (!file) return; setBusy(true);
          try { const result = await previewLinkPool({ csv: await file.text() }); setPendingLinks({ batchId: result.batchId, errorRows: result.errorRows }); setMsg(`링크 풀 미리보기: 유효 ${result.validRows} · 오류 ${result.errorRows}`); } catch (err) { setMsg(errorMessage(err)); } finally { setBusy(false); e.target.value = ""; }
        }} /></label>
        {pendingLinks && <button className="btn-primary" disabled={busy || pendingLinks.errorRows > 0} onClick={async () => {
          setBusy(true); try { let completed = false; let applied = 0; while (!completed) { const result = await applyLinkPool({ batchId: pendingLinks.batchId }); completed = result.completed; applied += result.applied; } setMsg(`링크 풀 적용 완료 · ${applied}행`); setPendingLinks(null); } catch (err) { setMsg(errorMessage(err)); } finally { setBusy(false); }
        }}>링크 풀 적용</button>}
        <button className="btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { const r = await sync(); setMsg(`샘플 동기화: 추가 ${r.inserted} · 갱신 ${r.updated}`); } catch (err) { setMsg(errorMessage(err)); } finally { setBusy(false); } }}>
          샘플 상품 동기화 (Mock)
        </button>
        <a className="text-xs underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent("product_id,name,price,sale_price,category,image_urls,detail_url,status\n100001,플라워 원피스,39000,35000,원피스,https://example.com/1.jpg|https://example.com/2.jpg,https://attrangs.co.kr/shop/view.php?index_no=100001,active\n")}`} download="products-template.csv">CSV 템플릿</a>
        {msg && <span className="text-sm text-stone-700">{msg}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead><tr><th>ID</th><th>상품명</th><th>카테고리</th><th>정가</th><th>판매가</th><th>상태</th><th>출처</th><th>동기화</th></tr></thead>
          <tbody>
            {products?.map((p) => (
              <tr key={p._id}>
                <td className="font-mono text-xs">{p.attrangsProductId}</td>
                <td>{p.name}</td>
                <td>{p.category ?? "-"}</td>
                <td className="tabular-nums">{won(p.price)}</td>
                <td className="tabular-nums">{p.salePrice ? won(p.salePrice) : "-"}</td>
                <td><Badge value={p.status} label={p.status === "ACTIVE" ? "판매중" : "중지"} /></td>
                <td className="text-xs">{p.source}</td>
                <td className="text-xs">{dateTime(p.syncedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
