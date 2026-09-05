"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage } from "@/lib/format";
import { JOB_STATUS_LABEL, JOB_STATUS_TONE, JOB_TYPE_LABEL, PLATFORM_LABEL } from "@/lib/agent-format";
import { CHANNEL_LABEL } from "@/lib/content-format";
import { pieceText } from "@/components/PieceCard";

export default function JobsPage() {
  return (
    <Suspense fallback={null}>
      <JobsPageInner />
    </Suspense>
  );
}

function JobsPageInner() {
  const params = useSearchParams();
  const pieceParam = params.get("piece");
  const library = useQuery(api.content.listLibrary, { status: "APPROVED", limit: 100 });
  const [pieceId, setPieceId] = useState<string>("");
  const jobs = useQuery(api.jobs.listMine, { limit: 100 });
  const spaces = useQuery(api.spaces.listMine);
  const links = useQuery(api.links.listMine);
  const approve = useMutation(api.jobs.approve);
  const cancel = useMutation(api.jobs.cancel);
  const enqueue = useMutation(api.jobs.enqueuePublish);
  const [f, setF] = useState({ spaceId: "", text: "", media: "", linkId: "", approval: true, dryRun: false });
  const [msg, setMsg] = useState<string | null>(null);
  const applyPiece = (id: string) => {
    setPieceId(id);
    const p = library?.find((x) => x._id === id);
    if (p) setF((prev) => ({ ...prev, text: pieceText(p), media: p.mediaUrls.join(" ") }));
  };
  // URL 의 ?piece= 는 라이브러리 로드 후 한 번만 적용(렌더 중 상태 조정 패턴)
  const [appliedParam, setAppliedParam] = useState<string | null>(null);
  if (pieceParam && library && appliedParam !== pieceParam) {
    setAppliedParam(pieceParam);
    applyPiece(pieceParam);
  }
  const usable = spaces?.filter((s) => ["HEALTHY", "RUNNING", "LOGIN_REQUIRED", "CREATED"].includes(s.sessionState)) ?? [];
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">작업</h1>
        <p className="text-sm text-stone-500">에이전트가 수행하는 작업 큐입니다. 승인 대기 작업은 여기서 또는 텔레그램에서 승인합니다.</p>
      </div>
      <section className="card">
        <h2 className="font-semibold">지금 게시</h2>
        <form className="mt-2 grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); try { await enqueue({ spaceId: f.spaceId as Id<"spaces">, text: f.text, mediaUrls: f.media.split(/\s+/).filter(Boolean), linkId: (f.linkId || undefined) as Id<"marketingLinks"> | undefined, pieceId: (pieceId || undefined) as Id<"contentPieces"> | undefined, requireApproval: f.approval, dryRun: f.dryRun }); setMsg(f.approval ? "승인 대기 작업으로 등록했습니다." : "작업을 등록했습니다."); setF({ ...f, text: "", media: "" }); setPieceId(""); } catch (err) { setMsg(errorMessage(err)); } }}>
          <div><label className="label">스페이스</label><select className="input" required value={f.spaceId} onChange={(e) => setF({ ...f, spaceId: e.target.value })}><option value="">선택</option>{usable.map((s) => <option key={s._id} value={s._id}>[{PLATFORM_LABEL[s.platform]}] {s.name}</option>)}</select></div>
          <div><label className="label">마케팅 링크</label><select className="input" value={f.linkId} onChange={(e) => setF({ ...f, linkId: e.target.value })}><option value="">없음</option>{links?.map((l) => <option key={l._id} value={l._id}>{l.product?.name ?? l.shortCode}</option>)}</select></div>
          <div className="sm:col-span-2"><label className="label">라이브러리 콘텐츠</label><select className="input" value={pieceId} onChange={(e) => applyPiece(e.target.value)}><option value="">직접 입력</option>{library?.map((p) => <option key={p._id} value={p._id}>[{CHANNEL_LABEL[p.channel] ?? p.channel}] {p.caption.slice(0, 50)}{p.qualityScore ? ` · ${p.qualityScore}점` : ""}</option>)}</select></div>
          <div className="sm:col-span-2"><label className="label">본문</label><textarea className="input" rows={3} required value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></div>
          <div><label className="label">이미지 URL (공백 구분)</label><input className="input" value={f.media} onChange={(e) => setF({ ...f, media: e.target.value })} /></div>
          <div className="flex items-end gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.approval} onChange={(e) => setF({ ...f, approval: e.target.checked })} />승인 후 게시</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.dryRun} onChange={(e) => setF({ ...f, dryRun: e.target.checked })} />테스트(실제 게시 안 함)</label>
          </div>
          <div className="sm:col-span-2"><button className="btn-primary" disabled={usable.length === 0}>등록</button></div>
        </form>
        {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
      </section>
      <section className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>작업</th><th>스페이스</th><th>내용</th><th>출처</th><th>상태</th><th>생성</th><th>결과</th><th></th></tr></thead>
          <tbody>
            {jobs?.length === 0 && <tr><td colSpan={8} className="text-center text-stone-500">작업이 없습니다.</td></tr>}
            {jobs?.map((j) => (
              <tr key={j._id}>
                <td className="text-xs">{JOB_TYPE_LABEL[j.jobType] ?? j.jobType}</td>
                <td className="text-xs">{j.spaceName ?? "-"}</td>
                <td className="max-w-xs truncate text-xs">{j.preview ?? ""}</td>
                <td className="text-xs">{j.source}</td>
                <td><Badge value={JOB_STATUS_TONE[j.status] ?? "PENDING"} label={JOB_STATUS_LABEL[j.status]} />{j.stage && j.status === "RUNNING" && <div className="text-xs text-stone-500">{j.stage} {j.progress != null ? `${j.progress}%` : ""}</div>}</td>
                <td className="text-xs">{dateTime(j.createdAt)}</td>
                <td className="max-w-xs text-xs">
                  {j.errorCode && <span className="text-rose-700">{j.errorCode} {j.errorMessage}</span>}
                  {(j.result as { data?: { postUrl?: string } } | null)?.data?.postUrl && <a className="underline" href={(j.result as { data: { postUrl: string } }).data.postUrl} target="_blank" rel="noreferrer">게시물</a>}
                  {(j.result as { summary?: string } | null)?.summary && !j.errorCode && <span className="text-stone-600"> {(j.result as { summary: string }).summary}</span>}
                </td>
                <td className="whitespace-nowrap">
                  {j.status === "NEEDS_APPROVAL" && <button className="btn-primary !px-2 !py-1 text-xs" onClick={() => approve({ jobId: j._id })}>승인</button>}
                  {["NEEDS_APPROVAL", "QUEUED", "RUNNING"].includes(j.status) && <button className="btn-ghost ml-1 !px-2 !py-1 text-xs" onClick={() => cancel({ jobId: j._id })}>취소</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
