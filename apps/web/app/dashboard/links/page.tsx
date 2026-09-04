"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage, won } from "@/lib/format";

export default function LinksPage() {
  const [term, setTerm] = useState("");
  const products = useQuery(api.products.search, { term: term || undefined, limit: 24 });
  const links = useQuery(api.links.listMine);
  const issue = useAction(api.links.issue);
  const setStatus = useMutation(api.links.setStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const linkedProductIds = new Set((links ?? []).map((l) => l.product?._id));

  const shortUrl = (code: string) => `${origin}/r/${code}`;
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setMsg("링크를 복사했습니다.");
    setTimeout(() => setMsg(null), 1500);
  };

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-xl font-bold">내 마케팅 링크</h1>
        {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
        <div className="mt-4 overflow-x-auto">
          <table className="table">
            <thead><tr><th>상품</th><th>단축 링크</th><th>클릭</th><th>상태</th><th>발급일</th><th></th></tr></thead>
            <tbody>
              {links?.length === 0 && <tr><td colSpan={6} className="text-center text-stone-500">아직 발급한 링크가 없습니다. 아래에서 상품을 골라 발급하세요.</td></tr>}
              {links?.map((l) => (
                <tr key={l._id}>
                  <td className="max-w-xs truncate">{l.product?.name ?? "(삭제된 상품)"}</td>
                  <td>
                    <button className="font-mono text-xs underline" onClick={() => copy(shortUrl(l.shortCode))}>{shortUrl(l.shortCode)}</button>
                  </td>
                  <td className="tabular-nums">{l.clickCount}</td>
                  <td><Badge value={l.status} label={l.status === "ACTIVE" ? "활성" : "중지"} /></td>
                  <td className="text-xs text-stone-500">{dateTime(l.issuedAt)}</td>
                  <td>
                    <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setStatus({ linkId: l._id, status: l.status === "ACTIVE" ? "DISABLED" : "ACTIVE" })}>
                      {l.status === "ACTIVE" ? "중지" : "재개"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">상품 찾기</h2>
          <input className="input max-w-xs" placeholder="상품명 검색" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products?.length === 0 && <p className="text-sm text-stone-500">등록된 상품이 없습니다. 운영팀이 상품을 동기화하면 표시됩니다.</p>}
          {products?.map((p) => {
            const has = linkedProductIds.has(p._id);
            return (
              <div key={p._id} className="card flex flex-col gap-2">
                {p.imageUrls[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrls[0]} alt="" className="aspect-[3/4] w-full rounded-lg object-cover" />
                ) : (
                  <div className="aspect-[3/4] w-full rounded-lg bg-stone-100" />
                )}
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-sm text-stone-600">
                  {p.salePrice ? (<><span className="font-semibold">{won(p.salePrice)}</span> <s className="text-xs">{won(p.price)}</s></>) : won(p.price)}
                </div>
                <button
                  className={has ? "btn-ghost" : "btn-primary"}
                  disabled={busy === p._id}
                  onClick={async () => {
                    setBusy(p._id);
                    try {
                      const r = await issue({ productId: p._id as Id<"products"> });
                      await copy(shortUrl(r.shortCode));
                    } catch (e) {
                      setMsg(errorMessage(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === p._id ? "발급 중…" : has ? "링크 복사" : "링크 발급"}
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
