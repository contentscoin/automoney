"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { stripMatchingTrailingHashtagBlock } from "@automoney/shared";
import { Badge } from "@/components/Badge";
import { CHANNEL_LABEL, GENERATED_BY_LABEL, PIECE_STATUS_LABEL, PIECE_STATUS_TONE } from "@/lib/content-format";

export type PieceLike = {
  _id: string;
  channel: string;
  caption: string;
  hashtags: string[];
  script: string | null;
  mediaUrls: string[];
  qualityScore: number;
  qualityReport: { violations: { code: string; message: string; severity: string }[]; fixed: string[] };
  status: string;
  visibility: string;
  generatedBy: string;
  usageCount: number;
  mine: boolean;
  magazineTitle: string | null;
  productName: string | null;
  productId?: string | null;
};

export function pieceText(p: PieceLike): string {
  const caption = stripMatchingTrailingHashtagBlock(p.caption, p.hashtags);
  return p.hashtags.length ? `${caption}\n\n${p.hashtags.map((h) => `#${h}`).join(" ")}` : caption;
}

export function PieceCard({ p, onApprove, onReject, onEdit, onShare, onCopy, publishHref }: { p: PieceLike; onApprove?: () => Promise<void>; onReject?: (reason: string) => Promise<void>; onEdit?: (v: { caption: string; hashtags: string[]; script?: string }) => Promise<void>; onShare?: (shared: boolean) => Promise<void>; onCopy?: () => Promise<void>; publishHref?: string }) {
  const displayCaption = stripMatchingTrailingHashtagBlock(p.caption, p.hashtags);
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(displayCaption);
  const [tags, setTags] = useState(p.hashtags.join(" "));
  const [script, setScript] = useState(p.script ?? "");
  const [reason, setReason] = useState("");
  const [copied, setCopied] = useState(false);
  const blocks = p.qualityReport?.violations?.filter((v) => v.severity === "block") ?? [];
  const warns = p.qualityReport?.violations?.filter((v) => v.severity !== "block") ?? [];
  return (
    <article className="card flex flex-col gap-2" data-automoney="piece" data-status={p.status} data-channel={p.channel}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-stone-100 px-2 py-0.5 font-medium">{CHANNEL_LABEL[p.channel] ?? p.channel}</span>
        <Badge value={PIECE_STATUS_TONE[p.status] ?? "PENDING"} label={PIECE_STATUS_LABEL[p.status] ?? p.status} />
        <span className={p.qualityScore >= 90 ? "text-emerald-700" : "text-amber-700"}>품질 {p.qualityScore}점</span>
        <span className="text-stone-500">{GENERATED_BY_LABEL[p.generatedBy] ?? p.generatedBy}{p.visibility === "SHARED" ? " · 공유" : ""}{!p.mine ? " · 운영 제공" : ""} · 사용 {p.usageCount}회</span>
        {(p.magazineTitle || p.productName) && <span className="text-stone-500">· {p.magazineTitle ?? p.productName}</span>}
      </div>
      {editing ? (
        <div className="grid gap-2">
          <textarea className="input" rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} />
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="해시태그 (공백 구분, # 생략 가능)" />
          {p.script !== null && <textarea className="input" rows={4} value={script} onChange={(e) => setScript(e.target.value)} placeholder="숏폼 대본" />}
          <div className="flex gap-2"><button className="btn-primary" onClick={async () => { await onEdit?.({ caption, hashtags: tags.split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean), script: p.script !== null ? script : undefined }); setEditing(false); }}>저장</button><button className="btn-ghost" onClick={() => setEditing(false)}>취소</button></div>
        </div>
      ) : (
        <>
          {p.mediaUrls.length > 0 && (
            <div className="grid grid-cols-2 gap-2" aria-label="콘텐츠 미디어 미리보기">
              {p.mediaUrls.slice(0, 4).map((url, index) => {
                const label = `${p.productName ?? p.magazineTitle ?? "콘텐츠"} 미디어 ${index + 1}`;
                const isVideo = /\.(?:mp4|webm|mov|m4v)(?:\?|#|$)/i.test(url);
                return isVideo ? (
                  <video key={`${url}-${index}`} className="aspect-[4/5] w-full rounded-lg bg-stone-100 object-cover" controls preload="metadata" aria-label={label}>
                    <source src={url} />
                  </video>
                ) : (
                  <Image key={`${url}-${index}`} src={url} alt={label} width={640} height={800} unoptimized className="aspect-[4/5] w-full rounded-lg bg-stone-100 object-cover" />
                );
              })}
            </div>
          )}
          <p className="whitespace-pre-wrap text-sm">{displayCaption}</p>
          {p.hashtags.length > 0 && <p className="text-xs text-sky-700">{p.hashtags.map((h) => `#${h}`).join(" ")}</p>}
          {p.script && <details className="text-xs"><summary className="cursor-pointer text-stone-600">숏폼 대본</summary><pre className="mt-1 whitespace-pre-wrap rounded bg-stone-50 p-2">{p.script}</pre></details>}
        </>
      )}
      {blocks.length > 0 && <ul className="text-xs text-rose-700">{blocks.map((v) => <li key={v.code}>⛔ {v.message}</li>)}</ul>}
      {warns.length > 0 && <ul className="text-xs text-amber-700">{warns.map((v) => <li key={v.code}>⚠ {v.message}</li>)}</ul>}
      {p.qualityReport?.fixed?.length > 0 && <p className="text-xs text-stone-500">자동 보정: {p.qualityReport.fixed.join(", ")}</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button className="btn-ghost" onClick={async () => { try { await navigator.clipboard.writeText(pieceText(p)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } }}>{copied ? "복사됨" : "복사"}</button>
        {p.status === "APPROVED" && <Link className="btn-ghost" href={publishHref ?? `/dashboard/publish?piece=${p._id}`}>이 콘텐츠로 게시</Link>}
        {p.status === "APPROVED" && <Link className="btn-ghost" href={`/dashboard/schedules?piece=${p._id}`}>예약</Link>}
        {!p.mine && onCopy && <button className="btn-primary" onClick={onCopy}>내 콘텐츠로 가져오기</button>}
        {p.mine && p.status === "DRAFT" && onApprove && <button className="btn-primary" onClick={onApprove} disabled={blocks.length > 0} title={blocks.length ? "금칙 위반을 수정한 뒤 승인할 수 있습니다" : ""}>승인</button>}
        {p.mine && p.status !== "RETIRED" && onEdit && !editing && <button className="btn-ghost" onClick={() => setEditing(true)}>수정</button>}
        {onShare && p.status === "APPROVED" && <button className="btn-ghost" onClick={() => onShare(p.visibility !== "SHARED")}>{p.visibility === "SHARED" ? "공유 해제" : "전체 공유"}</button>}
        {p.mine && p.status !== "RETIRED" && onReject && (
          <span className="ml-auto flex items-center gap-1"><input className="input py-1 text-xs" placeholder="거절 사유" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn-ghost" disabled={!reason.trim()} onClick={() => onReject(reason.trim())}>거절</button></span>
        )}
      </div>
    </article>
  );
}
