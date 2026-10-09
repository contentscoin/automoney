"use client";

import Link from "next/link";
import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { CHANNEL_PLATFORM, PLATFORM_LIMITS, kstDayKey } from "@automoney/shared";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { pieceText } from "@/components/PieceCard";
import { inspectPublishMedia, mediaLivePublishIssue } from "@/components/publish-media";
import { useReadiness } from "@/components/use-readiness";
import { dateTime, errorMessage } from "@/lib/format";
import { DOW, JOB_STATUS_LABEL, PLATFORM_LABEL } from "@/lib/agent-format";
import { CHANNEL_LABEL } from "@/lib/content-format";

type Kind = "ONE_SHOT" | "DAILY" | "WEEKLY";
const newRequestId = () => `schedule_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
const isPastSchedule = (date: string, time: string) => Date.parse(`${date}T${time}:00+09:00`) <= Date.now();
const TRANSIENT_ISSUES = new Set(["DEVICE_OFFLINE", "SPACE_BUSY"]);
const SKIP_REASON: Record<string, string> = {
  LIVE_PUBLISH_DISABLED: "실제 게시가 아직 활성화되지 않았습니다. 게시 테스트를 이용하거나 운영팀에 확인하세요.",
  SPACE_NOT_FOUND: "게시 계정이 삭제되었습니다. 다른 계정으로 예약을 다시 등록하세요.",
  TARGET_IDENTITY_REVIEW_REQUIRED: "게시 계정을 다시 확인하고 새 예약을 등록하세요.",
  TARGET_IDENTITY_CHANGED: "연결된 SNS 계정이 변경되었습니다. 새 계정을 확인한 뒤 예약을 다시 등록하세요.",
  CONTENT_UNAVAILABLE: "콘텐츠가 철회되거나 승인이 취소되었습니다. 사용 가능한 콘텐츠를 선택하세요.",
  CONTENT_PLATFORM_MISMATCH: "콘텐츠 채널과 게시 계정이 다릅니다. 같은 채널의 계정으로 다시 등록하세요.",
  CONTENT_PRODUCT_INACTIVE: "콘텐츠 상품이 판매 중이 아닙니다. 다른 상품의 콘텐츠를 선택하세요.",
  CONTENT_FACTS_CHANGED: "상품 정보가 변경되었습니다. 내 콘텐츠에서 사실 확인과 검수를 다시 진행하세요.",
  LINK_NOT_FOUND: "마케팅 링크를 찾을 수 없습니다. 링크 관리에서 다시 발급하세요.",
  LINK_INACTIVE: "마케팅 링크가 중지되었습니다. 활성 링크로 예약을 다시 등록하세요.",
  DEMO_LINK_NOT_PUBLISHABLE: "데모 링크는 실제 게시에 사용할 수 없습니다. 실제 파트너 링크로 다시 등록하세요.",
  CONTENT_LINK_REQUIRED: "상품 마케팅 링크가 필요합니다. 같은 상품의 실제 링크를 선택하세요.",
  CONTENT_LINK_PRODUCT_MISMATCH: "콘텐츠와 링크의 상품이 다릅니다. 같은 상품의 링크를 선택하세요.",
  DAILY_POST_LIMIT: "게시 계정의 하루 한도에 도달해 이번 실행을 건너뛰었습니다.",
  PUBLIC_SITE_URL_INVALID: "링크 주소 설정을 운영팀에서 확인해야 합니다.",
  CONTENT_REVIEW_REQUIRED: "콘텐츠를 다시 검수한 뒤 새 예약을 등록하세요.",
  CONTENT_SNAPSHOT_MISSING: "이전 방식으로 저장된 예약입니다. 콘텐츠를 확인하고 다시 등록하세요.",
  CONTENT_REVISION_CHANGED: "승인된 콘텐츠가 변경되었습니다. 최신 콘텐츠로 예약을 다시 등록하세요.",
  MEDIA_INTEGRITY_REQUIRED: "고정된 미디어 증거가 없습니다. 내 콘텐츠에서 미디어를 고정·검수하고 새 예약을 등록하세요.",
  MEDIA_REVIEW_REQUIRED: "미디어를 내 콘텐츠에 저장하고 고정·검수한 뒤 새 예약을 등록하세요.",
  MEDIA_INTEGRITY_CHANGED: "고정된 미디어 파일을 확인할 수 없습니다. 내 콘텐츠에서 파일을 다시 준비하고 승인하세요.",
  MEDIA_DESKTOP_UPDATE_REQUIRED: "미디어 게시에는 PC 앱 0.1.18 이상이 필요합니다. 연결 관리에서 업데이트를 확인하세요.",
  DESKTOP_UPDATE_REQUIRED: "PC 앱을 최신 버전으로 업데이트하세요. 미디어 게시에는 0.1.18 이상이 필요합니다.",
  CONTENT_CHANNEL_REVIEW_REQUIRED: "Instagram 게시 형식을 선택하고 예약을 다시 등록하세요.",
  META_CONFIG_REVIEW_REQUIRED: "실제 Meta 계정 연결을 확인한 뒤 예약을 다시 등록하세요.",
  PUBLISH_PAYLOAD_REVIEW_REQUIRED: "본문과 미디어 형식을 확인한 뒤 예약을 다시 등록하세요.",
  PUBLISH_ENQUEUE_REVIEW_REQUIRED: "게시 준비 정보를 확인한 뒤 예약을 다시 등록하세요.",
};

function skipMessage(reason: string) {
  return SKIP_REASON[reason] ?? (reason.startsWith("SPACE_")
    ? "게시 계정의 로그인과 상태 확인이 필요합니다. 연결 관리에서 확인하세요."
    : `실행을 건너뛰었습니다 (${reason}). 작업 결과와 연결 상태를 확인하세요.`);
}

export default function SchedulesPage() {
  return <Suspense fallback={<p className="text-sm text-stone-500">예약 정보를 불러오는 중…</p>}><SchedulesPageInner /></Suspense>;
}

function SchedulesPageInner() {
  const params = useSearchParams();
  const library = useQuery(api.content.listLibrary, { status: "APPROVED", limit: 200 });
  const spaces = useQuery(api.spaces.listMine);
  const links = useQuery(api.links.listMine);
  const rows = useQuery(api.schedules.listMine);
  const jobs = useQuery(api.jobs.listMine, { limit: 100 });
  const readiness = useReadiness();
  const upsert = useMutation(api.schedules.upsert);
  const setEnabled = useMutation(api.schedules.setEnabled);
  const remove = useMutation(api.schedules.remove);
  const [pieceId, setPieceId] = useState(params.get("piece") ?? "");
  const selectedPiece = useQuery(api.content.getPublishPiece, pieceId ? { pieceId } : "skip");
  const [f, setF] = useState({ spaceId: "", kind: "DAILY" as Kind, timeOfDay: "10:00", days: [1, 3, 5] as number[], runDate: "", jitter: 15, text: "", media: "", contentChannel: "INSTAGRAM_FEED" as "INSTAGRAM_FEED" | "INSTAGRAM_REEL", linkId: params.get("link") ?? "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const requestRef = useRef<{ fingerprint: string; clientRequestId: string } | null>(null);
  const issueRef = useRef<HTMLDivElement>(null);
  const piece = pieceId ? selectedPiece : null;
  const selectablePieces = piece && !library?.some((row) => row._id === piece._id) ? [piece, ...(library ?? [])] : library;
  const usable = spaces?.filter((space) => space.sessionState === "HEALTHY") ?? [];
  const selectedSpace = usable.find((space) => space._id === f.spaceId);
  const selectedLink = links?.find((link) => link._id === f.linkId);
  const text = pieceId ? piece ? pieceText(piece) : "" : f.text;
  const media = pieceId ? piece?.mediaUrls.join(" ") ?? "" : f.media;
  const mediaUrls = media.split(/\s+/).filter(Boolean);
  const contentChannel = piece?.channel ?? (selectedSpace?.platform === "INSTAGRAM" ? f.contentChannel : undefined);
  const mediaCheck = inspectPublishMedia({ mediaUrls, pieceChannel: contentChannel, platform: selectedSpace?.platform });
  const readySpace = readiness?.spaces.find((space) => space.id === f.spaceId);
  const mediaLiveIssue = mediaLivePublishIssue({ mediaCount: mediaUrls.length, hasPiece: !!piece, mediaReady: piece?.mediaIntegrity?.ready, mediaApprovalReady: piece?.mediaApprovalReady,
    browserSpace: !!selectedSpace && selectedSpace.authMode !== "META_API", mediaVersionCompatible: readySpace?.mediaVersionCompatible, minimumMediaVersion: readiness?.minimumMediaPublishDesktopVersion });
  const readyIssues = [
    ...(readiness?.issues.filter((issue) => issue.scope === "all" || issue.code === "LIVE_PUBLISH_DISABLED" || (f.linkId && issue.code === "PUBLIC_SITE_URL_INVALID")) ?? []),
    ...(readySpace?.issues ?? []),
  ].filter((issue, index, all) => all.findIndex((item) => item.code === issue.code) === index);
  const notices = readyIssues.filter((issue) => TRANSIENT_ISSUES.has(issue.code));
  const issues: string[] = readyIssues.filter((issue) => !TRANSIENT_ISSUES.has(issue.code)).map((issue) => issue.message);
  if (mediaLiveIssue) issues.push(mediaLiveIssue);
  const loading = !readiness || !spaces || !links || !library || (!!pieceId && selectedPiece === undefined);
  if (loading) issues.push("예약에 필요한 정보를 확인하고 있습니다.");
  if (!selectedSpace) issues.push("정상 상태의 게시 계정을 선택하세요.");
  if (pieceId && selectedPiece === null) issues.push("이 콘텐츠는 승인 취소 또는 공개 종료되어 사용할 수 없습니다. 다른 콘텐츠를 선택하세요.");
  const channelMismatch = !!piece && !!selectedSpace && CHANNEL_PLATFORM[piece.channel] !== selectedSpace.platform;
  if (channelMismatch) issues.push("콘텐츠 채널과 게시 계정이 다릅니다. 같은 채널의 계정을 선택하세요.");
  if (!text.trim() && mediaUrls.length === 0) issues.push("본문 또는 미디어를 입력하세요.");
  if (piece?.productId && !f.linkId) issues.push("콘텐츠와 같은 상품의 실제 마케팅 링크를 선택하세요.");
  if (f.linkId && links && !selectedLink) issues.push("선택한 마케팅 링크를 찾을 수 없습니다. 다른 링크를 선택하세요.");
  if (selectedLink?.status !== "ACTIVE" && selectedLink) issues.push("활성 상태의 마케팅 링크를 선택하세요.");
  if (selectedLink && ["MOCK", "DEMO"].includes(selectedLink.origin ?? "")) issues.push("데모 링크로는 예약 게시할 수 없습니다. 링크 관리에서 실제 파트너 링크를 발급하세요.");
  const productMismatch = !!piece?.productId && !!selectedLink && selectedLink.product?._id !== piece.productId;
  if (productMismatch) issues.push("콘텐츠 상품과 같은 상품의 마케팅 링크를 선택하세요.");
  if (f.kind === "WEEKLY" && f.days.length === 0) issues.push("예약할 요일을 하나 이상 선택하세요.");
  if (f.kind === "ONE_SHOT" && (!f.runDate || Date.parse(`${f.runDate}T${f.timeOfDay}:00+09:00`) <= (readiness?.checkedAt ?? 0))) issues.push("아직 지나지 않은 실행 일자와 시각을 선택하세요.");
  if (!Number.isFinite(f.jitter) || f.jitter < 0 || f.jitter > 120) issues.push("시간 편차는 0~120분으로 입력하세요.");
  if (mediaCheck.invalidMediaUrls.length) issues.push("미디어는 HTTPS 주소로 입력하세요.");
  if (mediaCheck.requiresVideo && !mediaCheck.hasVerifiedVideo) issues.push("Reels·TikTok에는 .mp4, .mov, .m4v 또는 .webm 형식의 HTTPS 영상 1개가 필요합니다.");
  else if (mediaCheck.contentMediaError) issues.push("선택한 채널에서 사용할 수 있는 미디어 형식과 개수를 확인하세요.");
  if (selectedSpace) {
    const limits = PLATFORM_LIMITS[selectedSpace.platform];
    if ([...text].length > limits.maxChars) issues.push(`본문을 ${limits.maxChars}자 이내로 줄이세요. 마케팅 링크도 글자 수에 포함됩니다.`);
    if (mediaUrls.length > limits.maxMedia) issues.push(`이 채널에는 미디어를 최대 ${limits.maxMedia}개 사용할 수 있습니다.`);
    if (limits.mediaRequired && mediaUrls.length === 0) issues.push("이 채널에는 게시할 이미지 또는 영상이 필요합니다.");
    if (selectedSpace.authMode === "META_API" && mediaUrls.length > 1) issues.push("Meta API로 연결한 계정에는 미디어 1개만 예약할 수 있습니다.");
  }

  async function toggleSchedule(id: Id<"schedules">, enabled: boolean) {
    if (busyId) return;
    setBusyId(id); setActionMsg(null); setActionError(null);
    try {
      await setEnabled({ id, enabled });
      setActionMsg(enabled ? "예약을 재개했습니다. 다음 실행 시각을 확인하세요." : "예약을 중지했습니다.");
    } catch (error) { setActionError(`${errorMessage(error)} 상태를 확인한 뒤 다시 시도하세요.`); }
    finally { setBusyId(null); }
  }

  async function deleteSchedule(id: Id<"schedules">) {
    if (busyId) return;
    setBusyId(id); setActionMsg(null); setActionError(null);
    try {
      await remove({ id }); setDeleteId(null); setActionMsg("예약을 삭제했습니다.");
    } catch (error) { setActionError(`${errorMessage(error)} 상태를 확인한 뒤 다시 시도하세요.`); }
    finally { setBusyId(null); }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">예약 발행</h1>
        <p className="mt-1 text-sm text-stone-600">한국 시간(KST) 기준으로 예약합니다. 시간 편차를 설정하면 지정 시각 전후로 실행됩니다. 실행마다 작업 결과에서 최종 승인해야 게시됩니다.</p>
      </div>
      {readiness && !readiness.livePublishEnabled && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">실제 게시 준비 중</p><p className="mt-1">이 화면의 예약 등록과 재개는 실제 게시가 활성화된 뒤 사용할 수 있습니다. 기존 예약도 실행 시각에 실제 게시가 중지되어 있으면 건너뜁니다.</p><Link href="/dashboard/publish?dryRun=1" className="mt-2 inline-block underline">게시 테스트로 이동</Link></div>}
      {spaces && usable.length === 0 && <p className="text-sm text-stone-600">예약할 계정이 없습니다. <Link href="/dashboard/connections#sns" className="underline">연결 관리에서 SNS 계정을 연결하고 상태를 확인하세요.</Link></p>}
      <section className="card">
        <h2 className="font-semibold">새 예약</h2>
        <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={async (event) => {
          event.preventDefault();
          if (submitting) return;
          setMsg(null); setFormError(null);
          if (issues.length) { issueRef.current?.focus(); return; }
          if (f.kind === "ONE_SHOT" && isPastSchedule(f.runDate, f.timeOfDay)) {
            setFormError("선택한 실행 시각이 지났습니다. 미래 일자와 시각을 선택하세요."); return;
          }
          const payload = {
            spaceId: f.spaceId as Id<"spaces">, kind: f.kind, timeOfDay: f.timeOfDay,
            daysOfWeek: f.kind === "WEEKLY" ? [...f.days].sort() : [], runDate: f.kind === "ONE_SHOT" ? f.runDate : undefined,
            jitterMinutes: f.jitter, text, mediaUrls, contentChannel,
            linkId: (f.linkId || undefined) as Id<"marketingLinks"> | undefined,
            pieceId: (pieceId || undefined) as Id<"contentPieces"> | undefined, autoApprove: false,
          };
          const fingerprint = JSON.stringify(payload);
          if (requestRef.current?.fingerprint !== fingerprint) requestRef.current = { fingerprint, clientRequestId: newRequestId() };
          setSubmitting(true);
          try {
            const result = await upsert({ ...payload, clientRequestId: requestRef.current.clientRequestId });
            setMsg(`예약했습니다. 다음 실행: ${result.nextRunAt ? dateTime(result.nextRunAt) : "실행 시각 없음"}`);
            setF((previous) => ({ ...previous, text: "", media: "" })); setPieceId(""); requestRef.current = null;
          } catch (error) { setFormError(`${errorMessage(error)} 입력 내용과 연결 상태를 확인한 뒤 다시 시도하세요.`); }
          finally { setSubmitting(false); }
        }}>
          <fieldset className="contents" disabled={submitting}>
          <div><label htmlFor="schedule-space" className="label">게시 계정 (필수)</label><select id="schedule-space" className="input" required value={f.spaceId} aria-invalid={channelMismatch || undefined} aria-describedby={channelMismatch ? "schedule-issues" : undefined} onChange={(event) => setF({ ...f, spaceId: event.target.value })}><option value="">계정 선택</option>{usable.map((space) => <option key={space._id} value={space._id}>[{PLATFORM_LABEL[space.platform]}] {space.name}{space.handle ? ` @${space.handle}` : ""}</option>)}</select></div>
          <div><label htmlFor="schedule-kind" className="label">주기</label><select id="schedule-kind" className="input" value={f.kind} onChange={(event) => setF({ ...f, kind: event.target.value as Kind })}><option value="DAILY">매일</option><option value="WEEKLY">요일별</option><option value="ONE_SHOT">1회</option></select></div>
          <div><label htmlFor="schedule-time" className="label">시각 (KST, 필수)</label><input id="schedule-time" className="input" type="time" required value={f.timeOfDay} onChange={(event) => setF({ ...f, timeOfDay: event.target.value })} /></div>
          <div><label htmlFor="schedule-jitter" className="label">시간 편차 (±분)</label><input id="schedule-jitter" className="input" type="number" min={0} max={120} required value={f.jitter} onChange={(event) => setF({ ...f, jitter: Number(event.target.value) })} /></div>
          {f.kind === "WEEKLY" && <fieldset className="sm:col-span-2"><legend className="label">요일 (하나 이상 선택)</legend><div className="flex flex-wrap gap-3">{DOW.map((day, index) => <label key={day} htmlFor={`schedule-day-${index}`} className="flex min-h-10 items-center gap-1 text-sm"><input id={`schedule-day-${index}`} type="checkbox" checked={f.days.includes(index)} onChange={(event) => setF({ ...f, days: event.target.checked ? [...f.days, index] : f.days.filter((value) => value !== index) })} />{day}</label>)}</div></fieldset>}
          {f.kind === "ONE_SHOT" && <div><label htmlFor="schedule-date" className="label">실행 일자 (필수)</label><input id="schedule-date" className="input" type="date" required min={readiness ? kstDayKey(readiness.checkedAt) : undefined} value={f.runDate} onChange={(event) => setF({ ...f, runDate: event.target.value })} /></div>}
          <div className="sm:col-span-2"><label htmlFor="schedule-piece" className="label">승인된 콘텐츠</label><select id="schedule-piece" className="input" value={pieceId} onChange={(event) => setPieceId(event.target.value)}><option value="">직접 입력</option>{pieceId && !piece && <option value={pieceId}>{selectedPiece === undefined ? "선택한 콘텐츠 확인 중…" : "사용할 수 없는 콘텐츠"}</option>}{selectablePieces?.map((item) => <option key={item._id} value={item._id}>[{CHANNEL_LABEL[item.channel] ?? item.channel}] {item.caption.slice(0, 60)}</option>)}</select></div>
          {!pieceId && selectedSpace?.platform === "INSTAGRAM" && <div><label htmlFor="schedule-format" className="label">Instagram 게시 형식</label><select id="schedule-format" className="input" value={f.contentChannel} onChange={(event) => setF({ ...f, contentChannel: event.target.value as "INSTAGRAM_FEED" | "INSTAGRAM_REEL" })}><option value="INSTAGRAM_FEED">피드 이미지</option><option value="INSTAGRAM_REEL">Reel 영상</option></select></div>}
          {pieceId && <p id="schedule-piece-hint" className="text-sm text-stone-600 sm:col-span-2">승인된 본문과 미디어를 그대로 예약합니다. 수정하려면 <Link href="/dashboard/content/mine" className="underline">내 콘텐츠에서 편집하고 다시 승인하세요.</Link></p>}
          <div className="sm:col-span-2"><label htmlFor="schedule-text" className="label">본문</label><textarea id="schedule-text" className="input read-only:bg-stone-50" rows={4} readOnly={!!pieceId} aria-describedby={pieceId ? "schedule-piece-hint" : undefined} value={text} onChange={(event) => setF({ ...f, text: event.target.value })} placeholder="게시할 문안. 선택한 마케팅 링크는 본문 끝에 붙습니다." /></div>
          <div><label htmlFor="schedule-media" className="label">이미지·영상 URL (공백 구분)</label><input id="schedule-media" className="input read-only:bg-stone-50" readOnly={!!pieceId} aria-describedby={`schedule-media-hint${pieceId ? " schedule-piece-hint" : ""}`} value={media} onChange={(event) => setF({ ...f, media: event.target.value })} placeholder="https://…" /><p id="schedule-media-hint" className="mt-1 text-xs text-stone-600">미디어 예약은 고정·승인된 콘텐츠로만 가능합니다. <Link className="underline" href="/dashboard/content/mine">내 콘텐츠에서 미디어 고정·검수</Link>를 완료하세요. PC 미디어 게시에는 앱 {readiness?.minimumMediaPublishDesktopVersion ?? "0.1.18"} 이상이 필요합니다.</p></div>
          <div><label htmlFor="schedule-link" className="label">마케팅 링크{piece?.productId ? " (동일 상품 필수)" : ""}</label><select id="schedule-link" className="input" value={f.linkId} aria-invalid={productMismatch || undefined} aria-describedby={productMismatch ? "schedule-issues" : undefined} onChange={(event) => setF({ ...f, linkId: event.target.value })}><option value="">링크 없음</option>{links?.map((link) => <option key={link._id} value={link._id}>{link.product?.name ?? link.shortCode}{["MOCK", "DEMO"].includes(link.origin ?? "") ? " · 데모" : ""}{link.status !== "ACTIVE" ? " · 중지됨" : ""}</option>)}</select><Link href="/dashboard/links" className="mt-1 inline-block text-xs underline">실제 마케팅 링크 확인·발급</Link></div>
          {notices.length > 0 && <div className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600 sm:col-span-2"><p>실행 시각 전에 준비하세요.</p>{notices.map((issue) => <p key={issue.code}>{issue.message} <Link href={issue.href} className="underline">준비 상태 확인</Link></p>)}</div>}
          {issues.length > 0 && <div id="schedule-issues" ref={issueRef} tabIndex={-1} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 sm:col-span-2"><p className="font-medium">예약 전 확인해 주세요.</p><ul className="mt-1 list-disc space-y-1 ps-5">{[...new Set(issues)].map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
          <p className="text-sm text-stone-600 sm:col-span-2">예약 시각은 5분 주기로 확인합니다. 게시 계정의 하루 한도를 넘으면 해당 실행을 건너뜁니다. PC로 연결한 계정은 실행 시각에 앱이 켜져 있어야 합니다.</p>
          <div className="sm:col-span-2"><button className="btn-primary" disabled={submitting || loading || readiness?.livePublishEnabled === false}>{submitting ? "예약 등록 중…" : "예약 등록"}</button></div>
          </fieldset>
        </form>
        <p className="mt-2 text-sm text-stone-700" role="status">{msg}</p>
        {formError && <p className="mt-2 text-sm text-rose-700" role="alert">{formError}</p>}
      </section>
      <section className="card">
        <h2 className="font-semibold">예약 목록</h2>
        <p className="mt-1 text-xs text-stone-500">좁은 화면에서는 표를 좌우로 스크롤할 수 있습니다. 본문을 열면 전체 내용을 확인할 수 있습니다.</p>
        <p className="mt-2 text-sm text-stone-700" role="status">{actionMsg}</p>
        {actionError && <p className="mt-2 text-sm text-rose-700" role="alert">{actionError}</p>}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="예약 목록 표">
          <table className="table mt-2 min-w-[760px]">
            <thead><tr><th scope="col">게시 계정</th><th scope="col">주기</th><th scope="col">본문</th><th scope="col">다음 실행</th><th scope="col">마지막 실행·상태</th><th scope="col">승인</th><th scope="col">상태</th><th scope="col">관리</th></tr></thead>
            <tbody>
              {!rows && <tr><td colSpan={8} className="text-center text-stone-500">예약 목록을 불러오는 중…</td></tr>}
              {rows?.length === 0 && <tr><td colSpan={8} className="text-center text-stone-500">등록된 예약이 없습니다. 위에서 콘텐츠와 실행 시각을 선택해 등록하세요.</td></tr>}
              {rows?.map((schedule) => {
                const lastJob = jobs?.find((job) => job._id === schedule.lastJobId);
                const resumeReadiness = readiness?.spaces.find((space) => space.id === schedule.spaceId);
                const scheduleLink = links?.find((link) => link._id === schedule.linkId);
                const scheduledPiece = library?.find((item) => item._id === schedule.pieceId);
                // Do not infer "missing" from the 200-item picker; the server validates older pieces on resume.
                const resumeMediaProblem = schedule.mediaUrls.length > 0
                  ? !schedule.pieceId ? "이전 주소 입력 방식의 미디어 예약입니다. 고정·승인된 콘텐츠로 새 예약을 등록하세요."
                    : scheduledPiece && (scheduledPiece.mediaIntegrity?.ready !== true || scheduledPiece.mediaApprovalReady !== true) ? "콘텐츠의 미디어를 고정하고 다시 승인한 뒤 새 예약을 등록하세요."
                      : resumeReadiness && resumeReadiness.authMode !== "META_API" && !resumeReadiness.mediaVersionCompatible ? `연결된 PC 앱을 ${readiness?.minimumMediaPublishDesktopVersion ?? "0.1.18"} 이상으로 업데이트하세요.` : null
                  : null;
                const resumeProblem = !readiness ? "게시 준비 상태를 확인하고 있습니다."
                  : !readiness.livePublishEnabled ? "실제 게시가 활성화된 뒤 재개할 수 있습니다."
                  : !resumeReadiness ? "게시 계정을 찾을 수 없습니다. 새 예약을 등록하세요."
                  : resumeMediaProblem ?? resumeReadiness.issues.find((issue) => !TRANSIENT_ISSUES.has(issue.code))?.message
                    ?? (schedule.linkId && (!scheduleLink || scheduleLink.status !== "ACTIVE") ? "활성 마케팅 링크를 선택해 예약을 다시 등록하세요."
                      : scheduleLink && ["MOCK", "DEMO"].includes(scheduleLink.origin ?? "") ? "실제 파트너 링크로 예약을 다시 등록하세요."
                        : schedule.kind === "ONE_SHOT" && Date.parse(`${schedule.runDate}T${schedule.timeOfDay}:00+09:00`) <= readiness.checkedAt ? "실행 시각이 지났습니다. 미래 시각으로 새 예약을 등록하세요."
                          : null);
                const resumeBlocked = !!resumeProblem;
                return <tr key={schedule._id}>
                  <td>{schedule.spaceName}</td>
                  <td className="text-xs">{schedule.kind === "DAILY" ? "매일" : schedule.kind === "WEEKLY" ? schedule.daysOfWeek.map((day) => DOW[day]).join("·") : schedule.runDate} {schedule.timeOfDay} ±{schedule.jitterMinutes}분</td>
                  <td className="max-w-xs text-xs"><details><summary className="cursor-pointer break-words">{schedule.contentChannel ? `[${CHANNEL_LABEL[schedule.contentChannel]}] ` : ""}{schedule.text.slice(0, 45) || "미디어 게시"}{schedule.text.length > 45 ? "…" : ""}</summary><p className="mt-2 whitespace-pre-wrap break-words">{schedule.text || "본문 없음"}</p>{schedule.mediaUrls.length > 0 && <p className="mt-1">미디어 {schedule.mediaUrls.length}개</p>}</details></td>
                  <td className="text-xs">{schedule.nextRunAt ? dateTime(schedule.nextRunAt) : "예정 없음"}</td>
                  <td className="max-w-xs text-xs">{schedule.lastRunAt ? dateTime(schedule.lastRunAt) : "실행 전"}{lastJob && <p className="mt-1">{JOB_STATUS_LABEL[lastJob.status] ?? lastJob.status}</p>}{lastJob?.errorMessage && <p className="mt-1 break-words text-rose-700">{lastJob.errorMessage}</p>}{schedule.lastSkipReason && <p className="mt-1 break-words text-amber-800">{schedule.lastSkippedAt ? `${dateTime(schedule.lastSkippedAt)} · ` : ""}{skipMessage(schedule.lastSkipReason)}</p>}{schedule.lastJobId && <Link href="/dashboard/jobs" className="mt-1 inline-block underline">작업 결과·승인 확인</Link>}</td>
                  <td className="text-xs">{schedule.autoApprove ? "자동" : "실행마다 수동"}</td>
                  <td><Badge value={schedule.enabled ? "ACTIVE" : "DISABLED"} label={schedule.enabled ? "활성" : "중지"} /></td>
                  <td><div className="flex min-w-32 flex-wrap gap-2"><button type="button" className="btn-ghost min-h-10 !px-2 text-xs" disabled={!!busyId || (!schedule.enabled && resumeBlocked)} onClick={() => toggleSchedule(schedule._id, !schedule.enabled)}>{busyId === schedule._id ? "처리 중…" : schedule.enabled ? "예약 중지" : "예약 재개"}</button><button type="button" className="btn-ghost min-h-10 !px-2 text-xs text-rose-700" disabled={!!busyId} onClick={() => setDeleteId(schedule._id)}>예약 삭제</button></div>{!schedule.enabled && resumeBlocked && <p className="mt-1 text-xs text-stone-600">{resumeProblem} <Link href="/dashboard/connections" className="underline">게시 준비 상태 확인</Link></p>}{deleteId === schedule._id && <div className="mt-2 rounded-lg border border-rose-200 p-2 text-xs"><p>이 예약을 삭제할까요? 대기 중인 실행도 취소됩니다.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className="btn-ghost min-h-10 !px-2 text-xs" disabled={!!busyId} onClick={() => setDeleteId(null)}>삭제 취소</button><button type="button" className="btn-ghost min-h-10 !px-2 text-xs text-rose-700" disabled={!!busyId} onClick={() => deleteSchedule(schedule._id)}>예약 삭제 확인</button></div></div>}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
