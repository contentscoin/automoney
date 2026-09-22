"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  DEFAULT_CONTENT_STANDARD,
  normalizeContentBrief,
  type ContentCta,
  type ContentGoal,
  type ContentProductionBrief,
  type ContentProductionStandard,
  type ContentTone,
} from "@automoney/shared";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { PieceCard } from "@/components/PieceCard";
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from "@/lib/agent-format";
import { CHANNEL_LABEL, CHANNEL_ORDER } from "@/lib/content-format";
import { dateTime, errorMessage, won } from "@/lib/format";

type Channel = (typeof CHANNEL_ORDER)[number];
type BusyAction = "links" | "generate" | null;

const STEPS = [
  { title: "제작 기준", description: "목표·톤·CTA·대상 고정" },
  { title: "상품 선택", description: "홍보할 상품을 최대 10개 선택" },
  { title: "링크 준비", description: "상품별 임시 마케팅 링크 발급" },
  { title: "AI 제작", description: "채널별 콘텐츠 초안 생성" },
  { title: "검토", description: "문구·미디어·품질 확인" },
  { title: "테스트 게시", description: "실제 게시 없이 동작 점검" },
] as const;

const GOAL_LABEL: Record<ContentGoal, string> = { DISCOVERY: "상품 발견", ENGAGEMENT: "반응 유도", CONVERSION: "상품 링크 전환" };
const TONE_LABEL: Record<ContentTone, string> = { CHANNEL_NATIVE: "채널에 자연스럽게", POLITE: "정중한 존댓말", CASUAL: "친근한 말투" };
const CTA_LABEL: Record<ContentCta, string> = { COMMENT: "댓글 유도", SAVE: "저장 유도", LINK: "상품 링크 확인" };
const RUN_STATUS_LABEL: Record<string, string> = { QUEUED: "대기", RUNNING: "제작 중", COMPLETED: "검토·승인 완료", REVIEW_REQUIRED: "재검토 필요", FAILED: "실패" };
const RUN_STATUS_TONE: Record<string, string> = { QUEUED: "PENDING", RUNNING: "PENDING", COMPLETED: "ACTIVE", REVIEW_REQUIRED: "PENDING", FAILED: "REJECTED" };

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function linkOrigin(link: unknown): string | undefined {
  return (link as { origin?: string }).origin;
}

function isDemoLink(link: unknown): boolean {
  return ["MOCK", "DEMO"].includes(linkOrigin(link) ?? "");
}

function passedFrozenStandard(piece: unknown): boolean {
  return (piece as { status?: string; productionMeta?: { standardPassed?: boolean } | null }).status === "APPROVED"
    && (piece as { productionMeta?: { standardPassed?: boolean } | null }).productionMeta?.standardPassed === true;
}

