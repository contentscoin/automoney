"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage } from "@/lib/format";
import { JOB_STATUS_LABEL, JOB_STATUS_TONE, JOB_TYPE_LABEL } from "@/lib/agent-format";
import { CHANNEL_LABEL } from "@/lib/content-format";

type JobResult = {
  summary?: string;
  warnings?: string[];
  data?: {
    dryRun?: boolean;
    postUrl?: string;
    generatedBy?: string;
  };
};

export default function JobsPage() {
  const jobs = useQuery(api.jobs.listMine, { limit: 100 });
  const approve = useMutation(api.jobs.approve);
  const cancel = useMutation(api.jobs.cancel);
  const resolveUncertainPublish = useMutation(api.jobs.resolveUncertainPublish);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); setMsg(success); }
    catch (e) { setMsg(errorMessage(e)); }
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-bold">작업 결과</h1><p className="text-sm text-stone-500">승인 대기, 실행 단계, 실패 원인과 게시 결과를 확인합니다.</p></div><Link className="btn-primary" href="/dashboard/publish">새 게시 준비</Link></div>
      {msg && <p className="rounded-lg bg-stone-100 p-3 text-sm" role="status">{msg}</p>}
      <aside className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" aria-labelledby="job-safety-title">
        <strong id="job-safety-title">완료와 게시 확인은 다릅니다</strong>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>콘텐츠 생성 성공은 초안 생성 완료이며, 콘텐츠 제작실에서 품질과 사람 승인을 다시 확인해야 합니다.</li>
          <li><strong>UNCERTAIN</strong>은 게시 여부 미확인 상태입니다. SNS 원문을 확인하기 전에는 같은 내용을 다시 게시하지 마세요.</li>
        </ul>
      </aside>
      <section className="card overflow-x-auto">
        <table className="table">
          <caption className="sr-only">내 작업의 실행 상태, 결과와 승인·취소 작업</caption>
          <thead><tr><th>작업</th><th>스페이스</th><th>내용</th><th>출처</th><th>상태</th><th>생성</th><th>결과</th><th></th></tr></thead>
          <tbody>
            {jobs?.length === 0 && <tr><td colSpan={8} className="text-center text-stone-500">작업이 없습니다.</td></tr>}
            {jobs?.map((j) => {
              const result = j.result as JobResult | null;
              const uncertain = j.publishPhase === "UNCERTAIN";
              const resolution = j.manualPublishResolution;
              const isPublish = j.jobType === "post.publish";
              const isContentGeneration = j.jobType === "content.generate";
              const generatedBy = result?.data?.generatedBy;
              return <tr key={j._id}>
                <td className="text-xs">{JOB_TYPE_LABEL[j.jobType] ?? j.jobType}</td>
                <td className="text-xs">{j.spaceName ?? "-"}</td>
                <td className="max-w-md text-xs">
                  {isPublish && j.status === "NEEDS_APPROVAL" && j.publishReview ? <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950">
                    <strong className="block">최종 게시 승인 내용</strong>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                      <dt className="font-medium">계정</dt><dd>{j.platform} {j.spaceHandle ? `@${j.spaceHandle}` : "핸들 미확인"} · {j.spaceName ?? "-"}</dd>
                      <dt className="font-medium">모드</dt><dd>{j.publishReview.dryRun ? "테스트 실행(게시 안 함)" : "실게시"}</dd>
                      <dt className="font-medium">게시 형식</dt><dd>{j.publishReview.contentChannel ? (CHANNEL_LABEL[j.publishReview.contentChannel] ?? j.publishReview.contentChannel) : "플랫폼 기본 형식"}</dd>
                      <dt className="font-medium">미디어</dt><dd>{j.publishReview.mediaUrls.length}개</dd>
                      <dt className="font-medium">링크</dt><dd>{j.publishReview.linkUrl ? <a className="break-all underline" href={j.publishReview.linkUrl} target="_blank" rel="noreferrer">{j.publishReview.linkUrl}<span className="sr-only">(새 창)</span></a> : "없음"}</dd>
                    </dl>
                    <div><span className="font-medium">전체 본문</span><p className="mt-1 whitespace-pre-wrap break-words rounded border border-amber-200 bg-white p-2 text-stone-900">{j.publishReview.text || "(본문 없음)"}</p></div>
                    {j.publishReview.mediaUrls.length > 0 && <details><summary className="cursor-pointer font-medium">미디어 URL 전체 보기</summary><ul className="mt-1 list-disc space-y-1 pl-4">{j.publishReview.mediaUrls.map((url: string) => <li key={url}><a className="break-all underline" href={url} target="_blank" rel="noreferrer">{url}<span className="sr-only">(새 창)</span></a></li>)}</ul></details>}
                    {j.publishReview.payloadHash && <p className="break-all text-[11px] text-amber-800">승인 결합 해시 {j.publishReview.payloadHash}</p>}
                  </div> : <span className="block max-w-xs truncate">{j.preview ?? ""}</span>}
                </td>
                <td className="text-xs">{j.source}</td>
                <td><Badge value={JOB_STATUS_TONE[j.status] ?? "PENDING"} label={uncertain ? "게시 여부 미확인" : JOB_STATUS_LABEL[j.status]} />{j.stage && j.status === "RUNNING" && <div className="text-xs text-stone-500">{j.stage} {j.progress != null ? `${j.progress}%` : ""}</div>}{isPublish && j.status === "NEEDS_APPROVAL" && <div className="mt-1 max-w-48 text-xs font-medium text-amber-800">승인하면 설정된 테스트/실게시 모드로 실행됩니다.</div>}</td>
                <td className="text-xs">{dateTime(j.createdAt)}</td>
                <td className="max-w-sm text-xs">
                  {resolution?.outcome === "PUBLISHED" && <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-2 text-emerald-950"><strong className="block">수동 확인 · 게시됨</strong><span>자동 실행 결과는 불명확했지만 SNS 원문으로 게시를 확인했습니다.</span>{resolution.evidenceUrl && <a className="mt-1 block font-medium underline" href={resolution.evidenceUrl} target="_blank" rel="noreferrer">확인한 게시물 열기<span className="sr-only">(새 창)</span></a>}<span className="mt-1 block text-[11px]">확인 시각 {dateTime(resolution.resolvedAt)}</span></div>}
                  {resolution?.outcome === "NOT_PUBLISHED" && <div className="rounded-lg border border-sky-300 bg-sky-50 p-2 text-sky-950"><strong className="block">수동 확인 · 게시되지 않음</strong><span>지연 게시와 중복을 막기 위해 제공자 처리 대기 시간까지 재게시 차단을 유지합니다.</span><span className="mt-1 block text-[11px]">확인 시각 {dateTime(resolution.resolvedAt)}{resolution.releaseAt ? ` · 차단 해제 예정 ${dateTime(resolution.releaseAt)}` : ""}</span></div>}
                  {uncertain && !resolution && <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-950"><strong className="block">UNCERTAIN · 게시 여부 미확인</strong><span>{j.errorCode} {j.errorMessage}</span><span className="mt-1 block font-medium">자동 재게시하지 않았습니다. SNS 원문을 직접 확인한 뒤 아래에서 결과를 확정하세요.</span></div>}
                  {j.errorCode && !uncertain && !resolution && <span className="text-rose-700"><strong className="block">실행 실패</strong>{j.errorCode} {j.errorMessage}</span>}
                  {isPublish && j.status === "SUCCEEDED" && result?.data?.dryRun === true && <span className="font-medium text-sky-800">테스트 실행 완료 · 실제 SNS에는 게시하지 않았습니다.</span>}
                  {isPublish && j.status === "SUCCEEDED" && result?.data?.dryRun !== true && result?.data?.postUrl && <span className="text-emerald-800"><strong className="block">실제 게시 확인됨</strong><a className="underline" href={result.data.postUrl} target="_blank" rel="noreferrer">SNS 게시물 열기<span className="sr-only">(새 창)</span></a></span>}
                  {isPublish && j.status === "SUCCEEDED" && result?.data?.dryRun !== true && !result?.data?.postUrl && <span className="font-medium text-amber-800">실행은 완료됐지만 게시물 URL이 없습니다. SNS에서 결과를 확인하세요.</span>}
                  {isContentGeneration && j.status === "SUCCEEDED" && <span className="text-amber-800"><strong className="block">초안 생성 완료 · 재검토 필요</strong>{generatedBy === "template" ? "템플릿 대체 결과입니다. " : generatedBy === "mixed" ? "일부 템플릿 대체 결과가 포함됐습니다. " : ""}<Link className="font-medium underline" href="/dashboard/workflow">콘텐츠 제작실에서 품질과 승인을 확인하세요.</Link></span>}
                  {result?.summary && !j.errorCode && !isPublish && !isContentGeneration && <span className="text-stone-600">{result.summary}</span>}
                  {!!result?.warnings?.length && <ul className="mt-1 list-disc pl-4 text-amber-800">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                </td>
                <td className="whitespace-nowrap">
                  {j.status === "NEEDS_APPROVAL" && <button className="btn-primary !px-2 !py-1 text-xs" type="button" onClick={() => {
                    if (isPublish && !window.confirm(`${j.platform} ${j.spaceHandle ? `@${j.spaceHandle}` : j.spaceName ?? "계정"}에 ${j.publishReview?.dryRun ? "테스트 실행" : "실제 게시"}합니다. 표에 표시된 전체 본문·미디어·링크를 모두 확인했나요?`)) return;
                    void run(() => approve({ jobId: j._id }), isPublish ? "게시 작업을 승인했습니다." : "작업을 승인했습니다.");
                  }}>{isPublish ? "게시 실행 승인" : "승인"}</button>}
                  {["NEEDS_APPROVAL", "QUEUED", "RUNNING"].includes(j.status) && <button className="btn-ghost ml-1 !px-2 !py-1 text-xs" onClick={() => run(() => cancel({ jobId: j._id }), "작업 취소를 요청했습니다.")}>취소</button>}
                  {uncertain && !resolution && <div className="flex flex-col items-stretch gap-1">
                    <button className="btn-primary !px-2 !py-1 text-xs" type="button" onClick={() => {
                      const evidenceUrl = window.prompt("실제로 게시된 SNS 원문의 HTTPS URL을 입력하세요. URL의 플랫폼과 게시물 형식을 검증합니다.");
                      if (evidenceUrl == null) return;
                      void run(() => resolveUncertainPublish({ jobId: j._id, outcome: "PUBLISHED", evidenceUrl }), "게시됨으로 확인했습니다.");
                    }}>게시됨 확인</button>
                    <button className="btn-ghost !px-2 !py-1 text-xs" type="button" onClick={() => {
                      if (!window.confirm("SNS 계정에서 해당 게시물이 없음을 직접 확인했나요? 지연 게시와 중복을 막기 위해 제공자 처리 대기 시간 동안 재게시 차단은 유지됩니다.")) return;
                      void run(() => resolveUncertainPublish({ jobId: j._id, outcome: "NOT_PUBLISHED" }), "게시되지 않음으로 확인했습니다. 안전 대기 후 차단이 해제됩니다.");
                    }}>게시 안 됨 확인</button>
                  </div>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
