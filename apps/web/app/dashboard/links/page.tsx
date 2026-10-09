"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { useReadiness } from "@/components/use-readiness";
import { dateTime, errorMessage, won } from "@/lib/format";

function linkOrigin(link: unknown): string | undefined {
  return (link as { origin?: string }).origin;
}

function isDemoLink(link: unknown): boolean {
  return ["MOCK", "DEMO"].includes(linkOrigin(link) ?? "");
}

export default function LinksPage() {
  const [term, setTerm] = useState("");
  const products = useQuery(api.products.search, { term: term || undefined, limit: 24 });
  const links = useQuery(api.links.listMine);
  const readiness = useReadiness();
  const issue = useAction(api.links.issue);
  const setStatus = useMutation(api.links.setStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const linkByProduct = new Map<string, NonNullable<typeof links>[number]>();
  for (const link of links ?? []) {
    if (!link.product?._id) continue;
    const selected = linkByProduct.get(link.product._id);
    if (!selected
      || (link.status === "ACTIVE" && selected.status !== "ACTIVE")
      || (link.status === selected.status && link.issuedAt > selected.issuedAt)) {
      linkByProduct.set(link.product._id, link);
    }
  }
  const hasDemoLinks = links?.some(isDemoLink) ?? false;
  const realLinksAvailable = readiness?.partnerMode === "pool";
  const demoMode = readiness?.partnerMode === "mock";

  const shortUrl = (code: string) => `${origin}/r/${code}`;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      throw new Error("클립보드에 접근할 수 없습니다. 표에 표시된 단축 링크를 직접 선택해 복사하세요.");
    }
    setMsg("링크를 복사했습니다.");
  };
  const perform = async (key: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = key;
    setBusy(key);
    setMsg(null);
    setHasError(false);
    try {
      await action();
    } catch (error) {
      setHasError(true);
      setMsg(errorMessage(error));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };
  const issueAndCopy = async (productId: Id<"products">) => {
    const result = await issue({ productId });
    await copy(shortUrl(result.shortCode));
  };

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-bold">내 마케팅 링크</h1><p className="text-sm text-stone-500">상품별 링크의 상태와 실적을 관리합니다.</p></div><Link className="btn-primary" href="/dashboard/content/mine">콘텐츠 보관함</Link></div>
        {(hasDemoLinks || demoMode) && <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status"><strong>{demoMode ? "현재 데모 링크가 발급됩니다." : "데모 링크가 포함되어 있습니다."}</strong> 데모 링크는 제작·테스트용이며 실제 제휴 수익 추적과 SNS 실게시에는 사용할 수 없습니다. {realLinksAvailable ? "사용할 상품에서 ‘실제 링크로 전환’을 선택하세요." : "운영팀이 실제 제휴 링크를 준비하면 전환할 수 있습니다."}</p>}
        {msg && <p className={`mt-2 text-sm ${hasError ? "text-red-700" : "text-emerald-700"}`} role={hasError ? "alert" : "status"}>{msg}</p>}
        <div className="relative mt-4 overflow-x-auto" role="region" aria-label="발급 링크 목록 · 가로로 스크롤할 수 있습니다" tabIndex={0}>
          <table className="table">
            <thead><tr><th>상품</th><th>단축 링크</th><th>유형</th><th>클릭</th><th>상태</th><th>발급일</th><th><span className="sr-only">링크 관리</span></th></tr></thead>
            <tbody>
              {links === undefined && <tr><td colSpan={7} className="text-center text-stone-500">링크를 불러오는 중입니다.</td></tr>}
              {links?.length === 0 && <tr><td colSpan={7} className="text-center text-stone-500">아직 발급한 링크가 없습니다. 아래에서 상품을 골라 발급하세요.</td></tr>}
              {links?.map((l) => (
                <tr key={l._id}>
                  <td className="max-w-xs truncate" title={l.product?.name ?? "삭제된 상품"}>{l.product?.name ?? "(삭제된 상품)"}</td>
                  <td>
                    <button type="button" className="font-mono text-xs underline disabled:opacity-50" disabled={busy !== null} aria-label={`${l.product?.name ?? "상품"} 단축 링크 복사`} onClick={() => perform(`copy:${l._id}`, () => copy(shortUrl(l.shortCode)))}>{busy === `copy:${l._id}` ? "복사 중…" : shortUrl(l.shortCode)}</button>
                  </td>
                  <td className="text-xs">{isDemoLink(l) ? <span className="font-medium text-amber-800">데모 · 수익 추적 안 됨</span> : linkOrigin(l) === "POOL" || linkOrigin(l) === "API" ? "실제" : "기존"}</td>
                  <td className="tabular-nums">{l.clickCount}</td>
                  <td><Badge value={l.status} label={l.status === "ACTIVE" ? "활성" : "중지"} /></td>
                  <td className="text-xs text-stone-500">{dateTime(l.issuedAt)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {isDemoLink(l) && realLinksAvailable && l.product && linkByProduct.get(l.product._id)?._id === l._id && <button type="button" className="btn-primary !px-2 !py-1 text-xs" disabled={busy !== null} onClick={() => perform(`issue:${l.product!._id}`, () => issueAndCopy(l.product!._id))}>{busy === `issue:${l.product._id}` ? "전환 중…" : "실제 링크로 전환"}</button>}
                      {!(isDemoLink(l) && realLinksAvailable && l.status !== "ACTIVE") && <button type="button" className="btn-ghost !px-2 !py-1 text-xs" disabled={busy !== null} onClick={() => perform(`status:${l._id}`, async () => {
                        const status = l.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
                        await setStatus({ linkId: l._id, status });
                        setMsg(status === "ACTIVE" ? "링크를 다시 활성화했습니다." : "링크를 중지했습니다.");
                      })}>
                        {busy === `status:${l._id}` ? "변경 중…" : l.status === "ACTIVE" ? "중지" : "재개"}
                      </button>}
                    </div>
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
          <label className="w-full max-w-xs"><span className="sr-only">상품명 검색</span><input className="input" type="search" placeholder="상품명 검색" value={term} onChange={(e) => setTerm(e.target.value)} /></label>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products?.length === 0 && <p className="text-sm text-stone-500">{term.trim() ? "검색 결과가 없습니다. 다른 상품명으로 검색하세요." : "등록된 상품이 없습니다. 운영팀이 상품을 동기화하면 표시됩니다."}</p>}
          {products?.map((p) => {
            const existing = linkByProduct.get(p._id);
            const active = existing?.status === "ACTIVE";
            const upgrade = !!existing && isDemoLink(existing) && realLinksAvailable;
            return (
              <div key={p._id} className="card flex flex-col gap-2">
                {p.imageUrls[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrls[0]} alt={`${p.name} 상품 이미지`} className="aspect-[3/4] w-full rounded-lg object-cover" />
                ) : (
                  <div className="aspect-[3/4] w-full rounded-lg bg-stone-100" />
                )}
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-sm text-stone-600">
                  {p.salePrice ? (<><span className="font-semibold">{won(p.salePrice)}</span> <s className="text-xs">{won(p.price)}</s></>) : won(p.price)}
                </div>
                <button
                  type="button"
                  className={active && !upgrade ? "btn-ghost" : "btn-primary"}
                  disabled={busy !== null || readiness === undefined}
                  onClick={() => perform(`issue:${p._id}`, () => active && !upgrade ? copy(shortUrl(existing!.shortCode)) : issueAndCopy(p._id))}
                >
                  {busy === `issue:${p._id}` ? "준비 중…" : readiness === undefined ? "발급 상태 확인 중…" : upgrade ? "실제 링크로 전환" : active ? isDemoLink(existing) ? "데모 링크 복사" : "링크 복사" : existing ? "링크 재개 후 복사" : demoMode ? "데모 링크 발급" : "링크 발급"}
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
