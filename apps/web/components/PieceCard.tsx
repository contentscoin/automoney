"use client";

import Link from "next/link";
import Image from "next/image";
import { useId, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { stripMatchingTrailingHashtagBlock } from "@automoney/shared";
import { Badge } from "@/components/Badge";
import {
  REVIEW_CHECKLIST_ITEMS,
  checkedReviewCount,
  emptyReviewChecklist,
  isReviewChecklistComplete,
  type ReviewChecklist,
} from "@/components/content-review";
import { validatePieceMediaEdit } from "@/components/publish-media";
import { CHANNEL_LABEL, GENERATED_BY_LABEL, PIECE_STATUS_LABEL, PIECE_STATUS_TONE } from "@/lib/content-format";
import { dateTime, errorMessage, won } from "@/lib/format";

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
  collectionTitle?: string | null;
  collectionSummary?: string | null;
  collectionTags?: string[];
  collectionStatus?: string | null;
  productId?: string | null;
  legacyBlocked?: boolean;
  requiresStructuredReview?: boolean;
  mediaIntegrity?: { ready: boolean; reason?: string; manifest?: { url: string; sha256: string; sizeBytes: number; mimeType: string }[] };
  mediaRevisionHash?: string;
  mediaApprovalReady?: boolean;
  mediaApprovalReason?: string;
  mediaFreeze?: null | { id: string; status: string; error?: string; completedCount: number; totalCount: number; expiresAt: number };
  productEvidence?: {
    name: string;
    price: number;
    salePrice: number | null;
    detailUrl: string;
    syncedAt: number;
    source: string;
    frozen: boolean;
  } | null;
  runId?: string | null;
  collectionId?: string | null;
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

export function PieceCard({ p, onApprove, onReject, onEdit, onRemove, onShare, onCopy, publishHref, publishingDisabledReason }: { p: PieceLike; onApprove?: (reviewChecklist: ReviewChecklist) => Promise<unknown>; onReject?: (reason: string) => Promise<unknown>; onEdit?: (v: { caption: string; hashtags: string[]; script?: string; mediaUrls: string[] }) => Promise<unknown>; onRemove?: () => Promise<unknown>; onShare?: (shared: boolean) => Promise<unknown>; onCopy?: () => Promise<unknown>; publishHref?: string; publishingDisabledReason?: string }) {
  const fieldId = useId();
  const requestFreeze = useMutation(api.media.requestFreeze);
  const displayCaption = stripMatchingTrailingHashtagBlock(p.caption, p.hashtags);
  const reviewRevision = JSON.stringify([p.productionMeta?.outputHash, p.mediaRevisionHash, p.caption, p.hashtags, p.script, p.mediaUrls]);
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(displayCaption);
  const [tags, setTags] = useState(p.hashtags.join(" "));
  const [script, setScript] = useState(p.script ?? "");
  const [media, setMedia] = useState(p.mediaUrls.join("\n"));
  const [reason, setReason] = useState("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [showAllMedia, setShowAllMedia] = useState(false);
  const [approving, setApproving] = useState(false);
  const [freezeSubmitting, setFreezeSubmitting] = useState(false);
  const freezeRequestBusy = useRef(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [freezeMessage, setFreezeMessage] = useState("");
  const [rightsState, setRightsState] = useState({ revision: reviewRevision, confirmed: false, note: "" });
  const rights = rightsState.revision === reviewRevision ? rightsState : { revision: reviewRevision, confirmed: false, note: "" };
  const [rightsAttempted, setRightsAttempted] = useState(false);
  const [previewState, setPreviewState] = useState<{ revision: string; loaded: string[]; failed: string[] }>({ revision: reviewRevision, loaded: [], failed: [] });
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const preview = previewState.revision === reviewRevision ? previewState : { revision: reviewRevision, loaded: [], failed: [] };
  const [reviewState, setReviewState] = useState(() => ({ revision: reviewRevision, checklist: emptyReviewChecklist() }));
  const reviewChecklist = reviewState.revision === reviewRevision ? reviewState.checklist : emptyReviewChecklist();
  const hasMedia = p.mediaUrls.length > 0;
  const mediaReady = !hasMedia || p.mediaIntegrity?.ready === true;
  const manifest = mediaReady ? p.mediaIntegrity?.manifest ?? [] : [];
  const previewComplete = !hasMedia || (manifest.length === p.mediaUrls.length && manifest.every((item) => preview.loaded.includes(item.url)));
  const canFreeze = p.mine && !!onEdit && !p.legacyBlocked && p.status !== "RETIRED" && (!p.collectionId || p.collectionStatus === "DRAFT");
  const freezePending = p.mediaFreeze?.status === "PENDING" || p.mediaFreeze?.status === "RUNNING";
  const freezeBusy = freezeSubmitting || freezePending;
  const structuredReview = hasMedia || (p.requiresStructuredReview ?? !!(p.runId || p.collectionId));
  const requiresStructuredReview = structuredReview && p.mine && p.status === "DRAFT" && !!onApprove;
  const reviewCount = checkedReviewCount(reviewChecklist);
  const reviewComplete = isReviewChecklistComplete(reviewChecklist);
  const editedMediaUrls = media.split(/\s+/).filter(Boolean);
  const mediaEditError = validatePieceMediaEdit(editedMediaUrls, p.channel);
  const currentMediaApprovalError = validatePieceMediaEdit(p.mediaUrls, p.channel);
  const shortForm = p.channel === "INSTAGRAM_REEL" || p.channel === "TIKTOK";
  const blocks = p.qualityReport?.violations?.filter((v) => v.severity === "block") ?? [];
  const warns = p.qualityReport?.violations?.filter((v) => v.severity !== "block") ?? [];
  const provider = p.productionMeta?.provider ?? p.generatedBy;
  const providerLabel = `${GENERATED_BY_LABEL[provider.toLowerCase()] ?? provider}${p.productionMeta?.editedAt ? " + 사람 수정" : ""}`;
  const qualityPassed = p.productionMeta ? p.productionMeta.standardPassed === true : p.qualityScore >= 90;
  const runStandardBlocked = !!p.runId && p.productionMeta?.standardPassed !== true;
  const approvalDisabledReasons = [
    runStandardBlocked ? "실행 콘텐츠의 고정 제작 기준을 통과해야 승인할 수 있습니다." : null,
    blocks.length > 0 ? "금칙 위반을 수정한 뒤 승인할 수 있습니다." : null,
    currentMediaApprovalError ? `미디어 수정 필요: ${currentMediaApprovalError}` : null,
    !mediaReady ? "원격 주소만으로는 승인할 수 없습니다. 미디어 고정을 완료한 뒤 실제 파일을 확인하세요." : null,
    mediaReady && !previewComplete ? "승인할 모든 미디어 미리보기를 불러오고 확인하세요. 보이지 않는 파일은 다시 불러오세요." : null,
    requiresStructuredReview && !reviewComplete ? `사람 검토 항목을 모두 확인하세요. 현재 ${reviewCount}/${REVIEW_CHECKLIST_ITEMS.length}개 확인했습니다.` : null,
    editing ? "수정 내용을 저장하거나 취소한 뒤 승인하세요." : null,
  ].filter((reason): reason is string => !!reason);
  const approvalBlocked = approvalDisabledReasons.length > 0;
  const collectionPublishingDisabledReason = p.collectionId && p.collectionStatus !== "PUBLISHED"
    ? "운영 묶음이 사용자 공개 상태가 아닙니다"
    : undefined;
  const effectivePublishingDisabledReason = runStandardBlocked
    ? "실행 콘텐츠의 고정 제작 기준을 통과해야 합니다"
    : !mediaReady ? "미디어 고정과 재승인을 완료하세요" : hasMedia && p.mediaApprovalReady !== true ? "고정된 미디어의 검수를 다시 완료하세요" : publishingDisabledReason ?? collectionPublishingDisabledReason;
  const hiddenMediaCount = Math.max(0, manifest.length - 4);
  const visibleMedia = showAllMedia ? manifest : manifest.slice(0, 4);
  const setPreviewResult = (url: string, loaded: boolean) => setPreviewState((previous) => {
    const current = previous.revision === reviewRevision ? previous : { revision: reviewRevision, loaded: [], failed: [] };
    return { revision: reviewRevision, loaded: loaded ? [...new Set([...current.loaded, url])] : current.loaded.filter((value) => value !== url), failed: loaded ? current.failed.filter((value) => value !== url) : [...new Set([...current.failed, url])] };
  });
  const copyMessage = copyStatus === "copied"
    ? "콘텐츠를 클립보드에 복사했습니다."
    : copyStatus === "failed"
      ? "복사할 수 없습니다. 브라우저 권한을 확인하거나 본문을 직접 선택해 복사하세요."
      : "";
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
        {(p.collectionTitle || p.magazineTitle || p.productName) && <span className="text-stone-500">· {p.collectionTitle ?? p.magazineTitle ?? p.productName}</span>}
      </div>
      {(p.collectionSummary || (p.collectionTags?.length ?? 0) > 0) && (
        <div className="rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
          {p.collectionSummary && <p>{p.collectionSummary}</p>}
          {!!p.collectionTags?.length && <p className={p.collectionSummary ? "mt-1 text-sky-700" : "text-sky-700"}>{p.collectionTags.map((tag) => `#${tag}`).join(" ")}</p>}
        </div>
      )}
      {p.productEvidence && (
        <section className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-950" aria-labelledby={`${fieldId}-product-evidence-title`}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`${fieldId}-product-evidence-title`} className="font-semibold">상품 근거</h3>
            <span className="rounded-full bg-white px-2 py-0.5 font-medium">{p.productEvidence.frozen ? "제작 시점에 고정됨" : "현재 카탈로그"}</span>
          </div>
          <dl className="mt-2 grid gap-2 sm:grid-cols-3">
            <div><dt className="text-sky-700">상품명</dt><dd className="font-medium">{p.productEvidence.name}</dd></div>
            <div><dt className="text-sky-700">가격</dt><dd className="font-medium">{p.productEvidence.salePrice != null ? <>{won(p.productEvidence.salePrice)} <span className="font-normal text-sky-700">(정가 {won(p.productEvidence.price)})</span></> : won(p.productEvidence.price)}</dd></div>
            <div><dt className="text-sky-700">스냅샷 시각</dt><dd><time dateTime={new Date(p.productEvidence.syncedAt).toISOString()}>{dateTime(p.productEvidence.syncedAt)}</time></dd></div>
          </dl>
          <a className="mt-2 inline-block font-medium underline" href={p.productEvidence.detailUrl} target="_blank" rel="noreferrer">상품 상세에서 근거 확인<span className="sr-only">: {p.productEvidence.name} (새 창)</span></a>
        </section>
      )}
      {p.legacyBlocked && <aside className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><strong className="block">이전 품질 계약 결과</strong><p className="mt-1">현재 제작 기준과 검토 증거가 없어 승인·게시·공유하거나 내 콘텐츠로 가져올 수 없습니다.</p><Link className="mt-2 inline-block font-medium underline" href="/dashboard/workflow">새 워크플로로 재생성</Link></aside>}
      {hasMedia && !editing && <section className="my-2 rounded-lg border border-stone-200 bg-stone-50 p-3" aria-labelledby={`${fieldId}-freeze-title`}>
        <h3 id={`${fieldId}-freeze-title`} className="text-sm font-semibold">{mediaReady ? "승인할 미디어 원본" : "미디어 고정 필요"}</h3>
        <p className="mt-1 text-xs leading-relaxed text-stone-600">{mediaReady ? "저장된 파일을 그대로 게시합니다. 아래 이미지·영상을 모두 열어 상품, 화질, 자막과 사용권을 확인한 뒤 승인하세요." : "외부 주소의 파일은 나중에 바뀔 수 있습니다. 사용권을 확인하고 파일을 공개 저장소에 고정한 뒤 검토하세요. 이미지 10MB·영상 20MB까지 지원합니다."}</p>
        <p className="mt-2 text-xs tabular-nums text-stone-700" role="status">{freezePending ? `미디어 저장 중 · ${p.mediaFreeze?.completedCount ?? 0}/${p.mediaFreeze?.totalCount ?? p.mediaUrls.length}개 완료. 완료되면 미리보기가 표시됩니다.` : mediaReady ? `고정 완료 · ${manifest.length}개` : freezeMessage}</p>
        {!mediaReady && p.mediaFreeze?.error && !freezePending && <p className="mt-2 break-words text-xs text-rose-700">저장하지 못했습니다: {p.mediaFreeze.error} 주소와 사용권을 확인한 뒤 다시 준비하세요.</p>}
        {!mediaReady && canFreeze && <fieldset className="mt-3 space-y-3" disabled={freezeBusy}>
          <legend className="sr-only">미디어 사용권 및 공개 저장 동의</legend>
          <label htmlFor={`${fieldId}-media-rights`} className="flex min-h-11 items-start gap-2 text-sm">
            <input id={`${fieldId}-media-rights`} className="mt-1 h-4 w-4 shrink-0 accent-orange-700" type="checkbox" checked={rights.confirmed} aria-invalid={rightsAttempted && !rights.confirmed || undefined} aria-describedby={rightsAttempted && !rights.confirmed ? `${fieldId}-rights-confirm-error` : undefined} onChange={(event) => setRightsState({ ...rights, confirmed: event.target.checked })} />
            <span>이 파일을 사용할 권한이 있으며 공개 저장·배포에 동의합니다. 저장된 파일은 링크를 가진 사람이 볼 수 있습니다.</span>
          </label>
          {rightsAttempted && !rights.confirmed && <p id={`${fieldId}-rights-confirm-error`} className="text-xs text-rose-700">파일 사용권과 공개 저장·배포 동의를 확인하세요.</p>}
          <div>
            <label className="label" htmlFor={`${fieldId}-rights-note`}>사용권 근거 (필수, 3~1000자)</label>
            <textarea id={`${fieldId}-rights-note`} className="input" rows={2} maxLength={1000} value={rights.note} aria-invalid={rightsAttempted && rights.note.trim().length < 3 || undefined} aria-describedby={`${fieldId}-rights-help${rightsAttempted && rights.note.trim().length < 3 ? ` ${fieldId}-rights-note-error` : ""}`} placeholder="예: 직접 촬영한 제품 사진, 브랜드의 광고 활용 허가 문서명·일자" onChange={(event) => setRightsState({ ...rights, note: event.target.value })} />
            <p id={`${fieldId}-rights-help`} className="mt-1 text-xs text-stone-600">소유·허가 근거를 기록하세요. 개인정보나 비밀번호는 입력하지 마세요.</p>
            {rightsAttempted && rights.note.trim().length < 3 && <p id={`${fieldId}-rights-note-error`} className="mt-1 text-xs text-rose-700">사용권 근거를 3자 이상 입력하세요.</p>}
          </div>
          <button className="btn-ghost" type="button" disabled={freezeBusy || !p.mediaRevisionHash} aria-busy={freezeBusy} onClick={async () => {
            if (freezeRequestBusy.current || freezeBusy || !p.mediaRevisionHash) return;
            setRightsAttempted(true); setFreezeError(null);
            if (!rights.confirmed || rights.note.trim().length < 3) {
              document.getElementById(!rights.confirmed ? `${fieldId}-media-rights` : `${fieldId}-rights-note`)?.focus();
              return;
            }
            freezeRequestBusy.current = true; setFreezeSubmitting(true); setFreezeMessage("");
            try {
              await requestFreeze({ pieceId: p._id as Id<"contentPieces">, expectedMediaRevisionHash: p.mediaRevisionHash, rightsConfirmed: true, rightsNote: rights.note.trim() });
              setFreezeMessage("미디어 저장을 요청했습니다. 이 화면에서 진행 상태를 확인할 수 있습니다.");
            } catch (error) { setFreezeError(`${errorMessage(error)} 입력 내용과 최신 콘텐츠를 확인한 뒤 다시 시도하세요.`); }
            finally { freezeRequestBusy.current = false; setFreezeSubmitting(false); }
          }}>{freezeBusy ? "미디어 고정 중…" : p.mediaFreeze?.status === "FAILED" || p.mediaFreeze?.status === "CANCELLED" || freezeError ? "미디어 고정 다시 시도" : "미디어 고정하기"}</button>
          {!p.mediaRevisionHash && <p className="text-xs text-amber-800">최신 콘텐츠 정보를 불러온 뒤 미디어를 고정할 수 있습니다. 화면을 새로고침하세요.</p>}
        </fieldset>}
        {!mediaReady && !canFreeze && <p className="mt-2 text-xs text-amber-800">{p.mine && p.collectionId && p.collectionStatus !== "DRAFT" ? "묶음을 수정 상태로 전환한 뒤 미디어 고정을 진행하세요." : "콘텐츠 소유자 또는 운영자가 미디어 고정과 재승인을 완료해야 합니다."}</p>}
        {mediaReady && p.status === "APPROVED" && p.mediaApprovalReady !== true && <p className="mt-2 text-xs text-amber-800">{p.mediaApprovalReason ?? "고정된 파일에 대한 승인 기록이 없습니다."} {canFreeze ? "‘콘텐츠 수정’을 열고 내용을 그대로 저장한 뒤, 파일과 검토 항목을 확인하고 다시 승인하세요." : "콘텐츠 소유자 또는 운영자가 수정·재승인해야 게시할 수 있습니다."}</p>}
        {freezeError && <p className="mt-2 break-words text-xs text-rose-700" role="alert">{freezeError}</p>}
      </section>}
      {editing ? (
        <div className="grid gap-2">
          <div><label className="label" htmlFor={`${fieldId}-caption`}>본문</label><textarea id={`${fieldId}-caption`} className="input" rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} /></div>
          <div><label className="label" htmlFor={`${fieldId}-hashtags`}>해시태그</label><input id={`${fieldId}-hashtags`} className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="공백으로 구분하고 #은 생략할 수 있습니다" /></div>
          {p.script !== null && <div><label className="label" htmlFor={`${fieldId}-script`}>숏폼 대본</label><textarea id={`${fieldId}-script`} className="input" rows={4} value={script} onChange={(e) => setScript(e.target.value)} /></div>}
          <div>
            <label className="label" htmlFor={`${fieldId}-media-edit`}>HTTPS 미디어 URL</label>
            <textarea id={`${fieldId}-media-edit`} className="input" rows={Math.max(3, Math.min(8, editedMediaUrls.length + 1))} value={media} aria-invalid={!!mediaEditError} aria-describedby={`${fieldId}-media-help${shortForm ? ` ${fieldId}-shortform-media-help` : ""}${mediaEditError ? ` ${fieldId}-media-error` : ""}`} onChange={(event) => setMedia(event.target.value)} />
            <p id={`${fieldId}-media-help`} className="mt-1 text-xs text-stone-500">URL을 한 줄에 하나씩 입력하세요. 공백으로 구분해도 됩니다.</p>
            {shortForm && <p id={`${fieldId}-shortform-media-help`} className="mt-1 text-xs font-medium text-amber-800">Reels·TikTok은 기존 정적 상품 이미지를 모두 지우고 HTTPS 영상 URL 1개로 교체해야 합니다.</p>}
            {mediaEditError && <p id={`${fieldId}-media-error`} className="mt-1 text-xs text-rose-700">{mediaEditError}</p>}
          </div>
          {structuredReview && <p className="text-xs text-stone-500">수정 저장 시 새 출력으로 다시 평가되며 이전 사람 검토 체크는 초기화됩니다.</p>}
          <div className="flex flex-wrap gap-2"><button className="btn-primary" type="button" aria-describedby={mediaEditError ? `${fieldId}-media-error` : undefined} onClick={async () => {
            if (mediaEditError) {
              document.getElementById(`${fieldId}-media-edit`)?.focus();
              return;
            }
            const result = await onEdit?.({ caption, hashtags: tags.split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean), script: p.script !== null ? script : undefined, mediaUrls: editedMediaUrls });
            if (result !== false) {
              setEditing(false);
              setReviewState({ revision: reviewRevision, checklist: emptyReviewChecklist() });
            }
          }}>수정 내용 저장</button><button className="btn-ghost" type="button" onClick={() => { setCaption(displayCaption); setTags(p.hashtags.join(" ")); setScript(p.script ?? ""); setMedia(p.mediaUrls.join("\n")); setEditing(false); }}>취소</button></div>
        </div>
      ) : (
        <>
          {manifest.length > 0 && (
            <div>
              <div id={`${fieldId}-media`} className={`grid grid-cols-1 gap-2 ${manifest.length === 1 ? "sm:max-w-md" : "sm:grid-cols-2"}`} role="group" aria-label={`콘텐츠 미디어 ${p.mediaUrls.length}개`}>
                {visibleMedia.map(({ url, mimeType, sizeBytes }, index) => {
                  const label = `${p.productName ?? p.magazineTitle ?? "콘텐츠"} 미디어 ${index + 1}/${p.mediaUrls.length}`;
                  const isVideo = mimeType.startsWith("video/");
                  return <figure key={`${reviewRevision}-${url}-${index}-${previewAttempt}`} className="min-w-0">
                    {isVideo ? <video className="aspect-[4/5] w-full rounded-lg bg-stone-100 object-contain outline outline-1 -outline-offset-1 outline-black/10" controls playsInline preload="metadata" aria-label={label} onLoadedMetadata={() => setPreviewResult(url, true)} onError={() => setPreviewResult(url, false)}>
                      <source src={url} type={mimeType} onError={() => setPreviewResult(url, false)} />
                    </video> : <Image src={url} alt={label} width={640} height={800} unoptimized className="aspect-[4/5] w-full rounded-lg bg-stone-100 object-contain outline outline-1 -outline-offset-1 outline-black/10" onLoad={() => setPreviewResult(url, true)} onError={() => setPreviewResult(url, false)} />}
                    <figcaption className="mt-1 flex flex-wrap gap-x-2 text-xs text-stone-600"><span className="tabular-nums">{index + 1}/{manifest.length} · {Math.ceil(sizeBytes / 1024).toLocaleString()}KB</span><a href={url} target="_blank" rel="noreferrer" className="underline">고정 파일 {index + 1} 열기<span className="sr-only"> (새 창)</span></a></figcaption>
                  </figure>;
                })}
              </div>
              {hiddenMediaCount > 0 && <button className="btn-ghost mt-2 w-full" type="button" aria-expanded={showAllMedia} aria-controls={`${fieldId}-media`} onClick={() => setShowAllMedia((value) => !value)}>{showAllMedia ? "미디어 미리보기 접기" : `+${hiddenMediaCount} · 전체 미디어 보기`}</button>}
              {preview.failed.length > 0 && <div className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900"><p>일부 미리보기를 불러오지 못했습니다. 네트워크와 파일 재생을 확인하세요. 확인할 수 없는 파일은 승인하지 마세요.</p><button className="btn-ghost mt-2" type="button" onClick={() => { setPreviewState({ revision: reviewRevision, loaded: [], failed: [] }); setPreviewAttempt((value) => value + 1); }}>미리보기 다시 불러오기</button></div>}
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
      {requiresStructuredReview && (
        <fieldset className="rounded-lg border border-amber-200 bg-amber-50 p-3" aria-describedby={`${fieldId}-review-help`} disabled={approving || !mediaReady || !previewComplete}>
          <legend className="px-1 text-sm font-semibold text-amber-950">사람 검토 체크</legend>
          <p id={`${fieldId}-review-help`} className="text-xs text-amber-900">게시 승인 전에 4개 항목을 직접 확인해야 합니다. 미디어는 고정된 파일을 모두 확인하세요. 현재 {reviewCount}/{REVIEW_CHECKLIST_ITEMS.length}개 확인했습니다.</p>
          <div className="mt-2 grid gap-2">
            {REVIEW_CHECKLIST_ITEMS.map((item) => (
              <label key={item.key} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-white p-2 text-xs text-stone-800" htmlFor={`${fieldId}-review-${item.key}`}>
                <input id={`${fieldId}-review-${item.key}`} className="mt-0.5 h-4 w-4 shrink-0 accent-orange-700" type="checkbox" checked={reviewChecklist[item.key]} onChange={(event) => setReviewState({ revision: reviewRevision, checklist: { ...reviewChecklist, [item.key]: event.target.checked } })} />
                <span><strong className="block">{item.label}</strong><span className="mt-0.5 block text-stone-600">{item.description}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {approvalDisabledReasons.length > 0 && p.mine && p.status === "DRAFT" && !p.legacyBlocked && <div id={`${fieldId}-approval-disabled`} className="text-xs text-amber-800"><strong>승인 대기</strong><ul className="mt-1 list-disc space-y-0.5 pl-4">{approvalDisabledReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button className="btn-ghost" type="button" aria-describedby={copyStatus === "idle" ? undefined : `${fieldId}-copy-status`} onClick={async () => {
          try {
            if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
            await navigator.clipboard.writeText(pieceText(p));
            setCopyStatus("copied");
            window.setTimeout(() => setCopyStatus((current) => current === "copied" ? "idle" : current), 1500);
          } catch {
            setCopyStatus("failed");
          }
        }}>{copyStatus === "copied" ? "복사됨" : copyStatus === "failed" ? "다시 복사" : "콘텐츠 복사"}</button>
        {p.status === "APPROVED" && !p.legacyBlocked && !effectivePublishingDisabledReason && <Link className={!p.mine ? "btn-primary" : "btn-ghost"} href={publishHref ?? `/dashboard/publish?piece=${p._id}`}>이 콘텐츠로 게시</Link>}
        {p.status === "APPROVED" && !p.legacyBlocked && !effectivePublishingDisabledReason && <Link className="btn-ghost" href={`/dashboard/schedules?piece=${p._id}`}>예약</Link>}
        {p.status === "APPROVED" && !p.legacyBlocked && effectivePublishingDisabledReason && <span className="text-amber-800">게시·예약 대기: {effectivePublishingDisabledReason}</span>}
        {!p.mine && !p.legacyBlocked && onCopy && <button className="btn-ghost" type="button" onClick={onCopy}>복사해서 편집</button>}
        {p.mine && p.status === "DRAFT" && !p.legacyBlocked && onApprove && <button className={`btn-primary ${approvalBlocked && !approving ? "cursor-not-allowed opacity-50" : ""}`} type="button" disabled={approving} aria-disabled={!approving && approvalBlocked ? true : undefined} aria-busy={approving} aria-describedby={approvalBlocked ? `${fieldId}-approval-disabled` : undefined} onClick={async () => {
          if (approvalBlocked || approving) return;
          setApproving(true);
          try {
            await onApprove(reviewChecklist);
          } finally {
            setApproving(false);
          }
        }}>{approving ? "콘텐츠 승인 중…" : "콘텐츠 승인"}</button>}
        {p.mine && (p.status !== "RETIRED" || !!p.collectionId) && onEdit && !editing && <button className="btn-ghost" type="button" disabled={freezeBusy} onClick={() => { setCaption(displayCaption); setTags(p.hashtags.join(" ")); setScript(p.script ?? ""); setMedia(p.mediaUrls.join("\n")); setEditing(true); }}>{p.status === "RETIRED" ? "수정해서 복구" : "콘텐츠 수정"}</button>}
        {p.mine && p.collectionId && onRemove && !editing && <button className="btn-ghost" type="button" onClick={onRemove}>묶음에서 제거</button>}
        {onShare && p.status === "APPROVED" && !p.legacyBlocked && <button className="btn-ghost" type="button" onClick={() => onShare(p.visibility !== "SHARED")}>{p.visibility === "SHARED" ? "공유 해제" : "전체 공유"}</button>}
        {p.mine && p.status !== "RETIRED" && onReject && (
          <span className="ml-auto flex flex-wrap items-center gap-1"><label className="sr-only" htmlFor={`${fieldId}-reject-reason`}>콘텐츠 거절 사유</label><input id={`${fieldId}-reject-reason`} className="input w-auto min-w-36 py-1 text-xs" placeholder="거절 사유 입력" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn-ghost" type="button" disabled={!reason.trim()} onClick={() => onReject(reason.trim())}>콘텐츠 거절</button></span>
        )}
      </div>
      <p id={`${fieldId}-copy-status`} className={copyStatus === "failed" ? "text-xs text-rose-700" : "text-xs text-emerald-700"} role="status" aria-live="polite" aria-atomic="true">{copyMessage}</p>
    </article>
  );
}
