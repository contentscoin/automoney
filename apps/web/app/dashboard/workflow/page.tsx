"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
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
  { title: "상품 선택", description: "홍보할 상품을 최대 10개 선택" },
  { title: "링크 준비", description: "상품별 임시 마케팅 링크 발급" },
  { title: "AI 제작", description: "채널별 콘텐츠 초안 생성" },
  { title: "검토", description: "문구·미디어·품질 확인" },
  { title: "테스트 게시", description: "실제 게시 없이 동작 점검" },
] as const;

function linkOrigin(link: unknown): string | undefined {
  return (link as { origin?: string }).origin;
}

function isDemoLink(link: unknown): boolean {
  return ["MOCK", "DEMO"].includes(linkOrigin(link) ?? "");
}

export default function WorkflowPage() {
  const products = useQuery(api.products.search, { limit: 100 });
  const links = useQuery(api.links.listMine);
  const library = useQuery(api.content.listLibrary, { limit: 300 });
  const jobs = useQuery(api.jobs.listMine, { limit: 200 });
  const devices = useQuery(api.devices.listMine);
  const issueMany = useAction(api.links.issueMany);
  const requestGenerateBatch = useMutation(api.content.requestGenerateBatch);
  const approve = useMutation(api.content.approve);
  const reject = useMutation(api.content.reject);
  const edit = useMutation(api.content.edit);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [channels, setChannels] = useState<Channel[]>(["THREADS", "INSTAGRAM_FEED"]);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const selectedProducts = useMemo(() => {
    const selected = new Set(selectedIds);
    return (products ?? []).filter((product) => selected.has(product._id));
  }, [products, selectedIds]);
  const activeLinks = (links ?? []).filter((link) => link.status === "ACTIVE");
  const linkByProduct = new Map(activeLinks.filter((link) => link.product?._id).map((link) => [link.product!._id, link]));
  const missingLinkCount = selectedProducts.filter((product) => !linkByProduct.has(product._id)).length;
  const selectedPieces = (library ?? []).filter((piece) => piece.mine && piece.productId && selectedIds.includes(piece.productId));
  const selectedProductNumbers = new Set(selectedProducts.map((product) => product.attrangsProductId));
  const selectedJobs = (jobs ?? []).filter((job) => job.jobType === "content.generate" && job.contentProduct?.attrangsProductId && selectedProductNumbers.has(job.contentProduct.attrangsProductId));
  const activeDevice = devices?.find((device) => device.status === "ACTIVE");
  const deviceOnline = !!activeDevice?.online;
  const codexReady = !!(activeDevice?.snapshot as { codexLoggedIn?: boolean } | null | undefined)?.codexLoggedIn;
  const allLinksReady = selectedProducts.length > 0 && missingLinkCount === 0;
  const approvedCount = selectedPieces.filter((piece) => piece.status === "APPROVED").length;
  const currentStep = selectedProducts.length === 0 ? 1 : !allLinksReady ? 2 : selectedJobs.length === 0 && selectedPieces.length === 0 ? 3 : approvedCount === 0 ? 4 : 5;

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
    } catch (error) {
      setMsg(errorMessage(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">콘텐츠 제작실</h1>
          <p className="text-sm text-stone-500">상품 선택부터 링크, AI 초안, 검토, 테스트 게시까지 한 화면에서 진행합니다.</p>
        </div>
        <div className="flex gap-2"><Link className="btn-ghost" href="/dashboard/links">전체 링크</Link><Link className="btn-ghost" href="/dashboard/jobs">작업 결과</Link></div>
      </header>

      <ol className="grid gap-2 md:grid-cols-5" aria-label="콘텐츠 제작 단계">
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

      <section className="card">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="font-semibold">1. 상품 선택</h2><p className="text-sm text-stone-500">{selectedProducts.length}/10개 선택됨</p></div>
          <div className="flex gap-2"><button className="btn-ghost" type="button" onClick={() => setSelectedIds([])} disabled={selectedIds.length === 0}>선택 해제</button><button className="btn-primary" type="button" onClick={() => setSelectedIds((products ?? []).slice(0, 10).map((product) => product._id))} disabled={!products?.length}>최신 상품 10개 선택</button></div>
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
                <input className="mt-1 h-4 w-4 shrink-0 accent-orange-700" type="checkbox" checked={selected} onChange={() => toggleProduct(product._id)} />
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
          <div><h2 className="font-semibold">2. 마케팅 링크 준비</h2><p className="text-sm text-stone-500">선택 상품 {selectedProducts.length}개 중 {selectedProducts.length - missingLinkCount}개 준비 · {missingLinkCount}개 필요</p></div>
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
          <div><h2 className="font-semibold">3. AI 콘텐츠 제작</h2><p className="text-sm text-stone-500">선택 상품마다 선택한 채널의 초안을 만듭니다.</p></div>
          <div className="text-right text-xs"><p className={deviceOnline ? "text-emerald-700" : "text-amber-800"}>{deviceOnline ? `${activeDevice?.name ?? "PC 앱"} 온라인` : "PC 앱 오프라인"}</p><p className={codexReady ? "text-emerald-700" : "text-stone-600"}>{codexReady ? "Codex 로그인 확인" : "Codex 미준비 시 템플릿으로 대체"}</p></div>
        </div>
        {!deviceOnline && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">AI 생성 요청을 보내려면 PC 앱이 온라인이어야 합니다. <Link className="font-medium underline" href="/dashboard/connections">연결 관리 열기</Link></p>}
        <fieldset className="mt-4">
          <legend className="label">제작 채널</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {CHANNEL_ORDER.map((channel) => <label key={channel} className="flex min-h-11 items-center gap-2 rounded-lg border border-stone-200 px-3"><input type="checkbox" checked={channels.includes(channel)} onChange={() => toggleChannel(channel)} />{CHANNEL_LABEL[channel]}</label>)}
          </div>
        </fieldset>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" type="button" disabled={busy !== null || !deviceOnline || !allLinksReady || channels.length === 0} onClick={async () => {
            setBusy("generate");
            try {
              const result = await requestGenerateBatch({ productIds: selectedProducts.map((product) => product._id as Id<"products">), channels });
              setMsg(`상품 ${result.total}개의 콘텐츠 생성 작업을 등록했습니다. PC 앱 처리 후 검토 목록에 자동으로 나타납니다.`);
            } catch (error) {
              setMsg(errorMessage(error));
            } finally {
              setBusy(null);
            }
          }}>{busy === "generate" ? "생성 요청 중…" : `선택 상품 ${selectedProducts.length}개 AI 초안 생성`}</button>
          {!allLinksReady && selectedProducts.length > 0 && <span className="text-xs text-amber-800">먼저 모든 상품의 링크를 준비하세요.</span>}
          <Link className="text-sm underline" href="/dashboard/jobs">실시간 작업 보기</Link>
        </div>
        {selectedJobs.length > 0 && <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="선택 상품 콘텐츠 생성 작업">{selectedJobs.slice(0, selectedProducts.length).map((job) => <li key={job._id} className="flex items-center justify-between gap-2 rounded-lg bg-stone-50 p-2 text-xs"><span className="min-w-0 truncate">{job.contentProduct?.name ?? "상품 콘텐츠"}</span><span className="flex shrink-0 items-center gap-2"><Badge value={JOB_STATUS_TONE[job.status] ?? "PENDING"} label={JOB_STATUS_LABEL[job.status] ?? job.status} /><time dateTime={new Date(job.createdAt).toISOString()}>{dateTime(job.createdAt)}</time></span></li>)}</ul>}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-semibold">4. 콘텐츠 검토</h2><p className="text-sm text-stone-500">선택 상품의 내 콘텐츠 {selectedPieces.length}개 · 승인 {approvedCount}개</p></div><Link className="btn-ghost" href="/dashboard/content/mine">내 콘텐츠 전체 보기</Link></div>
        {selectedIds.length === 0 && <div className="card text-sm text-stone-500">상품을 선택하면 관련 콘텐츠가 여기에 모입니다.</div>}
        {selectedIds.length > 0 && library !== undefined && selectedPieces.length === 0 && <div className="card text-sm text-stone-500">아직 생성된 콘텐츠가 없습니다. AI 제작을 요청하고 작업이 완료될 때까지 기다리세요.</div>}
        <div className="grid gap-3 lg:grid-cols-2">
          {selectedPieces.map((piece) => {
            const link = piece.productId ? linkByProduct.get(piece.productId) : undefined;
            const publishHref = `/dashboard/publish?piece=${piece._id}${link ? `&link=${link._id}` : ""}&dryRun=1`;
            return <PieceCard key={piece._id} p={piece} publishHref={publishHref} onApprove={() => runPieceAction(() => approve({ pieceId: piece._id }), "콘텐츠를 승인했습니다.")} onReject={(reason) => runPieceAction(() => reject({ pieceId: piece._id, reason }), "콘텐츠를 폐기했습니다.")} onEdit={(value) => runPieceAction(() => edit({ pieceId: piece._id, ...value }), "콘텐츠를 수정하고 품질을 다시 확인했습니다.")} />;
          })}
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold">5. 테스트 게시</h2>
        <p className="mt-1 text-sm text-stone-600">승인된 콘텐츠의 <strong>이 콘텐츠로 게시</strong>를 누르면 상품 링크가 자동 선택되고 테스트 실행이 켜진 게시 화면으로 이동합니다. 테스트 실행은 작성 화면까지만 확인하며 실제 SNS에는 게시하지 않습니다.</p>
        <div className="mt-4 flex flex-wrap gap-2"><Link className="btn-primary" href="/dashboard/publish?dryRun=1">테스트 게시 준비</Link><Link className="btn-ghost" href="/dashboard/schedules">예약 관리</Link></div>
      </section>
    </div>
  );
}
