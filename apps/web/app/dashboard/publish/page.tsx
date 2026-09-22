"use client";

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { pieceText } from "@/components/PieceCard";
import { CHANNEL_LABEL } from "@/lib/content-format";
import { PLATFORM_LABEL } from "@/lib/agent-format";
import { errorMessage } from "@/lib/format";

const CHANNEL_PLATFORM: Record<string, string> = { INSTAGRAM_FEED: "INSTAGRAM", INSTAGRAM_REEL: "INSTAGRAM", THREADS: "THREADS", X: "X", TIKTOK: "TIKTOK", BLOG: "NAVER_BLOG" };
const MEDIA_REQUIRED = new Set(["INSTAGRAM", "TIKTOK"]);

export default function PublishPage() { return <Suspense fallback={<p className="text-sm text-stone-500">불러오는 중…</p>}><PublishPageInner /></Suspense>; }

function PublishPageInner() {
  const params = useSearchParams();
  const library = useQuery(api.content.listLibrary, { status: "APPROVED", limit: 200 });
  const spaces = useQuery(api.spaces.listMine);
  const links = useQuery(api.links.listMine);
  const enqueue = useMutation(api.jobs.enqueuePublish);
  const [pieceId, setPieceId] = useState(params.get("piece") ?? "");
  const [spaceId, setSpaceId] = useState("");
  const [textOverride, setTextOverride] = useState<string | null>(null);
  const [mediaOverride, setMediaOverride] = useState<string | null>(null);
  const [linkId, setLinkId] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const piece = library?.find((item) => item._id === pieceId);
  const text = textOverride ?? (piece ? pieceText(piece) : "");
  const media = mediaOverride ?? (piece ? piece.mediaUrls.join(" ") : "");
  const healthy = spaces?.filter((space) => space.sessionState === "HEALTHY" && !space.locked) ?? [];
  const candidates = piece ? healthy.filter((space) => space.platform === CHANNEL_PLATFORM[piece.channel]) : healthy;
  const selectedSpace = candidates.find((space) => space._id === spaceId);
  const mediaUrls = useMemo(() => media.split(/\s+/).filter(Boolean), [media]);
  const issues = [] as string[];
  if (!selectedSpace) issues.push("게시 가능한 SNS 계정을 선택하세요.");
  if (!text.trim() && mediaUrls.length === 0) issues.push("본문 또는 미디어가 필요합니다.");
  if (selectedSpace && MEDIA_REQUIRED.has(selectedSpace.platform) && mediaUrls.length === 0) issues.push(`${PLATFORM_LABEL[selectedSpace.platform]} 게시에는 미디어가 필요합니다.`);
  if (piece && ["INSTAGRAM_REEL", "TIKTOK"].includes(piece.channel) && mediaUrls.length === 0) issues.push("숏폼 대본만 준비되었습니다. 게시할 영상 URL을 추가하세요.");
  const submit = async () => { try { const jobId = await enqueue({ spaceId: spaceId as Id<"spaces">, text, mediaUrls, linkId: (linkId || undefined) as Id<"marketingLinks"> | undefined, pieceId: (pieceId || undefined) as Id<"contentPieces"> | undefined, requireApproval: true, dryRun }); setMsg(`게시 검토 작업을 등록했습니다. 작업 결과에서 승인하세요. (${jobId})`); } catch (e) { setMsg(errorMessage(e)); } };
  return <div className="flex flex-col gap-6"><div><h1 className="text-xl font-bold">게시하기</h1><p className="text-sm text-stone-500">콘텐츠, 게시 계정, 링크와 미디어를 확인한 뒤 승인 대기 작업으로 등록합니다.</p></div>
    {msg && <p className="rounded-lg bg-stone-100 p-3 text-sm" role="status">{msg}</p>}
    {healthy.length === 0 && spaces !== undefined && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">정상 상태의 게시 계정이 없습니다. <Link className="font-medium underline" href="/dashboard/connections#sns">연결 관리에서 계정을 준비하세요.</Link></div>}
    <section className="card grid gap-4 sm:grid-cols-2"><div className="sm:col-span-2"><label className="label">콘텐츠</label><select className="input" value={pieceId} onChange={(e) => { setPieceId(e.target.value); setTextOverride(null); setMediaOverride(null); }}><option value="">직접 입력</option>{library?.map((item) => <option key={item._id} value={item._id}>[{CHANNEL_LABEL[item.channel] ?? item.channel}] {item.caption.slice(0, 70)}{item.mine ? "" : " · 운영 제공"}</option>)}</select></div><div><label className="label">게시 계정</label><select className="input" value={selectedSpace?._id ?? ""} onChange={(e) => setSpaceId(e.target.value)}><option value="">선택</option>{candidates.map((space) => <option key={space._id} value={space._id}>[{PLATFORM_LABEL[space.platform]}] {space.name}{space.handle ? ` @${space.handle}` : ""}</option>)}</select></div><div><label className="label">마케팅 링크</label><select className="input" value={linkId} onChange={(e) => setLinkId(e.target.value)}><option value="">없음</option>{links?.map((link) => <option key={link._id} value={link._id}>{link.product?.name ?? link.shortCode}</option>)}</select></div><div className="sm:col-span-2"><label className="label">본문</label><textarea className="input" rows={6} value={text} onChange={(e) => setTextOverride(e.target.value)} /></div><div className="sm:col-span-2"><label className="label">HTTPS 이미지·영상 URL</label><input className="input" value={media} onChange={(e) => setMediaOverride(e.target.value)} placeholder="여러 개는 공백으로 구분" /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />테스트 실행(실제 게시 안 함)</label></section>
    <section className="card"><h2 className="font-semibold">게시 준비 확인</h2>{issues.length > 0 ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p className="mt-2 text-sm text-emerald-700">준비가 완료됐습니다. 등록 후 작업 결과 화면에서 최종 승인하세요.</p>}<div className="mt-4 flex gap-2"><button className="btn-primary" disabled={issues.length > 0} onClick={submit}>승인 대기 작업 등록</button><Link className="btn-ghost" href="/dashboard/jobs">작업 결과 보기</Link></div></section>
  </div>;
}
