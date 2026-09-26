"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
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
  const copyToMine = useMutation(api.content.copyToMine);
  const buildFacts = useMutation(api.curation.buildProductFacts);
  const celebMatch = useAction(api.curation.celebMatch);
  const [f, setF] = useState<{ magazineId: string; productId: string; channels: Channel[] }>({ magazineId: "", productId: "", channels: ["THREADS", "INSTAGRAM_FEED"] });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showJobsLink, setShowJobsLink] = useState(false);
  const [scope, setScope] = useState<"SHARED" | "MINE">("SHARED");
  const [librarySearch, setLibrarySearch] = useState("");
  const activeDevice = devices?.find((d) => d.status === "ACTIVE");
  const hasDevice = !!activeDevice;
  const deviceOnline = !!activeDevice?.online;
  const codexReady = !!(activeDevice?.snapshot as { codexLoggedIn?: boolean } | null | undefined)?.codexLoggedIn;
  const normalizedSearch = librarySearch.trim().toLocaleLowerCase("ko-KR");
  const visibleLibrary = library?.filter((piece) => scope === "MINE"
    ? piece.mine
    : piece.visibility === "SHARED" && piece.collectionStatus === "PUBLISHED")
    .filter((piece) => !normalizedSearch || [
      piece.collectionTitle,
      piece.collectionSummary,
      piece.productName,
      piece.caption,
      ...piece.hashtags,
      ...piece.collectionTags,
    ].filter(Boolean).join(" ").toLocaleLowerCase("ko-KR").includes(normalizedSearch)) ?? [];
  const selectedMagazine = useQuery(api.magazines.get, f.magazineId ? { magazineId: f.magazineId as Id<"magazines"> } : "skip");

  const toggle = (c: Channel) => setF({ ...f, channels: f.channels.includes(c) ? f.channels.filter((x) => x !== c) : [...f.channels, c] });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-xl font-bold">콘텐츠 찾기</h1><p className="text-sm text-stone-500">운영 제공 콘텐츠를 가져오거나 매거진·상품 소재로 내 초안을 만듭니다.</p></div>
        <div className="flex gap-2"><Link className="btn-ghost" href="/dashboard/content/mine">내 콘텐츠</Link><Link className="btn-primary" href="/dashboard/publish">게시하기</Link></div>
      </div>

      <section className="card">
        <h2 className="font-semibold">콘텐츠 생성 요청</h2>
        {!hasDevice && <p className="mt-1 text-sm text-amber-700">데스크톱 에이전트가 연결되어 있지 않습니다. <Link className="underline" href="/dashboard/connections">연결 관리에서 페어링하세요.</Link></p>}
        {hasDevice && !deviceOnline && <p className="mt-1 text-sm text-amber-700">PC 앱이 오프라인입니다. 앱을 실행하면 생성 요청을 보낼 수 있습니다.</p>}
        {deviceOnline && !codexReady && <p className="mt-1 text-sm text-stone-600">Codex가 준비되지 않아 AI 생성 실패 시 템플릿으로 대체됩니다. <Link className="underline" href="/dashboard/connections#ai">AI 연결 확인</Link></p>}
        <form className="mt-2 grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await requestGenerate({ magazineId: (f.magazineId || undefined) as Id<"magazines"> | undefined, productId: (f.productId || undefined) as Id<"products"> | undefined, channels: f.channels });
            setTab("PIECES");
            setScope("MINE");
            setStatusFilter("");
            setShowJobsLink(true);
            setMsg("생성 작업을 등록했습니다. 에이전트가 완료하면 아래 라이브러리에 나타납니다(작업 페이지에서 진행 상황 확인).");
          } catch (err) { setShowJobsLink(false); setMsg(errorMessage(err)); } finally { setBusy(false); }
        }}>
          <div><label className="label" htmlFor="content-magazine">매거진</label><select id="content-magazine" className="input" value={f.magazineId} onChange={(e) => setF({ ...f, magazineId: e.target.value })}><option value="">선택 안 함</option>{magazines?.map((m) => <option key={m._id} value={m._id}>{m.title} ({m.atomCount}소재·{m.productCount}상품)</option>)}</select></div>
          <div><label className="label" htmlFor="content-product">상품</label><select id="content-product" className="input" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}><option value="">선택 안 함</option>{(f.magazineId && selectedMagazine ? selectedMagazine.products : products ?? []).map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}</select></div>
          <fieldset className="sm:col-span-2 flex flex-wrap gap-3 text-sm">
            <legend className="label w-full">제작 채널</legend>
            {CHANNEL_ORDER.map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={f.channels.includes(c)} onChange={() => toggle(c)} />{CHANNEL_LABEL[c]}</label>)}
          </fieldset>
          <div className="sm:col-span-2 flex items-center gap-3">
            <button className="btn-primary" disabled={busy || !deviceOnline || f.channels.length === 0 || (!f.magazineId && !f.productId)}>AI 초안 생성 요청</button>
            {f.productId && <button type="button" className="btn-ghost" onClick={async () => { try { const r = await buildFacts({ productId: f.productId as Id<"products"> }); setMsg(`제품 정보 ${r.inserted + r.updated}건 갱신`); } catch (err) { setMsg(errorMessage(err)); } }}>제품 정보 팩 만들기</button>}
            {f.productId && <button type="button" className="btn-ghost" onClick={async () => { try { const r = await celebMatch({ productId: f.productId as Id<"products"> }); setMsg(r.found ? `연예인 착용 후보 ${r.found}건 (출처 링크만 저장)` : `검색 프로바이더(${r.provider}) 미설정 — 운영자가 키를 등록하면 활성화됩니다.`); } catch (err) { setMsg(errorMessage(err)); } }}>연예인 착용 검색</button>}
          </div>
        </form>
        {msg && <p className="mt-2 text-sm text-stone-700" role="status">{msg}{showJobsLink && <> <Link className="font-medium underline" href="/dashboard/jobs">작업 진행 상황 보기</Link></>}</p>}
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
              {m.heroImage && <Image src={m.heroImage} alt="" width={64} height={64} className="h-16 w-16 rounded object-cover" />}
              <div className="min-w-0 text-sm">
                <div className="truncate font-medium">{m.title}</div>
                <div className="truncate text-xs text-stone-500">{m.description ?? ""}</div>
                <div className="text-xs text-stone-500">{dateTime(m.ingestedAt)} · 소재 {m.atomCount} · 상품 {m.productCount}</div>
                <button type="button" className="mt-1 text-xs underline" onClick={() => { setF({ ...f, magazineId: m._id, productId: "" }); window.scrollTo({ top: 0 }); }}>이 매거진으로 생성</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-semibold">콘텐츠 라이브러리</h2>
          <p className="text-sm text-stone-500">운영팀이 검토해 공개한 콘텐츠를 그대로 게시하거나 내 콘텐츠로 복사해 편집할 수 있습니다.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label="콘텐츠 자료 종류">
          {(["PIECES", "OUTFIT", "MEME", "TREND", "PRODUCT_FACT", "CELEB_MATCH"] as Tab[]).map((k) => (
            <button key={k} type="button" aria-pressed={tab === k} className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? "bg-orange-50 font-medium text-orange-800" : "text-stone-700 hover:bg-stone-100"}`} onClick={() => setTab(k)}>{k === "PIECES" ? "게시 콘텐츠" : CURATION_KIND_LABEL[k]}</button>
          ))}
          {tab === "PIECES" && <><label className="sr-only" htmlFor="content-status-filter">콘텐츠 상태</label><select id="content-status-filter" className="input ml-auto w-auto py-1" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "" | "DRAFT" | "APPROVED")}><option value="">전체 상태</option><option value="APPROVED">승인</option>{scope === "MINE" && <option value="DRAFT">검토 필요</option>}</select></>}
        </div>
        {tab === "PIECES" ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex flex-wrap gap-2 lg:col-span-2" aria-label="콘텐츠 소유 범위"><button type="button" aria-pressed={scope === "SHARED"} className={scope === "SHARED" ? "btn-primary" : "btn-ghost"} onClick={() => { setScope("SHARED"); if (statusFilter === "DRAFT") setStatusFilter(""); }}>운영 제공 콘텐츠</button><button type="button" aria-pressed={scope === "MINE"} className={scope === "MINE" ? "btn-primary" : "btn-ghost"} onClick={() => setScope("MINE")}>내 콘텐츠</button></div>
            <div className="lg:col-span-2"><label className="label" htmlFor="content-library-search">콘텐츠 검색</label><input id="content-library-search" className="input" type="search" value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="묶음, 상품, 본문, 해시태그로 검색" /></div>
            {visibleLibrary.length === 0 && <div className="card lg:col-span-2"><p className="text-sm text-stone-500">{normalizedSearch ? "검색 조건에 맞는 콘텐츠가 없습니다." : scope === "SHARED" ? "현재 운영자가 공개한 콘텐츠가 없습니다. 직접 작성하거나 위에서 AI 초안을 생성할 수 있습니다." : "아직 내 콘텐츠가 없습니다."}</p>{scope === "MINE" && !normalizedSearch && <Link className="btn-ghost mt-3" href="/dashboard/content/mine">직접 작성</Link>}</div>}
            {visibleLibrary.map((p) => (
              <PieceCard key={p._id} p={p}
                onApprove={async (reviewChecklist) => { try { await approve({ pieceId: p._id, ...(p.productionMeta?.outputHash ? { expectedOutputHash: p.productionMeta.outputHash } : {}), reviewChecklist }); } catch (err) { setMsg(errorMessage(err)); } }}
                onReject={async (reason) => { try { await reject({ pieceId: p._id, reason }); } catch (err) { setMsg(errorMessage(err)); } }}
                onEdit={async (v) => { try { await edit({ pieceId: p._id, ...v }); return true; } catch (err) { setMsg(errorMessage(err)); return false; } }}
                onCopy={!p.mine ? async () => { try { await copyToMine({ pieceId: p._id }); setMsg("내 콘텐츠로 가져왔습니다. 내 콘텐츠에서 수정하거나 게시할 수 있습니다."); setScope("MINE"); } catch (err) { setMsg(errorMessage(err)); } } : undefined} />
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
                    <td className="text-sm font-medium">{c.mediaUrl && <Image src={c.mediaUrl} alt="" width={32} height={32} className="mr-2 inline h-8 w-8 rounded object-cover" />}{c.title}</td>
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
