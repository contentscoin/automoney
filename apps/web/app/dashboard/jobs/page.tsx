"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage } from "@/lib/format";
import { JOB_STATUS_LABEL, JOB_STATUS_TONE, JOB_TYPE_LABEL } from "@/lib/agent-format";

export default function JobsPage() {
  const jobs = useQuery(api.jobs.listMine, { limit: 100 });
  const approve = useMutation(api.jobs.approve);
  const cancel = useMutation(api.jobs.cancel);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); setMsg(success); }
    catch (e) { setMsg(errorMessage(e)); }
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-bold">작업 결과</h1><p className="text-sm text-stone-500">승인 대기, 실행 단계, 실패 원인과 게시 결과를 확인합니다.</p></div><Link className="btn-primary" href="/dashboard/publish">새 게시 준비</Link></div>
      {msg && <p className="rounded-lg bg-stone-100 p-3 text-sm" role="status">{msg}</p>}
      <section className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>작업</th><th>스페이스</th><th>내용</th><th>출처</th><th>상태</th><th>생성</th><th>결과</th><th></th></tr></thead>
          <tbody>
            {jobs?.length === 0 && <tr><td colSpan={8} className="text-center text-stone-500">작업이 없습니다.</td></tr>}
            {jobs?.map((j) => (
              <tr key={j._id}>
                <td className="text-xs">{JOB_TYPE_LABEL[j.jobType] ?? j.jobType}</td>
                <td className="text-xs">{j.spaceName ?? "-"}</td>
                <td className="max-w-xs truncate text-xs">{j.preview ?? ""}</td>
                <td className="text-xs">{j.source}</td>
                <td><Badge value={JOB_STATUS_TONE[j.status] ?? "PENDING"} label={JOB_STATUS_LABEL[j.status]} />{j.stage && j.status === "RUNNING" && <div className="text-xs text-stone-500">{j.stage} {j.progress != null ? `${j.progress}%` : ""}</div>}</td>
                <td className="text-xs">{dateTime(j.createdAt)}</td>
                <td className="max-w-xs text-xs">
                  {j.errorCode && <span className={j.errorCode.includes("UNCERTAIN") ? "text-amber-800" : "text-rose-700"}>{j.errorCode} {j.errorMessage}{j.errorCode.includes("UNCERTAIN") && <strong className="mt-1 block">자동 재게시하지 않았습니다. SNS에서 게시 여부를 직접 확인하세요.</strong>}</span>}
                  {(j.result as { data?: { postUrl?: string } } | null)?.data?.postUrl && <a className="underline" href={(j.result as { data: { postUrl: string } }).data.postUrl} target="_blank" rel="noreferrer">게시물</a>}
                  {(j.result as { summary?: string } | null)?.summary && !j.errorCode && <span className="text-stone-600"> {(j.result as { summary: string }).summary}</span>}
                </td>
                <td className="whitespace-nowrap">
                  {j.status === "NEEDS_APPROVAL" && <button className="btn-primary !px-2 !py-1 text-xs" onClick={() => run(() => approve({ jobId: j._id }), "작업을 승인했습니다.")}>승인</button>}
                  {["NEEDS_APPROVAL", "QUEUED", "RUNNING"].includes(j.status) && <button className="btn-ghost ml-1 !px-2 !py-1 text-xs" onClick={() => run(() => cancel({ jobId: j._id }), "작업 취소를 요청했습니다.")}>취소</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
