"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PieceCard } from "@/components/PieceCard";
import { dateTime, errorMessage } from "@/lib/format";
import { CHANNEL_LABEL, CHANNEL_ORDER, CURATION_KIND_LABEL } from "@/lib/content-format";

type Channel = (typeof CHANNEL_ORDER)[number];
type Tab = "PIECES" | "OUTFIT" | "MEME" | "TREND" | "PRODUCT_FACT" | "CELEB_MATCH";

export default function ContentPage() {
  const magazines = useQuery(api.magazines.list, { limit: 20 });
  const products = useQuery(api.products.search, { limit: 50 });
  const devices = useQuery(api.devices.listMine);
  const [tab, setTab] = useState<Tab>("PIECES");
  const [statusFilter, setStatusFilter] = useState<"" | "DRAFT" | "APPROVED">("");
  const library = useQuery(api.content.listLibrary, { status: statusFilter || undefined, limit: 100 });
  const curation = useQuery(api.curation.list, tab === "PIECES" ? "skip" : { kind: tab, limit: 60 });
  const requestGenerate = useMutation(api.content.requestGenerate);
  const approve = useMutation(api.content.approve);
  const reject = useMutation(api.content.reject);
  const edit = useMutation(api.content.edit);
  const buildFacts = useMutation(api.curation.buildProductFacts);
  const celebMatch = useAction(api.curation.celebMatch);
  const [f, setF] = useState<{ magazineId: string; productId: string; channels: Channel[] }>({ magazineId: "", productId: "", channels: ["THREADS", "INSTAGRAM_FEED"] });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasDevice = (devices ?? []).some((d) => d.status === "ACTIVE");
  const selectedMagazine = useQuery(api.magazines.get, f.magazineId ? { magazineId: f.magazineId as Id<"magazines"> } : "skip");

  const toggle = (c: Channel) => setF({ ...f, channels: f.channels.includes(c) ? f.channels.filter((x) => x !== c) : [...f.channels, c] });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">콘텐츠</h1>
        <p className="text-sm text-stone-500">매거진·상품 소재로 채널별 게시물을 만듭니다. 생성은 내 PC 의 에이전트(Codex 구독)가 수행하고, 품질 게이트(광고 표기·금칙 주장·길이)를 통과한 조각만 자동 승인됩니다.</p>
      </div>

      <section className="card">
        <h2 className="font-semibold">콘텐츠 생성 요청</h2>
        {!hasDevice && <p className="mt-1 text-sm text-amber-700">데스크톱 에이전트가 연결되어 있지 않습니다. 대시보드 &gt; 데스크톱 에이전트에서 페어링하세요.</p>}
        <form className="mt-2 grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await requestGenerate({ magazineId: (f.magazineId || undefined) as Id<"magazines"> | undefined, productId: (f.productId || undefined) as Id<"products"> | undefined, channels: f.channels });
            setMsg("생성 작업을 등록했습니다. 에이전트가 완료하면 아래 라이브러리에 나타납니다(작업 페이지에서 진행 상황 확인).");
          } catch (err) { setMsg(errorMessage(err)); } finally { setBusy(false); }
        }}>
          <div><label className="label">매거진</label><select className="input" value={f.magazineId} onChange={(e) => setF({ ...f, magazineId: e.target.value })}><option value="">선택 안 함</option>{magazines?.map((m) => <option key={m._id} value={m._id}>{m.title} ({m.atomCount}소재·{m.productCount}상품)</option>)}</select></div>
          <div><label className="label">상품</label><select className="input" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}><option value="">선택 안 함</option>{(f.magazineId && selectedMagazine ? selectedMagazine.products : products ?? []).map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}</select></div>
          <div className="sm:col-span-2 flex flex-wrap gap-3 text-sm">
            {CHANNEL_ORDER.map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={f.channels.includes(c)} onChange={() => toggle(c)} />{CHANNEL_LABEL[c]}</label>)}
          </div>
          <div className="sm:col-span-2 flex items-center gap-3">
            <button className="btn-primary" disabled={busy || !hasDevice || f.channels.length === 0 || (!f.magazineId && !f.productId)}>생성 요청</button>
            {f.productId && <button type="button" className="btn-ghost" onClick={async () => { try { const r = await buildFacts({ productId: f.productId as Id<"products"> }); setMsg(`제품 정보 ${r.inserted + r.updated}건 갱신`); } catch (err) { setMsg(errorMessage(err)); } }}>제품 정보 팩 만들기</button>}
            {f.productId && <button type="button" className="btn-ghost" onClick={async () => { try { const r = await celebMatch({ productId: f.productId as Id<"products"> }); setMsg(r.found ? `연예인 착용 후보 ${r.found}건 (출처 링크만 저장)` : `검색 프로바이더(${r.provider}) 미설정 — 운영자가 키를 등록하면 활성화됩니다.`); } catch (err) { setMsg(errorMessage(err)); } }}>연예인 착용 검색</button>}
          </div>
        </form>
        {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
        {selectedMagazine && (
          <details className="mt-3 text-sm"><summary className="cursor-pointer text-stone-600">매거진 소재 {selectedMagazine.atoms.length}개 보기</summary>
            <ul className="mt-1 grid gap-1 text-xs">{selectedMagazine.atoms.map((a) => <li key={a._id}><span className="rounded bg-stone-100 px-1">{a.atomType}</span> {a.text}</li>)}</ul>
          </details>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold">오늘의 매거진</h2>
        {magazines?.length === 0 && <p className="mt-1 text-sm text-stone-500">등록된 매거진이 없습니다. 운영자가 아뜨랑스 매거진 URL 을 등록하면 소재가 생깁니다.</p>}
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {magazines?.slice(0, 6).map((m) => (
            <li key={m._id} className="flex gap-3 rounded-lg border border-stone-200 p-2">
              {m.heroImage && <img src={m.heroImage} alt="" className="h-16 w-16 rounded object-cover" />}
              <div className="min-w-0 text-sm">
                <div className="truncate font-medium">{m.title}</div>
                <div className="truncate text-xs text-stone-500">{m.description ?? ""}</div>
                <div className="text-xs text-stone-500">{dateTime(m.ingestedAt)} · 소재 {m.atomCount} · 상품 {m.productCount}</div>
                <button className="mt-1 text-xs underline" onClick={() => { setF({ ...f, magazineId: m._id, productId: "" }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>이 매거진으로 생성</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(["PIECES", "OUTFIT", "MEME", "TREND", "PRODUCT_FACT", "CELEB_MATCH"] as Tab[]).map((k) => (
            <button key={k} className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? "bg-orange-50 font-medium text-orange-800" : "text-stone-700 hover:bg-stone-100"}`} onClick={() => setTab(k)}>{k === "PIECES" ? "콘텐츠 라이브러리" : CURATION_KIND_LABEL[k]}</button>
          ))}
          {tab === "PIECES" && <select className="input ml-auto w-auto py-1 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "" | "DRAFT" | "APPROVED")}><option value="">전체</option><option value="APPROVED">승인</option><option value="DRAFT">검토 필요</option></select>}
        </div>
        {tab === "PIECES" ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {library?.length === 0 && <p className="text-sm text-stone-500">아직 콘텐츠가 없습니다. 위에서 생성을 요청하세요.</p>}
            {library?.map((p) => (
              <PieceCard key={p._id} p={p}
                onApprove={async () => { try { await approve({ pieceId: p._id }); } catch (err) { setMsg(errorMessage(err)); } }}
                onReject={async (reason) => { try { await reject({ pieceId: p._id, reason }); } catch (err) { setMsg(errorMessage(err)); } }}
                onEdit={async (v) => { try { await edit({ pieceId: p._id, ...v }); } catch (err) { setMsg(errorMessage(err)); } }} />
            ))}
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="table">
              <thead><tr><th>제목</th><th>내용</th><th>출처</th><th>라이선스</th><th>점수</th><th>수집</th></tr></thead>
              <tbody>
                {curation?.length === 0 && <tr><td colSpan={6} className="text-center text-stone-500">항목이 없습니다.{tab === "TREND" ? " 트렌드는 6시간마다 구글 트렌드(KR)에서 갱신됩니다." : tab === "PRODUCT_FACT" ? " 위에서 상품을 고르고 '제품 정보 팩 만들기'를 누르세요." : tab === "OUTFIT" ? " 매거진이 등록되면 테마별 코디 세트가 자동으로 만들어집니다." : ""}</td></tr>}
                {curation?.map((c) => (
                  <tr key={c._id}>
                    <td className="text-sm font-medium">{c.mediaUrl && <img src={c.mediaUrl} alt="" className="mr-2 inline h-8 w-8 rounded object-cover" />}{c.title}</td>
                    <td className="max-w-md whitespace-pre-wrap text-xs">{c.body ?? ""}</td>
                    <td className="text-xs">{c.sourceUrl ? <a className="underline" href={c.sourceUrl} target="_blank" rel="noreferrer">{c.source}</a> : c.source}</td>
                    <td className="max-w-xs text-xs text-stone-500">{c.licenseNote ?? "-"}</td>
                    <td className="text-xs">{c.score}</td>
                    <td className="text-xs">{dateTime(c.fetchedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
