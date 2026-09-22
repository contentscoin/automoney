"use client";

import Link from "next/link";
import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { pieceText } from "@/components/PieceCard";
import { inspectPublishMedia } from "@/components/publish-media";
import { publishRequestAttempt, type PublishRequestAttempt } from "@/components/publish-request";
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
  const [linkId, setLinkId] = useState(params.get("link") ?? "");
  const [linkSelectionTouched, setLinkSelectionTouched] = useState(false);
  const [dryRun, setDryRun] = useState(params.get("dryRun") === "1");
  const [directInstagramChannel, setDirectInstagramChannel] = useState<"INSTAGRAM_FEED" | "INSTAGRAM_REEL">("INSTAGRAM_FEED");
  const [msg, setMsg] = useState<string | null>(null);
  const requestAttemptRef = useRef<PublishRequestAttempt | null>(null);
  const piece = library?.find((item) => item._id === pieceId);
  const text = textOverride ?? (piece ? pieceText(piece) : "");
  const media = mediaOverride ?? (piece ? piece.mediaUrls.join(" ") : "");
  const healthy = spaces?.filter((space) => space.sessionState === "HEALTHY" && !space.locked) ?? [];
  const candidates = piece ? healthy.filter((space) => space.platform === CHANNEL_PLATFORM[piece.channel]) : healthy;
  const selectedSpace = candidates.find((space) => space._id === spaceId);
  const matchingLinks = (links ?? []).filter((link) => link.status === "ACTIVE" && (!piece?.productId || link.product?._id === piece.productId));
  const effectiveLinkId = matchingLinks.some((link) => link._id === linkId) ? linkId : !linkSelectionTouched && piece?.productId ? matchingLinks[0]?._id ?? "" : "";
  const mediaUrls = media.split(/\s+/).filter(Boolean);
  const contentChannel = piece?.channel ?? (selectedSpace?.platform === "INSTAGRAM" ? directInstagramChannel : undefined);
  const { invalidMediaUrls, requiresVideo, hasVerifiedVideo, contentMediaError, mediaInputInvalid } = inspectPublishMedia({ mediaUrls, pieceChannel: contentChannel, platform: selectedSpace?.platform });
  const issues = [] as string[];
  if (!selectedSpace) issues.push("게시 가능한 SNS 계정을 선택하세요.");
  if (!text.trim() && mediaUrls.length === 0) issues.push("본문 또는 미디어가 필요합니다.");
  const selectedLink = links?.find((link) => link._id === effectiveLinkId);
  if (effectiveLinkId && links && !selectedLink) issues.push("선택한 마케팅 링크를 찾을 수 없습니다.");
  if (selectedLink && selectedLink.status !== "ACTIVE") issues.push("활성 상태의 마케팅 링크를 선택하세요.");
  if (piece?.productId && effectiveLinkId && links && selectedLink?.product?._id !== piece.productId) issues.push("콘텐츠 상품과 같은 상품의 마케팅 링크를 선택하세요.");
  if (invalidMediaUrls.length > 0) issues.push("미디어 URL은 모두 HTTPS 주소여야 합니다.");
  if (requiresVideo && !hasVerifiedVideo) issues.push("Reels·TikTok에는 준비된 영상이 필요합니다. 상품 정적 이미지는 영상으로 간주하지 않으므로 .mp4, .mov, .m4v 또는 .webm HTTPS URL을 직접 추가하세요.");
  if (contentChannel === "INSTAGRAM_FEED" && contentMediaError) issues.push("Instagram 피드는 확장자로 이미지임을 확인할 수 있는 HTTPS URL만 사용할 수 있습니다. 영상은 게시 형식을 Reel로 바꾸세요.");
  if (!requiresVideo && selectedSpace && MEDIA_REQUIRED.has(selectedSpace.platform) && mediaUrls.length === 0) issues.push(`${PLATFORM_LABEL[selectedSpace.platform]} 게시에는 미디어가 필요합니다.`);
  const submit = async () => {
    const linkIdValue = effectiveLinkId || undefined;
    const pieceIdValue = pieceId || undefined;
    const attempt = publishRequestAttempt(requestAttemptRef.current, {
      spaceId,
      text,
      mediaUrls,
      contentChannel,
      linkId: linkIdValue,
      pieceId: pieceIdValue,
      requireApproval: true,
      dryRun,
    }, () => crypto.randomUUID());
    requestAttemptRef.current = attempt;
    try {
      const jobId = await enqueue({
        spaceId: spaceId as Id<"spaces">,
        text,
        mediaUrls,
        contentChannel: contentChannel as "INSTAGRAM_FEED" | "INSTAGRAM_REEL" | "THREADS" | "X" | "TIKTOK" | "BLOG" | undefined,
        linkId: linkIdValue as Id<"marketingLinks"> | undefined,
        pieceId: pieceIdValue as Id<"contentPieces"> | undefined,
        requireApproval: true,
        dryRun,
        clientRequestId: attempt.clientRequestId,
      });
      setMsg(`게시 검토 작업을 등록했습니다. 작업 결과에서 승인하세요. (${jobId})`);
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">게시하기</h1>
        <p className="text-sm text-stone-500">콘텐츠와 게시 계정을 확인한 뒤 최종 승인이 필요한 작업으로 등록합니다.</p>
      </div>
      {msg && <p className="rounded-lg bg-stone-100 p-3 text-sm" role="status" aria-live="polite">{msg}</p>}
      {healthy.length === 0 && spaces !== undefined && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">정상 상태의 게시 계정이 없습니다. <Link className="font-medium underline" href="/dashboard/connections#sns">연결 관리에서 계정을 준비하세요.</Link></div>}

      <section className="card grid gap-4 sm:grid-cols-2" aria-labelledby="publish-details-title">
        <h2 id="publish-details-title" className="sm:col-span-2 font-semibold">게시 내용</h2>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="publish-piece">콘텐츠</label>
          <select id="publish-piece" className="input" value={pieceId} onChange={(e) => { setPieceId(e.target.value); setTextOverride(null); setMediaOverride(null); setLinkId(""); setLinkSelectionTouched(false); }}>
            <option value="">직접 입력</option>
            {library?.map((item) => <option key={item._id} value={item._id}>[{CHANNEL_LABEL[item.channel] ?? item.channel}] {item.caption.slice(0, 70)}{item.mine ? "" : " · 운영 제공"}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="publish-space">게시 계정</label>
          <select id="publish-space" className="input" value={selectedSpace?._id ?? ""} aria-required="true" aria-invalid={!selectedSpace} aria-describedby="publish-space-help" onChange={(e) => setSpaceId(e.target.value)}>
            <option value="">선택</option>
            {candidates.map((space) => <option key={space._id} value={space._id}>[{PLATFORM_LABEL[space.platform]}] {space.name}{space.handle ? ` @${space.handle}` : ""}</option>)}
          </select>
          <p id="publish-space-help" className="mt-1 text-xs text-stone-500">콘텐츠 채널과 일치하는 정상 상태의 계정만 표시됩니다.</p>
        </div>
        {!piece && selectedSpace?.platform === "INSTAGRAM" && <div>
          <label className="label" htmlFor="publish-channel">Instagram 게시 형식</label>
          <select id="publish-channel" className="input" value={directInstagramChannel} onChange={(e) => setDirectInstagramChannel(e.target.value as "INSTAGRAM_FEED" | "INSTAGRAM_REEL")}>
            <option value="INSTAGRAM_FEED">피드 이미지</option>
            <option value="INSTAGRAM_REEL">Reel 영상</option>
          </select>
          <p className="mt-1 text-xs text-stone-500">승인 내용에 결합되며 등록 후 자동으로 바뀌지 않습니다.</p>
        </div>}
        <div>
          <label className="label" htmlFor="publish-link">마케팅 링크 <span className="font-normal text-stone-400">(선택)</span></label>
          <select id="publish-link" className="input" value={effectiveLinkId} aria-describedby="publish-link-help" onChange={(e) => { setLinkId(e.target.value); setLinkSelectionTouched(true); }}>
            <option value="">없음</option>
            {matchingLinks.map((link) => <option key={link._id} value={link._id}>{link.product?.name ?? link.shortCode}{["MOCK", "DEMO"].includes((link as { origin?: string }).origin ?? "") ? " · 데모" : ""}</option>)}
          </select>
          <p id="publish-link-help" className={`mt-1 text-xs ${piece?.productId && links !== undefined && matchingLinks.length === 0 ? "text-amber-700" : "text-stone-500"}`}>{piece?.productId && links !== undefined && matchingLinks.length === 0 ? "이 상품의 활성 링크가 없습니다. 콘텐츠 제작실에서 먼저 발급하세요." : "선택한 콘텐츠 상품에 맞는 활성 링크만 표시됩니다."}</p>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="publish-text">본문</label>
          <textarea id="publish-text" className="input" rows={6} value={text} aria-describedby="publish-content-help" onChange={(e) => setTextOverride(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="publish-media">HTTPS 이미지·영상 URL</label>
          <input id="publish-media" className="input" value={media} inputMode="url" aria-invalid={mediaInputInvalid} aria-describedby={`publish-content-help publish-media-help${requiresVideo ? " publish-video-help" : ""}`} onChange={(e) => setMediaOverride(e.target.value)} placeholder="여러 개는 공백으로 구분" />
          <p id="publish-content-help" className="mt-1 text-xs text-stone-500">본문과 미디어 중 하나 이상이 필요하며, Instagram·TikTok은 미디어가 필수입니다.</p>
          <p id="publish-media-help" className="mt-1 text-xs text-stone-500">여러 URL은 공백으로 구분하세요.</p>
          {requiresVideo && <p id="publish-video-help" className="mt-1 text-xs font-medium text-amber-800">숏폼 게시에는 영상으로 확인 가능한 HTTPS URL(.mp4/.mov/.m4v/.webm)이 필요합니다. 미리 채워진 상품 이미지만으로는 진행할 수 없습니다.</p>}
        </div>
        <div className="sm:col-span-2">
          <label className="flex min-h-11 items-center gap-2 text-sm" htmlFor="publish-dry-run">
            <input id="publish-dry-run" type="checkbox" checked={dryRun} aria-describedby="publish-mode-description" onChange={(e) => setDryRun(e.target.checked)} />
            테스트 실행(실제 게시 안 함)
          </label>
        </div>
      </section>

      <aside id="publish-mode-description" className={`rounded-xl border p-4 text-sm ${dryRun ? "border-sky-200 bg-sky-50 text-sky-950" : "border-rose-200 bg-rose-50 text-rose-950"}`} role="status" aria-live="polite" aria-atomic="true">
        <strong>{dryRun ? "테스트 실행 · 실제 게시 없음" : "실제 게시 검토 · 승인 후 공개 가능"}</strong>
        <p className="mt-1">{dryRun ? "SNS 작성 단계와 연결 동작만 점검하며 실제 계정에는 게시하지 않습니다." : "작업 결과에서 최종 승인하면 선택한 SNS 계정에 공개될 수 있습니다. 승인 전에 계정·본문·미디어를 다시 확인하세요."}</p>
        {!dryRun && <p className="mt-2 font-medium">결과가 UNCERTAIN이면 자동 재시도하지 말고 SNS에서 실제 게시 여부를 먼저 확인하세요.</p>}
      </aside>

      <section className="card" aria-labelledby="publish-readiness-title">
        <h2 id="publish-readiness-title" className="font-semibold">게시 준비 확인</h2>
        <div id="publish-readiness" aria-live="polite">
          {issues.length > 0
            ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
            : <p className="mt-2 text-sm text-emerald-700">준비가 완료됐습니다. 등록 후 작업 결과 화면에서 최종 승인하세요.</p>}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn-primary" type="button" disabled={issues.length > 0} aria-describedby="publish-mode-description publish-readiness" onClick={submit}>{dryRun ? "테스트 게시 검토 등록" : "실제 게시 검토 등록"}</button>
          <Link className="btn-ghost" href="/dashboard/jobs">작업 결과 보기</Link>
        </div>
      </section>
    </div>
  );
}
