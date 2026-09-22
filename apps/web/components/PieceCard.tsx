"use client";

import Link from "next/link";
import Image from "next/image";
import { useId, useState } from "react";
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
  runId?: string | null;
  productionMeta?: {
    standardId?: string | null;
    standardVersion?: string | null;
    workflowVersion?: string | null;
    promptVersion?: string | null;
    qualityVersion?: string | null;
    provider?: string | null;
    attemptNo?: number | null;
    inputHash?: string | null;
    manifestHash?: string | null;
    jobInputHash?: string | null;
    outputHash?: string | null;
    desktopVersion?: string | null;
    engine?: string | null;
    model?: string | null;
    provenanceComplete?: boolean | null;
    standardPassed?: boolean | null;
    evaluatedAt?: number | null;
    editedAt?: number | null;
    humanApprovedAt?: number | null;
  } | null;
};

export function pieceText(p: PieceLike): string {
  const caption = stripMatchingTrailingHashtagBlock(p.caption, p.hashtags);
  return p.hashtags.length ? `${caption}\n\n${p.hashtags.map((h) => `#${h}`).join(" ")}` : caption;
}

export function PieceCard({ p, onApprove, onReject, onEdit, onShare, onCopy, publishHref, publishingDisabledReason }: { p: PieceLike; onApprove?: () => Promise<unknown>; onReject?: (reason: string) => Promise<unknown>; onEdit?: (v: { caption: string; hashtags: string[]; script?: string }) => Promise<unknown>; onShare?: (shared: boolean) => Promise<unknown>; onCopy?: () => Promise<unknown>; publishHref?: string; publishingDisabledReason?: string }) {
  const fieldId = useId();
  const displayCaption = stripMatchingTrailingHashtagBlock(p.caption, p.hashtags);
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(displayCaption);
  const [tags, setTags] = useState(p.hashtags.join(" "));
  const [script, setScript] = useState(p.script ?? "");
  const [reason, setReason] = useState("");
  const [copied, setCopied] = useState(false);
  const blocks = p.qualityReport?.violations?.filter((v) => v.severity === "block") ?? [];
  const warns = p.qualityReport?.violations?.filter((v) => v.severity !== "block") ?? [];
  const provider = p.productionMeta?.provider ?? p.generatedBy;
  const providerLabel = `${GENERATED_BY_LABEL[provider.toLowerCase()] ?? provider}${p.productionMeta?.editedAt ? " + 사람 수정" : ""}`;
  const qualityPassed = p.productionMeta ? p.productionMeta.standardPassed === true : p.qualityScore >= 90;
  const runStandardBlocked = !!p.runId && p.productionMeta?.standardPassed !== true;
  const approvalDisabledReason = runStandardBlocked
    ? "실행 콘텐츠의 고정 제작 기준을 통과해야 승인할 수 있습니다"
    : blocks.length > 0
      ? "금칙 위반을 수정한 뒤 승인할 수 있습니다"
      : undefined;
  const effectivePublishingDisabledReason = runStandardBlocked
    ? "실행 콘텐츠의 고정 제작 기준을 통과해야 합니다"
    : publishingDisabledReason;
  const productionLabel = p.productionMeta
    ? [
        p.productionMeta.standardId && p.productionMeta.standardVersion
          ? `기준 ${p.productionMeta.standardId} ${p.productionMeta.standardVersion}`
          : p.productionMeta.standardVersion
            ? `기준 ${p.productionMeta.standardVersion}`
            : null,
        p.productionMeta.qualityVersion ? `품질 ${p.productionMeta.qualityVersion}` : null,
        providerLabel,
        p.productionMeta.attemptNo ? `시도 ${p.productionMeta.attemptNo}` : null,
        p.productionMeta.desktopVersion ? `앱 ${p.productionMeta.desktopVersion}` : null,
        p.productionMeta.standardPassed === true ? "자동 기준 통과" : p.productionMeta.standardPassed === false ? "기준 미통과" : null,
        p.productionMeta.humanApprovedAt ? "사람 승인 완료" : null,
      ].filter(Boolean).join(" · ")
    : providerLabel;
  return (
    <article className="card flex flex-col gap-2" data-automoney="piece" data-status={p.status} data-channel={p.channel}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-stone-100 px-2 py-0.5 font-medium">{CHANNEL_LABEL[p.channel] ?? p.channel}</span>
        <Badge value={PIECE_STATUS_TONE[p.status] ?? "PENDING"} label={PIECE_STATUS_LABEL[p.status] ?? p.status} />
        <span className={qualityPassed ? "text-emerald-700" : "text-amber-700"}>품질 {p.qualityScore}점</span>
        <span className="text-stone-500">{productionLabel}{p.visibility === "SHARED" ? " · 공유" : ""}{!p.mine ? " · 운영 제공" : ""} · 사용 {p.usageCount}회</span>
        {(p.magazineTitle || p.productName) && <span className="text-stone-500">· {p.magazineTitle ?? p.productName}</span>}
      </div>
      {editing ? (
        <div className="grid gap-2">
          <div><label className="label" htmlFor={`${fieldId}-caption`}>본문</label><textarea id={`${fieldId}-caption`} className="input" rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} /></div>
          <div><label className="label" htmlFor={`${fieldId}-hashtags`}>해시태그</label><input id={`${fieldId}-hashtags`} className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="공백으로 구분하고 #은 생략할 수 있습니다" /></div>
          {p.script !== null && <div><label className="label" htmlFor={`${fieldId}-script`}>숏폼 대본</label><textarea id={`${fieldId}-script`} className="input" rows={4} value={script} onChange={(e) => setScript(e.target.value)} /></div>}
          <div className="flex gap-2"><button className="btn-primary" type="button" onClick={async () => { const result = await onEdit?.({ caption, hashtags: tags.split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean), script: p.script !== null ? script : undefined }); if (result !== false) setEditing(false); }}>수정 내용 저장</button><button className="btn-ghost" type="button" onClick={() => setEditing(false)}>취소</button></div>
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
      {p.productionMeta?.jobInputHash && p.productionMeta?.outputHash && <details className="text-xs text-stone-500"><summary className="cursor-pointer">생성 감사 정보</summary><p className="mt-1 break-all">입력 {p.productionMeta.jobInputHash} · 출력 {p.productionMeta.outputHash}</p></details>}
      {approvalDisabledReason && p.mine && p.status === "DRAFT" && <p id={`${fieldId}-approval-disabled`} className="text-xs text-amber-800">승인 대기: {approvalDisabledReason}</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button className="btn-ghost" type="button" onClick={async () => { try { await navigator.clipboard.writeText(pieceText(p)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } }}>{copied ? "복사됨" : "콘텐츠 복사"}</button>
        {p.status === "APPROVED" && !effectivePublishingDisabledReason && <Link className="btn-ghost" href={publishHref ?? `/dashboard/publish?piece=${p._id}`}>이 콘텐츠로 게시</Link>}
        {p.status === "APPROVED" && !effectivePublishingDisabledReason && <Link className="btn-ghost" href={`/dashboard/schedules?piece=${p._id}`}>예약</Link>}
        {p.status === "APPROVED" && effectivePublishingDisabledReason && <span className="text-amber-800">게시·예약 대기: {effectivePublishingDisabledReason}</span>}
        {!p.mine && onCopy && <button className="btn-primary" type="button" onClick={onCopy}>내 콘텐츠로 가져오기</button>}
        {p.mine && p.status === "DRAFT" && onApprove && <button className="btn-primary" type="button" onClick={onApprove} disabled={!!approvalDisabledReason} aria-describedby={approvalDisabledReason ? `${fieldId}-approval-disabled` : undefined} title={approvalDisabledReason ?? ""}>콘텐츠 승인</button>}
        {p.mine && p.status !== "RETIRED" && onEdit && !editing && <button className="btn-ghost" type="button" onClick={() => setEditing(true)}>콘텐츠 수정</button>}
        {onShare && p.status === "APPROVED" && <button className="btn-ghost" type="button" onClick={() => onShare(p.visibility !== "SHARED")}>{p.visibility === "SHARED" ? "공유 해제" : "전체 공유"}</button>}
        {p.mine && p.status !== "RETIRED" && onReject && (
          <span className="ml-auto flex flex-wrap items-center gap-1"><label className="sr-only" htmlFor={`${fieldId}-reject-reason`}>콘텐츠 거절 사유</label><input id={`${fieldId}-reject-reason`} className="input w-auto min-w-36 py-1 text-xs" placeholder="거절 사유 입력" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn-ghost" type="button" disabled={!reason.trim()} onClick={() => onReject(reason.trim())}>콘텐츠 거절</button></span>
        )}
      </div>
    </article>
  );
}
