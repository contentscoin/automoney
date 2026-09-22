"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PieceCard } from "@/components/PieceCard";
import { CHANNEL_LABEL, CHANNEL_ORDER } from "@/lib/content-format";
import { errorMessage } from "@/lib/format";

type Channel = (typeof CHANNEL_ORDER)[number];

export default function MyContentPage() {
  const all = useQuery(api.content.listLibrary, { limit: 200 });
  const products = useQuery(api.products.search, { limit: 100 });
  const createManual = useMutation(api.content.createManual);
  const approve = useMutation(api.content.approve);
  const reject = useMutation(api.content.reject);
  const edit = useMutation(api.content.edit);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ channel: "THREADS" as Channel, caption: "", hashtags: "", script: "", media: "", productId: "" });
  const mine = all?.filter((piece) => piece.mine) ?? [];
  const run = async (action: () => Promise<unknown>, success?: string) => {
    try { await action(); if (success) setMsg(success); return true; }
    catch (e) { setMsg(errorMessage(e)); return false; }
  };
  const save = async () => {
    try {
      const result = await createManual({ channel: form.channel, caption: form.caption, hashtags: form.hashtags.split(/\s+/).map((tag) => tag.replace(/^#/, "")).filter(Boolean), script: form.script || undefined, mediaUrls: form.media.split(/\s+/).filter(Boolean), productId: (form.productId || undefined) as Id<"products"> | undefined });
      setMsg(result.status === "APPROVED" ? "콘텐츠를 저장했습니다. 바로 게시에 사용할 수 있습니다." : "초안으로 저장했습니다. 품질 경고를 수정한 뒤 승인하세요.");
      setForm({ channel: "THREADS", caption: "", hashtags: "", script: "", media: "", productId: "" }); setOpen(false);
    } catch (e) { setMsg(errorMessage(e)); }
  };
  return <div className="flex flex-col gap-6">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-bold">내 콘텐츠</h1><p className="text-sm text-stone-500">직접 작성하거나 AI로 만든 콘텐츠를 수정하고 게시 준비 상태를 확인합니다.</p></div><div className="flex gap-2"><Link className="btn-ghost" href="/dashboard/content">운영 콘텐츠 찾기</Link><button className="btn-primary" onClick={() => setOpen((v) => !v)}>직접 작성</button></div></div>
    {msg && <p className="rounded-lg bg-stone-100 p-3 text-sm" role="status">{msg}</p>}
    {open && <section className="card grid gap-3 sm:grid-cols-2"><h2 className="font-semibold sm:col-span-2">새 콘텐츠</h2><div><label className="label">채널</label><select className="input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as Channel })}>{CHANNEL_ORDER.map((channel) => <option key={channel} value={channel}>{CHANNEL_LABEL[channel]}</option>)}</select></div><div><label className="label">관련 상품</label><select className="input" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}><option value="">없음</option>{products?.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}</select></div><div className="sm:col-span-2"><label className="label">본문</label><textarea className="input" rows={5} value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} /></div><div><label className="label">해시태그</label><input className="input" value={form.hashtags} onChange={(e) => setForm({ ...form, hashtags: e.target.value })} placeholder="광고 데일리룩 코디" /></div><div><label className="label">HTTPS 미디어 URL</label><input className="input" value={form.media} onChange={(e) => setForm({ ...form, media: e.target.value })} placeholder="여러 개는 공백으로 구분" /></div>{["INSTAGRAM_REEL", "TIKTOK"].includes(form.channel) && <div className="sm:col-span-2"><label className="label">숏폼 대본</label><textarea className="input" rows={4} value={form.script} onChange={(e) => setForm({ ...form, script: e.target.value })} /></div>}<div className="sm:col-span-2 flex gap-2"><button className="btn-primary" disabled={!form.caption.trim()} onClick={save}>저장하고 품질 확인</button><button className="btn-ghost" onClick={() => setOpen(false)}>취소</button></div></section>}
    <section className="grid gap-3 lg:grid-cols-2">{all === undefined && <p className="text-sm text-stone-500">불러오는 중…</p>}{mine.length === 0 && all !== undefined && <div className="card lg:col-span-2"><h2 className="font-semibold">아직 내 콘텐츠가 없습니다</h2><p className="mt-1 text-sm text-stone-500">운영 콘텐츠를 가져오거나 직접 작성하거나 AI로 생성하세요.</p><div className="mt-3 flex gap-2"><Link className="btn-primary" href="/dashboard/content">콘텐츠 찾기</Link><button className="btn-ghost" onClick={() => setOpen(true)}>직접 작성</button></div></div>}{mine.map((piece) => <PieceCard key={piece._id} p={piece} onApprove={() => run(() => approve({ pieceId: piece._id }), "콘텐츠를 승인했습니다.")} onReject={(reason) => run(() => reject({ pieceId: piece._id, reason }), "콘텐츠를 보관 종료했습니다.")} onEdit={(value) => run(() => edit({ pieceId: piece._id, ...value }), "콘텐츠를 수정하고 품질을 다시 확인했습니다.")} />)}</section>
  </div>;
}
