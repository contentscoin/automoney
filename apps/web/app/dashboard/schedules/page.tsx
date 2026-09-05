"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage } from "@/lib/format";
import { DOW, PLATFORM_LABEL } from "@/lib/agent-format";
import { CHANNEL_LABEL } from "@/lib/content-format";
import { pieceText } from "@/components/PieceCard";

type Kind = "ONE_SHOT" | "DAILY" | "WEEKLY";

export default function SchedulesPage() {
  return (
    <Suspense fallback={null}>
      <SchedulesPageInner />
    </Suspense>
  );
}

function SchedulesPageInner() {
  const params = useSearchParams();
  const pieceParam = params.get("piece");
  const library = useQuery(api.content.listLibrary, { status: "APPROVED", limit: 100 });
  const [pieceId, setPieceId] = useState<string>("");
  const spaces = useQuery(api.spaces.listMine);
  const links = useQuery(api.links.listMine);
  const rows = useQuery(api.schedules.listMine);
  const upsert = useMutation(api.schedules.upsert);
  const setEnabled = useMutation(api.schedules.setEnabled);
  const remove = useMutation(api.schedules.remove);
  const [f, setF] = useState({ spaceId: "", kind: "DAILY" as Kind, timeOfDay: "10:00", days: [1, 3, 5] as number[], runDate: "", jitter: 15, text: "", media: "", linkId: "", autoApprove: false });
  const [msg, setMsg] = useState<string | null>(null);
  const usable = spaces?.filter((s) => !["PAUSED", "RESTRICTED"].includes(s.sessionState)) ?? [];
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">예약 발행</h1>
        <p className="text-sm text-stone-500">KST 기준. 지터(±분)로 매번 다른 시각에 게시됩니다. 자동 승인이 아니면 실행 직전 텔레그램/작업 목록에서 승인해야 게시됩니다. 스페이스 일일 한도를 넘는 슬롯은 건너뜁니다.</p>
      </div>
      <section className="card">
        <h2 className="font-semibold">새 예약</h2>
        <form className="mt-2 grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await upsert({ spaceId: f.spaceId as Id<"spaces">, kind: f.kind, timeOfDay: f.timeOfDay, daysOfWeek: f.kind === "WEEKLY" ? f.days : [], runDate: f.kind === "ONE_SHOT" ? f.runDate : undefined, jitterMinutes: Number(f.jitter), text: f.text, mediaUrls: f.media.split(/\s+/).filter(Boolean), linkId: (f.linkId || undefined) as Id<"marketingLinks"> | undefined, pieceId: (pieceId || undefined) as Id<"contentPieces"> | undefined, autoApprove: f.autoApprove });
            setMsg(`예약했습니다. 다음 실행: ${r.nextRunAt ? dateTime(r.nextRunAt) : "-"}`);
            setF({ ...f, text: "", media: "" });
            setPieceId("");
          } catch (err) { setMsg(errorMessage(err)); }
        }}>
          <div><label className="label">스페이스</label><select className="input" required value={f.spaceId} onChange={(e) => setF({ ...f, spaceId: e.target.value })}><option value="">선택</option>{usable.map((s) => <option key={s._id} value={s._id}>[{PLATFORM_LABEL[s.platform]}] {s.name}</option>)}</select></div>
          <div><label className="label">주기</label><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}><option value="DAILY">매일</option><option value="WEEKLY">요일별</option><option value="ONE_SHOT">1회</option></select></div>
          <div><label className="label">시각 (KST)</label><input className="input" type="time" required value={f.timeOfDay} onChange={(e) => setF({ ...f, timeOfDay: e.target.value })} /></div>
          <div><label className="label">지터 ±분</label><input className="input" type="number" min={0} max={120} value={f.jitter} onChange={(e) => setF({ ...f, jitter: Number(e.target.value) })} /></div>
          {f.kind === "WEEKLY" && <div className="sm:col-span-2"><label className="label">요일</label><div className="flex gap-2">{DOW.map((d, i) => <label key={i} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.days.includes(i)} onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i] : f.days.filter((x) => x !== i) })} />{d}</label>)}</div></div>}
          {f.kind === "ONE_SHOT" && <div><label className="label">실행 일자</label><input className="input" type="date" required value={f.runDate} onChange={(e) => setF({ ...f, runDate: e.target.value })} /></div>}
          <div className="sm:col-span-2"><label className="label">라이브러리 콘텐츠</label><select className="input" value={pieceId} onChange={(e) => applyPiece(e.target.value)}><option value="">직접 입력</option>{library?.map((p) => <option key={p._id} value={p._id}>[{CHANNEL_LABEL[p.channel] ?? p.channel}] {p.caption.slice(0, 50)}</option>)}</select></div>
          <div className="sm:col-span-2"><label className="label">본문</label><textarea className="input" rows={4} required value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="게시할 문안. 링크를 선택하면 본문 끝에 단축 링크가 붙습니다." /></div>
          <div><label className="label">이미지 URL (공백 구분)</label><input className="input" value={f.media} onChange={(e) => setF({ ...f, media: e.target.value })} placeholder="https://…" /></div>
          <div><label className="label">마케팅 링크</label><select className="input" value={f.linkId} onChange={(e) => setF({ ...f, linkId: e.target.value })}><option value="">없음</option>{links?.map((l) => <option key={l._id} value={l._id}>{l.product?.name ?? l.shortCode}</option>)}</select></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.autoApprove} onChange={(e) => setF({ ...f, autoApprove: e.target.checked })} />승인 없이 자동 게시</label>
          <div className="sm:col-span-2"><button className="btn-primary" disabled={usable.length === 0}>예약 등록</button></div>
        </form>
        {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
      </section>
      <section className="card overflow-x-auto">
        <h2 className="font-semibold">예약 목록</h2>
        <table className="table mt-2">
          <thead><tr><th>스페이스</th><th>주기</th><th>본문</th><th>다음 실행</th><th>마지막</th><th>승인</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {rows?.length === 0 && <tr><td colSpan={8} className="text-center text-stone-500">예약이 없습니다.</td></tr>}
            {rows?.map((s) => (
              <tr key={s._id}>
                <td>{s.spaceName}</td>
                <td className="text-xs">{s.kind === "DAILY" ? "매일" : s.kind === "WEEKLY" ? s.daysOfWeek.map((d) => DOW[d]).join("") : s.runDate} {s.timeOfDay} ±{s.jitterMinutes}분</td>
                <td className="max-w-xs truncate text-xs">{s.text}</td>
                <td className="text-xs">{s.nextRunAt ? dateTime(s.nextRunAt) : "-"}</td>
                <td className="text-xs">{s.lastRunAt ? dateTime(s.lastRunAt) : "-"}</td>
                <td className="text-xs">{s.autoApprove ? "자동" : "수동"}</td>
                <td><Badge value={s.enabled ? "ACTIVE" : "DISABLED"} label={s.enabled ? "활성" : "중지"} /></td>
                <td className="whitespace-nowrap">
                  <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setEnabled({ id: s._id, enabled: !s.enabled })}>{s.enabled ? "중지" : "재개"}</button>
                  <button className="btn-ghost ml-1 !px-2 !py-1 text-xs text-rose-700" onClick={() => remove({ id: s._id })}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