export default function WorkflowPage() {
  const products = useQuery(api.products.search, { limit: 100 });
  const links = useQuery(api.links.listMine);
  const jobs = useQuery(api.jobs.listMine, { limit: 200 });
  const devices = useQuery(api.devices.listMine);
  const runs = useQuery(api.content.listRuns, { limit: 12 });
  const issueMany = useAction(api.links.issueMany);
  const requestGenerateBatch = useMutation(api.content.requestGenerateBatch);
  const approve = useMutation(api.content.approve);
  const reject = useMutation(api.content.reject);
  const edit = useMutation(api.content.edit);

  const [draftSelectedIds, setSelectedIds] = useState<string[]>([]);
  const [draftChannels, setChannels] = useState<Channel[]>(["THREADS", "INSTAGRAM_FEED"]);
  const [draftBrief, setBrief] = useState<ContentProductionBrief>(() => normalizeContentBrief());
  const [draftStandard, setDraftStandard] = useState<ContentProductionStandard>(() => DEFAULT_CONTENT_STANDARD);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const activeRunId = selectedRunId ?? runs?.[0]?._id ?? "";
  const activeRun = useQuery(api.content.getRun, activeRunId ? { runId: activeRunId as Id<"contentRuns"> } : "skip");
  const runPieces = useQuery(api.content.listRunPieces, activeRunId ? { runId: activeRunId as Id<"contentRuns"> } : "skip");
  const library = useQuery(api.content.listLibrary, activeRunId ? "skip" : { limit: 300 });
  const selectedIds = useMemo(() => activeRun ? [...activeRun.productIds] : draftSelectedIds, [activeRun, draftSelectedIds]);
  const channels = useMemo(() => activeRun ? [...activeRun.channels] : draftChannels, [activeRun, draftChannels]);
  const brief = useMemo(() => activeRun ? normalizeContentBrief(activeRun.briefSnapshot) : draftBrief, [activeRun, draftBrief]);
  const displayedStandard = activeRun?.standardSnapshot ?? draftStandard;

  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
  };

  const startNewRun = () => {
    selectRun("");
    setSelectedIds([]);
    setChannels(["THREADS", "INSTAGRAM_FEED"]);
    setBrief(normalizeContentBrief());
    setDraftStandard(DEFAULT_CONTENT_STANDARD);
    setMsg("새 제작을 시작합니다. 제작 기준과 상품을 확인하세요.");
  };

  const repeatActiveRun = () => {
    if (!activeRun) return;
    const previousBrief = normalizeContentBrief(activeRun.briefSnapshot);
    const previousProducts = [...activeRun.productIds];
    const previousChannels = [...activeRun.channels];
    selectRun("");
    setSelectedIds(previousProducts);
    setChannels(previousChannels);
    setBrief(previousBrief);
    setDraftStandard(activeRun.standardSnapshot as ContentProductionStandard);
    setMsg("이전 실행의 제작 기준·상품·채널·브리프를 복사했습니다. 연결 상태를 확인한 뒤 새 실행으로 생성하세요.");
  };

  const selectedProducts = useMemo(() => {
    const selected = new Set(selectedIds);
    return (products ?? []).filter((product) => selected.has(product._id));
  }, [products, selectedIds]);
  const activeLinks = (links ?? []).filter((link) => link.status === "ACTIVE");
  const linkByProduct = new Map(activeLinks.filter((link) => link.product?._id).map((link) => [link.product!._id, link]));
  const missingLinkCount = selectedProducts.filter((product) => !linkByProduct.has(product._id)).length;
  const selectedPieceSource = activeRunId ? runPieces : library;
  const selectedPieces = (selectedPieceSource ?? []).filter((piece) => {
    if (!piece.mine) return false;
    if (activeRunId) return true;
    return !!piece.productId && selectedIds.includes(piece.productId);
  });
  const runJobIds = new Set(activeRun?.jobIds ?? []);
  const selectedJobs = (jobs ?? []).filter((job) => runJobIds.has(job._id));
  const activeDevice = devices?.find((device) => device.status === "ACTIVE");
  const deviceOnline = !!activeDevice?.online;
  const codexReady = !!(activeDevice?.snapshot as { codexLoggedIn?: boolean } | null | undefined)?.codexLoggedIn;
  const allLinksReady = selectedProducts.length > 0 && missingLinkCount === 0;
  const approvedCount = selectedPieces.filter((piece) => activeRunId ? passedFrozenStandard(piece) : piece.status === "APPROVED").length;
  const expectedOutputs = activeRun?.expectedOutputs ?? 0;
  const createdOutputs = activeRun?.savedOutputs ?? selectedPieces.length;
  const passedOutputs = activeRun?.approvedOutputs ?? approvedCount;
  const draftOutputs = Math.max(0, createdOutputs - passedOutputs);
  const failedJobs = selectedJobs.filter((job) => job.status === "FAILED").length;
  const completedJobs = activeRun?.completedJobs ?? selectedJobs.filter((job) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)).length;
  const jobProgress = activeRun?.jobIds.length
    ? Math.round(selectedJobs.reduce((total, job) => total + (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status) ? 100 : job.progress ?? 0), 0) / activeRun.jobIds.length)
    : 0;
  const runProgress = activeRun && ["QUEUED", "RUNNING"].includes(activeRun.status)
    ? jobProgress
    : expectedOutputs > 0
      ? percent(createdOutputs, expectedOutputs)
      : percent(completedJobs, activeRun?.jobIds.length ?? 0);
  const runReadyToPublish = !!activeRun && activeRun.status === "COMPLETED" && expectedOutputs > 0 && passedOutputs === expectedOutputs;
  const currentStep = selectedProducts.length === 0
    ? 2
    : !allLinksReady
      ? 3
      : !activeRun || ["QUEUED", "RUNNING", "FAILED"].includes(activeRun.status)
        ? 4
        : activeRun.status === "REVIEW_REQUIRED" || passedOutputs < expectedOutputs
          ? 5
          : 6;

  const toggleProduct = (productId: string) => {
    setMsg(null);
    setSelectedIds((current) => {
      if (current.includes(productId)) return current.filter((id) => id !== productId);
      if (current.length >= 10) {
        setMsg("상품은 한 번에 최대 10개까지 선택할 수 있습니다.");
        return current;
      }
      return [...current, productId];
    });
  };

  const toggleChannel = (channel: Channel) => {
    setChannels((current) => current.includes(channel) ? current.filter((item) => item !== channel) : [...current, channel]);
  };

  const runPieceAction = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      setMsg(success);
      return true;
    } catch (error) {
      setMsg(errorMessage(error));
      return false;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">콘텐츠 제작실</h1>
          <p className="text-sm text-stone-500">버전이 고정된 제작 기준으로 상품 선택부터 검토와 테스트 게시까지 진행합니다.</p>
        </div>
        <div className="flex flex-wrap gap-2"><button className="btn-primary" type="button" onClick={startNewRun}>새 제작 시작</button><Link className="btn-ghost" href="/dashboard/links">전체 링크</Link><Link className="btn-ghost" href="/dashboard/jobs">작업 결과</Link></div>
      </header>

      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" aria-label="콘텐츠 제작 단계">
        {STEPS.map((step, index) => {
          const number = index + 1;
          const done = number < currentStep;
          const current = number === currentStep;
          return (
            <li key={step.title} className={`rounded-xl border p-3 ${current ? "border-orange-300 bg-orange-50" : done ? "border-emerald-200 bg-emerald-50" : "border-stone-200 bg-white"}`} aria-current={current ? "step" : undefined}>
              <div className="flex items-center gap-2"><span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${current ? "bg-orange-700 text-white" : done ? "bg-emerald-700 text-white" : "bg-stone-100 text-stone-600"}`}>{done ? "✓" : number}</span><strong className="text-sm">{step.title}</strong></div>
              <p className="mt-1 text-xs text-stone-600">{step.description}</p>
            </li>
          );
        })}
      </ol>

      <aside className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <strong>아뜨랑스 데모 운영 안내</strong>
        <p className="mt-1">MOCK·DEMO로 표시된 링크는 제작 흐름 확인용 임시 링크로 실제 제휴 수익을 추적하지 않습니다. 이 화면의 게시 이동은 기본적으로 테스트 실행을 켜며, 최종 등록 전에도 실제 게시 여부를 다시 확인할 수 있습니다.</p>
      </aside>

      {msg && <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-800" role="status" aria-live="polite">{msg}</p>}

      <section className="card" aria-labelledby="production-standard-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="production-standard-title" className="font-semibold">1. 제작 기준</h2>
            <p className="text-sm text-stone-500">실행을 시작하면 아래 기준과 브리프가 복사되어 결과와 함께 보존됩니다.</p>
          </div>
          <div className="min-w-56">
            <label className="label" htmlFor="content-run">최근 제작 실행</label>
            <select id="content-run" className="input py-1.5 text-sm" value={activeRunId} onChange={(event) => event.target.value ? selectRun(event.target.value) : startNewRun()}>
              <option value="">새 제작</option>
              {runs?.map((run) => <option key={run._id} value={run._id}>{dateTime(run.createdAt)} · {RUN_STATUS_LABEL[run.status] ?? run.status}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-sm">{displayedStandard.name}</strong>
            <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-orange-800">v{displayedStandard.version}</span>
            <span className="text-xs text-stone-600">품질 정책 {displayedStandard.qualityVersion}</span>
          </div>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
            <div><dt className="text-xs text-stone-500">생성기</dt><dd className="font-medium">{displayedStandard.requireCodex ? "Codex 필수" : "템플릿 대체 허용"}</dd></div>
            <div><dt className="text-xs text-stone-500">통과 점수</dt><dd className="font-medium">{displayedStandard.minScore}점 이상</dd></div>
            <div><dt className="text-xs text-stone-500">품질 시도</dt><dd className="font-medium">최대 {displayedStandard.maxAttempts}회</dd></div>
            <div><dt className="text-xs text-stone-500">표현 규칙</dt><dd className="font-medium">이모지 {displayedStandard.maxEmoji}개 이하</dd></div>
            <div><dt className="text-xs text-stone-500">사실 근거</dt><dd className="font-medium">카탈로그 사실만</dd></div>
          </dl>
          <details className="mt-3 text-xs text-stone-600"><summary className="cursor-pointer font-medium">금지 표현과 버전 정보 보기</summary><p className="mt-2">금지 표현: {displayedStandard.forbiddenPhrases.join(", ")}</p><p className="mt-1 break-words">워크플로 {displayedStandard.workflowVersion} · 프롬프트 {displayedStandard.promptVersion}</p></details>
        </div>

        {activeRunId && <p className="mt-3 rounded-lg bg-stone-50 p-3 text-sm text-stone-700">선택한 실행의 기준은 변경할 수 없습니다. 다른 목표나 메시지로 만들려면 <button className="font-medium underline" type="button" onClick={startNewRun}>새 제작을 시작하세요.</button></p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div><label className="label" htmlFor="brief-goal">제작 목표</label><select id="brief-goal" className="input" disabled={!!activeRunId} value={brief.goal} onChange={(event) => setBrief({ ...brief, goal: event.target.value as ContentGoal })}>{(Object.keys(GOAL_LABEL) as ContentGoal[]).map((value) => <option key={value} value={value}>{GOAL_LABEL[value]}</option>)}</select></div>
          <div><label className="label" htmlFor="brief-tone">말투</label><select id="brief-tone" className="input" disabled={!!activeRunId} value={brief.tone} onChange={(event) => setBrief({ ...brief, tone: event.target.value as ContentTone })}>{(Object.keys(TONE_LABEL) as ContentTone[]).map((value) => <option key={value} value={value}>{TONE_LABEL[value]}</option>)}</select></div>
          <div><label className="label" htmlFor="brief-cta">CTA</label><select id="brief-cta" className="input" disabled={!!activeRunId} value={brief.cta} onChange={(event) => setBrief({ ...brief, cta: event.target.value as ContentCta })}>{(Object.keys(CTA_LABEL) as ContentCta[]).map((value) => <option key={value} value={value}>{CTA_LABEL[value]}</option>)}</select></div>
          <div className="sm:col-span-3"><label className="label" htmlFor="brief-audience">대상 고객</label><input id="brief-audience" className="input" disabled={!!activeRunId} maxLength={200} value={brief.audience} onChange={(event) => setBrief({ ...brief, audience: event.target.value })} /></div>
          <div className="sm:col-span-3"><label className="label" htmlFor="brief-message">핵심 메시지 <span className="font-normal text-stone-400">(선택)</span></label><textarea id="brief-message" className="input" disabled={!!activeRunId} rows={3} maxLength={300} value={brief.keyMessage ?? ""} onChange={(event) => setBrief({ ...brief, keyMessage: event.target.value })} placeholder="이번 콘텐츠에서 강조할 근거 있는 메시지를 입력하세요. 입력하지 않으면 상품 카탈로그만 사용합니다." /><p className="mt-1 text-xs text-stone-500">카탈로그에서 확인할 수 없는 배송·교환·순위·직접 착용 경험은 입력하지 마세요.</p></div>
        </div>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="font-semibold">2. 상품 선택</h2><p className="text-sm text-stone-500">{selectedProducts.length}/10개 선택됨</p></div>
          <div className="flex gap-2"><button className="btn-ghost" type="button" onClick={() => setSelectedIds([])} disabled={!!activeRunId || selectedIds.length === 0}>선택 해제</button><button className="btn-primary" type="button" onClick={() => setSelectedIds((products ?? []).slice(0, 10).map((product) => product._id))} disabled={!!activeRunId || !products?.length}>최신 상품 10개 선택</button></div>
        </div>
        {products === undefined && <p className="mt-4 text-sm text-stone-500">상품을 불러오는 중…</p>}
        {products?.length === 0 && <p className="mt-4 text-sm text-stone-500">등록된 상품이 없습니다. 운영자가 상품 CSV를 가져오면 여기에 표시됩니다.</p>}
        <fieldset className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <legend className="sr-only">콘텐츠를 만들 상품</legend>
          {products?.map((product) => {
            const selected = selectedIds.includes(product._id);
            const link = linkByProduct.get(product._id);
            const productJob = selectedJobs.find((job) => job.contentProduct?.attrangsProductId === product.attrangsProductId);
            return (
              <label key={product._id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${selected ? "border-orange-300 bg-orange-50" : "border-stone-200 bg-white hover:border-stone-300"}`}>
                <input className="mt-1 h-4 w-4 shrink-0 accent-orange-700" type="checkbox" checked={selected} disabled={!!activeRunId} onChange={() => toggleProduct(product._id)} />
                {product.imageUrls[0] ? <Image src={product.imageUrls[0]} alt={`${product.name} 상품 이미지`} width={80} height={100} unoptimized className="h-24 w-20 shrink-0 rounded-lg bg-stone-100 object-cover" /> : <span className="h-24 w-20 shrink-0 rounded-lg bg-stone-100" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm font-medium">{product.name}</span>
                  <span className="mt-1 block text-xs text-stone-500">{product.category ?? "카테고리 미지정"} · {won(product.salePrice ?? product.price)}</span>
                  <span className={`mt-2 block text-xs font-medium ${link ? isDemoLink(link) ? "text-amber-800" : "text-emerald-700" : "text-stone-500"}`}>{link ? isDemoLink(link) ? "데모 링크 준비됨 · 수익 추적 안 됨" : "마케팅 링크 준비됨" : "링크 미발급"}</span>
                  {productJob && <span className="mt-1 flex items-center gap-1 text-xs"><Badge value={JOB_STATUS_TONE[productJob.status] ?? "PENDING"} label={JOB_STATUS_LABEL[productJob.status] ?? productJob.status} /> 콘텐츠 작업</span>}
                  <a className="mt-2 inline-block text-xs underline" href={product.detailUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>아뜨랑스 상품 보기<span className="sr-only">: {product.name}</span></a>
                </span>
              </label>
            );
          })}
        </fieldset>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold">3. 마케팅 링크 준비</h2><p className="text-sm text-stone-500">선택 상품 {selectedProducts.length}개 중 {selectedProducts.length - missingLinkCount}개 준비 · {missingLinkCount}개 필요</p></div>
          <button className="btn-primary" type="button" disabled={busy !== null || selectedProducts.length === 0 || missingLinkCount === 0} onClick={async () => {
            setBusy("links");
            try {
              const result = await issueMany({ productIds: selectedProducts.map((product) => product._id as Id<"products">) });
              setMsg(`마케팅 링크 ${result.total}개를 확인했습니다. 새 발급 ${result.issued}개, 기존 ${result.existed}개${result.reactivated ? `, 재활성화 ${result.reactivated}개` : ""}입니다.`);
            } catch (error) {
              setMsg(errorMessage(error));
            } finally {
              setBusy(null);
            }
          }}>{busy === "links" ? "링크 준비 중…" : missingLinkCount === 0 && selectedProducts.length > 0 ? "링크 준비 완료" : "선택 상품 링크 일괄 발급"}</button>
        </div>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-semibold">4. AI 콘텐츠 제작</h2><p className="text-sm text-stone-500">선택 상품마다 같은 기준과 브리프의 채널별 초안을 만듭니다.</p></div>
          <div className="text-right text-xs"><p className={deviceOnline ? "text-emerald-700" : "text-amber-800"}>{deviceOnline ? `${activeDevice?.name ?? "PC 앱"} 온라인` : "PC 앱 오프라인"}</p><p className={codexReady ? "text-emerald-700" : "text-amber-800"}>{codexReady ? "Codex 로그인 확인" : "Codex 로그인이 필요합니다"}</p></div>
        </div>
        {!deviceOnline && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">AI 생성 요청을 보내려면 PC 앱이 온라인이어야 합니다. <Link className="font-medium underline" href="/dashboard/connections">연결 관리 열기</Link></p>}
        {deviceOnline && displayedStandard.requireCodex && !codexReady && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">이 제작 기준은 템플릿 대체를 허용하지 않습니다. <Link className="font-medium underline" href="/dashboard/connections#ai">AI 연결에서 Codex 로그인을 확인하세요.</Link></p>}
        <fieldset className="mt-4">
          <legend className="label">제작 채널</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {CHANNEL_ORDER.map((channel) => <label key={channel} className="flex min-h-11 items-center gap-2 rounded-lg border border-stone-200 px-3"><input type="checkbox" checked={channels.includes(channel)} disabled={!!activeRunId} onChange={() => toggleChannel(channel)} />{CHANNEL_LABEL[channel]}</label>)}
          </div>
        </fieldset>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" type="button" disabled={busy !== null || !!activeRunId || !deviceOnline || (DEFAULT_CONTENT_STANDARD.requireCodex && !codexReady) || !allLinksReady || channels.length === 0 || !brief.audience.trim()} onClick={async () => {
            setBusy("generate");
            try {
              const result = await requestGenerateBatch({
                productIds: selectedProducts.map((product) => product._id as Id<"products">),
                channels,
                brief: normalizeContentBrief(brief),
                standard: draftStandard,
                clientRequestId: crypto.randomUUID(),
              });
              selectRun(result.runId);
              setMsg(`상품 ${result.total}개의 제작 실행을 등록했습니다. 실행별 진행률과 품질 통과 수를 아래에서 확인하세요.`);
            } catch (error) {
              setMsg(errorMessage(error));
            } finally {
              setBusy(null);
            }
          }}>{busy === "generate" ? "제작 실행 등록 중…" : activeRunId ? "새 제작에서 생성 가능" : `선택 상품 ${selectedProducts.length}개 기준 고정 후 생성`}</button>
          {!allLinksReady && selectedProducts.length > 0 && <span className="text-xs text-amber-800">먼저 모든 상품의 링크를 준비하세요.</span>}
          <Link className="text-sm underline" href="/dashboard/jobs">실시간 작업 보기</Link>
        </div>
        {activeRun && (
          <div className="mt-5 rounded-xl border border-stone-200 p-4" aria-labelledby="run-progress-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2"><h3 id="run-progress-title" className="text-sm font-semibold">현재 제작 실행</h3><Badge value={RUN_STATUS_TONE[activeRun.status] ?? "PENDING"} label={RUN_STATUS_LABEL[activeRun.status] ?? activeRun.status} /></div>
              <time className="text-xs text-stone-500" dateTime={new Date(activeRun.createdAt).toISOString()}>{dateTime(activeRun.createdAt)}</time>
            </div>
            <div className={`mt-3 rounded-lg border p-3 text-sm ${activeRun.status === "COMPLETED" ? "border-emerald-200 bg-emerald-50 text-emerald-950" : activeRun.status === "FAILED" ? "border-rose-200 bg-rose-50 text-rose-950" : activeRun.status === "REVIEW_REQUIRED" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-stone-200 bg-stone-50 text-stone-700"}`} role="status" aria-live="polite">
              {activeRun.status === "COMPLETED" && <p><strong>검토와 사람 승인이 완료됐습니다.</strong> 아직 SNS에 게시된 상태는 아니며, 먼저 테스트 게시로 연결을 확인할 수 있습니다.</p>}
              {activeRun.status === "REVIEW_REQUIRED" && <p><strong>제작은 끝났지만 재검토가 필요합니다.</strong> 자동 기준 미통과 또는 사람 미승인 결과가 있어 현재 실행으로는 게시할 수 없습니다. 아래 카드에서 수정·승인을 완료하세요.</p>}
              {activeRun.status === "FAILED" && <p><strong>제작 실행에 실패했습니다.</strong> 성공 결과와 실패 결과를 구분해 확인하고, 원인을 해결한 뒤 같은 기준으로 새 실행을 준비하세요.</p>}
              {["QUEUED", "RUNNING"].includes(activeRun.status) && <p><strong>아직 게시 준비 상태가 아닙니다.</strong> 모든 결과의 자동 기준 검사와 사람 승인이 끝날 때까지 기다리세요.</p>}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <div className="rounded-lg bg-stone-50 p-2"><span className="block text-xs text-stone-500">예상 결과</span><strong className="tabular-nums">{expectedOutputs}</strong></div>
              <div className="rounded-lg bg-stone-50 p-2"><span className="block text-xs text-stone-500">생성</span><strong className="tabular-nums">{createdOutputs}</strong></div>
              <div className="rounded-lg bg-emerald-50 p-2"><span className="block text-xs text-emerald-700">기준 통과</span><strong className="tabular-nums text-emerald-800">{passedOutputs}</strong></div>
              <div className="rounded-lg bg-amber-50 p-2"><span className="block text-xs text-amber-700">검토 필요</span><strong className="tabular-nums text-amber-800">{draftOutputs}</strong></div>
              <div className="rounded-lg bg-rose-50 p-2"><span className="block text-xs text-rose-700">실패 작업</span><strong className="tabular-nums text-rose-800">{failedJobs}</strong></div>
            </div>
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-xs text-stone-600"><span>제작 진행률</span><span className="tabular-nums">{runProgress}%</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-label="콘텐츠 제작 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={runProgress}><div className="h-full rounded-full bg-orange-600 transition-[width]" style={{ width: `${runProgress}%` }} /></div>
            </div>
            <ul className="mt-4 grid gap-2" aria-label="상품별 제작 진행 상태">
              {activeRun.productIds.map((productId, index) => {
                const product = products?.find((item) => item._id === productId);
                const link = linkByProduct.get(productId);
                const job = selectedJobs.find((item) => item._id === activeRun.jobIds[index]);
                const pieces = selectedPieces.filter((piece) => piece.productId === productId);
                const passed = pieces.filter(passedFrozenStandard).length;
                return (
                  <li key={productId} className="grid gap-2 rounded-lg bg-stone-50 p-3 text-xs sm:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr] sm:items-center">
                    <div className="min-w-0"><strong className="block truncate text-sm">{product?.name ?? `상품 ${index + 1}`}</strong><span className="text-stone-500">{pieces.map((piece) => CHANNEL_LABEL[piece.channel] ?? piece.channel).join(" · ") || "결과 대기"}</span></div>
                    <div><span className="mr-1 text-stone-500">링크</span><span className={link ? isDemoLink(link) ? "text-amber-800" : "text-emerald-700" : "text-rose-700"}>{link ? isDemoLink(link) ? "데모" : "활성" : "없음"}</span></div>
                    <div className="flex items-center gap-1"><span className="text-stone-500">생성</span>{job ? <Badge value={JOB_STATUS_TONE[job.status] ?? "PENDING"} label={JOB_STATUS_LABEL[job.status] ?? job.status} /> : <span>대기</span>}</div>
                    <div><span className="mr-1 text-stone-500">품질</span><strong className={passed === activeRun.channels.length ? "text-emerald-700" : "text-amber-800"}>{passed}/{activeRun.channels.length} 통과</strong>{job?.errorMessage && <span className="mt-1 block text-rose-700">{job.errorMessage}</span>}</div>
                  </li>
                );
              })}
            </ul>
            {(failedJobs > 0 || activeRun.status === "REVIEW_REQUIRED") && <div className={`mt-3 flex flex-wrap items-center gap-2 text-sm ${failedJobs > 0 ? "text-rose-700" : "text-amber-800"}`}><p>{failedJobs > 0 ? "실패 작업은 성공 결과와 분리되어 있습니다." : "고정 제작 기준을 통과하지 못한 결과가 있어 재검토가 필요합니다."} <Link className="font-medium underline" href="/dashboard/jobs">작업 결과에서 원인을 확인하세요.</Link></p><button className="btn-ghost" type="button" onClick={repeatActiveRun}>같은 기준으로 재시도 준비</button></div>}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-semibold">5. 콘텐츠 검토</h2><p className="text-sm text-stone-500">현재 실행 결과 {selectedPieces.length}/{expectedOutputs || selectedProducts.length * channels.length}개 · 기준 통과 {approvedCount}개</p></div><Link className="btn-ghost" href="/dashboard/content/mine">내 콘텐츠 전체 보기</Link></div>
        {selectedIds.length === 0 && <div className="card text-sm text-stone-500">상품을 선택하면 관련 콘텐츠가 여기에 모입니다.</div>}
        {selectedIds.length > 0 && selectedPieceSource !== undefined && selectedPieces.length === 0 && <div className="card text-sm text-stone-500">아직 생성된 콘텐츠가 없습니다. AI 제작을 요청하고 작업이 완료될 때까지 기다리세요.</div>}
        <div className="grid gap-3 lg:grid-cols-2">
          {selectedPieces.map((piece) => {
            const link = piece.productId ? linkByProduct.get(piece.productId) : undefined;
            const publishHref = `/dashboard/publish?piece=${piece._id}${link ? `&link=${link._id}` : ""}&dryRun=1`;
            return <PieceCard key={piece._id} p={piece} publishHref={publishHref} publishingDisabledReason={activeRun && !runReadyToPublish ? "현재 실행의 전체 결과 검토가 끝나지 않았습니다" : undefined} onApprove={(reviewChecklist) => runPieceAction(() => approve({ pieceId: piece._id, ...(piece.productionMeta?.outputHash ? { expectedOutputHash: piece.productionMeta.outputHash } : {}), reviewChecklist }), "콘텐츠를 승인했습니다.")} onReject={(reason) => runPieceAction(() => reject({ pieceId: piece._id, reason }), "콘텐츠를 폐기했습니다.")} onEdit={(value) => runPieceAction(() => edit({ pieceId: piece._id, ...value }), "콘텐츠를 수정하고 품질을 다시 확인했습니다.")} />;
          })}
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold">6. 테스트 게시</h2>
        <p className="mt-1 text-sm text-stone-600">승인된 콘텐츠의 <strong>이 콘텐츠로 게시</strong>를 누르면 상품 링크가 자동 선택되고 테스트 실행이 켜진 게시 화면으로 이동합니다. 테스트 실행은 작성 화면까지만 확인하며 실제 SNS에는 게시하지 않습니다.</p>
        {!runReadyToPublish && <p className="mt-3 text-sm text-amber-800">현재 실행의 예상 결과가 모두 생성되고 제작 기준을 통과해야 테스트 게시를 준비할 수 있습니다.</p>}
        <div className="mt-4 flex flex-wrap gap-2">{runReadyToPublish ? <Link className="btn-primary" href="/dashboard/publish?dryRun=1">테스트 게시 준비</Link> : <span className="btn-primary cursor-not-allowed opacity-50" aria-disabled="true">테스트 게시 준비</span>}<Link className="btn-ghost" href="/dashboard/schedules">예약 관리</Link></div>
      </section>
    </div>
  );
}
