"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PieceCard } from "@/components/PieceCard";
import { dateTime, errorMessage } from "@/lib/format";
import { CURATION_KIND_LABEL } from "@/lib/content-format";

type Kind = "MEME" | "TREND" | "PRODUCT_FACT" | "CELEB_MATCH";

export default function SuperMagazinesPage() {
  const magazines = useQuery(api.magazines.list, { limit: 50 });
  const pieces = useQuery(api.content.listAll, { limit: 100 });
  const rejections = useQuery(api.content.rejectionStats);
  const provider = useQuery(api.curation.providerStatus);
  const products = useQuery(api.products.search, { limit: 100 });
  const register = useAction(api.magazines.register);
  const archive = useMutation(api.magazines.archive);
  const setVisibility = useMutation(api.content.setVisibility);
  const approve = useMutation(api.content.approve);
  const reject = useMutation(api.content.reject);
  const edit = useMutation(api.content.edit);
  const addManual = useMutation(api.curation.addManual);
  const refreshTrends = useAction(api.curation.refreshTrendsNow);
  const [reg, setReg] = useState({ url: "", html: "", title: "" });
  const [cur, setCur] = useState<{ kind: Kind; title: string; body: string; sourceUrl: string; mediaUrl: string; productId: string; licenseNote: string }>({ kind: "MEME", title: "", body: "", sourceUrl: "", mediaUrl: "", productId: "", licenseNote: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Id<"magazines"> | null>(null);
  const detailDoc = useQuery(api.magazines.get, detail ? { magazineId: detail } : "skip");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">매거진 · 콘텐츠 운영</h1>
        <p className="text-sm text-stone-500">아뜨랑스 매거진을 URL 로 등록하면 본문·이미지·상품 링크(index_no)를 추출해 소재로 만듭니다. 승인된 조각을 전체 공유하면 모든 유저의 라이브러리에 노출됩니다.</p>
      </div>

      <section className="card">
        <h2 className="font-semibold">매거진 등록</h2>
        <form className="mt-2 grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await register({ url: reg.url || undefined, html: reg.html || undefined, title: reg.title || undefined });
            setMsg(`등록 완료: 소재 ${r.atomCount}개 · 상품 ${r.productCount}개`);
            setReg({ url: "", html: "", title: "" });
          } catch (err) { setMsg(errorMessage(err)); } finally { setBusy(false); }
        }}>
          <div><label className="label">매거진 URL</label><input className="input" placeholder="https://attrangs.co.kr/..." value={reg.url} onChange={(e) => setReg({ ...reg, url: e.target.value })} /></div>
          <div><label className="label">제목 덮어쓰기(선택)</label><input className="input" value={reg.title} onChange={(e) => setReg({ ...reg, title: e.target.value })} /></div>
          <div className="sm:col-span-2"><label className="label">또는 HTML 붙여넣기 (URL 접근이 막힌 경우)</label><textarea className="input font-mono text-xs" rows={4} value={reg.html} onChange={(e) => setReg({ ...reg, html: e.target.value })} /></div>
          <div className="sm:col-span-2"><button className="btn-primary" disabled={busy || (!reg.url && !reg.html)}>등록·추출</button></div>
        </form>
        {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold">매거진 목록</h2>
        <table className="table mt-2">
          <thead><tr><th>제목</th><th>소재</th><th>상품</th><th>등록</th><th>출처</th><th></th></tr></thead>
          <tbody>
            {magazines?.length === 0 && <tr><td colSpan={6} className="text-center text-stone-500">등록된 매거진이 없습니다.</td></tr>}
            {magazines?.map((m) => (
              <tr key={m._id}>
                <td className="text-sm font-medium">{m.title}</td>
                <td className="text-xs">{m.atomCount}</td>
                <td className="text-xs">{m.productCount}</td>
                <td className="text-xs">{dateTime(m.ingestedAt)}</td>
                <td className="text-xs">{m.sourceUrl ? <a className="underline" href={m.sourceUrl} target="_blank" rel="noreferrer">링크</a> : "HTML"}</td>
                <td className="whitespace-nowrap text-xs"><button className="btn-ghost" onClick={() => setDetail(detail === m._id ? null : m._id)}>{detail === m._id ? "닫기" : "소재"}</button> <button className="btn-ghost" onClick={async () => { if (confirm("보관 처리할까요?")) await archive({ magazineId: m._id }); }}>보관</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {detailDoc && (
          <div className="mt-3 grid gap-2 text-xs">
            <div className="text-stone-500">{detailDoc.imageUrls.length}개 이미지 · 상품: {detailDoc.products.map((p) => p.name).join(", ") || "매칭 없음"}</div>
            <ul className="grid gap-1">{detailDoc.atoms.map((a) => <li key={a._id}><span className="rounded bg-stone-100 px-1">{a.atomType}</span> {a.text}{a.attrangsProductId ? <span className="text-stone-400"> · #{a.attrangsProductId}</span> : null}</li>)}</ul>
          </div>
        )}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">큐레이션</h2>
          <span className="text-xs text-stone-500">검색 프로바이더: {provider ? `${provider.name}${provider.available ? " (활성)" : " (미설정 — BRAVE_API_KEY 또는 SERPAPI_KEY)"}` : "..."} · 트렌드: 구글 트렌드 KR RSS 6시간</span>
          <button className="btn-ghost ml-auto" disabled={busy} onClick={async () => { setBusy(true); try { const r = await refreshTrends({}); setMsg(`트렌드 ${r.count}건 (신규 ${r.inserted}, 갱신 ${r.updated})`); } catch (err) { setMsg(errorMessage(err)); } finally { setBusy(false); } }}>트렌드 지금 갱신</button>
        </div>
        <form className="mt-2 grid gap-3 sm:grid-cols-3" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await addManual({ kind: cur.kind, title: cur.title, body: cur.body || undefined, sourceUrl: cur.sourceUrl || undefined, mediaUrl: cur.mediaUrl || undefined, productId: (cur.productId || undefined) as Id<"products"> | undefined, licenseNote: cur.licenseNote });
            setMsg("큐레이션 항목을 등록했습니다.");
            setCur({ ...cur, title: "", body: "", sourceUrl: "", mediaUrl: "" });
          } catch (err) { setMsg(errorMessage(err)); }
        }}>
          <div><label className="label">종류</label><select className="input" value={cur.kind} onChange={(e) => setCur({ ...cur, kind: e.target.value as Kind })}>{(Object.keys(CURATION_KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{CURATION_KIND_LABEL[k]}</option>)}</select></div>
          <div><label className="label">제목</label><input className="input" required value={cur.title} onChange={(e) => setCur({ ...cur, title: e.target.value })} /></div>
          <div><label className="label">관련 상품(선택)</label><select className="input" value={cur.productId} onChange={(e) => setCur({ ...cur, productId: e.target.value })}><option value="">없음</option>{products?.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}</select></div>
          <div className="sm:col-span-3"><label className="label">내용</label><input className="input" value={cur.body} onChange={(e) => setCur({ ...cur, body: e.target.value })} /></div>
          <div><label className="label">출처 URL</label><input className="input" value={cur.sourceUrl} onChange={(e) => setCur({ ...cur, sourceUrl: e.target.value })} /></div>
          <div><label className="label">미디어 URL</label><input className="input" value={cur.mediaUrl} onChange={(e) => setCur({ ...cur, mediaUrl: e.target.value })} /></div>
          <div><label className="label">라이선스·출처 메모 (필수)</label><input className="input" required placeholder="예: CC0 / 자체 제작 / 인용만" value={cur.licenseNote} onChange={(e) => setCur({ ...cur, licenseNote: e.target.value })} /></div>
          <div className="sm:col-span-3"><button className="btn-primary">등록</button></div>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold">전체 콘텐츠 조각</h2>
          {rejections && <span className="text-xs text-stone-500">거절 {rejections.total}건{rejections.top.length ? ` · 상위 사유: ${rejections.top.map((t) => `${t.reason}(${t.count})`).join(", ")}` : ""}</span>}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {pieces?.length === 0 && <p className="text-sm text-stone-500">생성된 조각이 없습니다.</p>}
          {pieces?.map((p) => (
            <PieceCard key={p._id} p={{ ...p, mine: true }}
              onApprove={async () => { try { await approve({ pieceId: p._id }); } catch (err) { setMsg(errorMessage(err)); } }}
              onReject={async (reason) => { try { await reject({ pieceId: p._id, reason }); } catch (err) { setMsg(errorMessage(err)); } }}
              onEdit={async (v) => { try { await edit({ pieceId: p._id, ...v }); } catch (err) { setMsg(errorMessage(err)); } }}
              onShare={async (shared) => { try { await setVisibility({ pieceId: p._id, visibility: shared ? "SHARED" : "PRIVATE" }); } catch (err) { setMsg(errorMessage(err)); } }} />
          ))}
        </div>
      </section>
    </div>
  );
}
