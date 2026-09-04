"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { KYC_LABEL, dateTime, errorMessage } from "@/lib/format";

type Status = "SUBMITTED" | "APPROVED" | "REJECTED";

export default function SuperKycPage() {
  const [status, setStatus] = useState<Status>("SUBMITTED");
  const rows = useQuery(api.kyc.listQueue, { status });
  const review = useMutation(api.kyc.review);
  const getUrl = useMutation(api.kyc.getBankbookUrl);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">KYC 검수</h1>
        <div className="flex gap-1">
          {(["SUBMITTED", "APPROVED", "REJECTED"] as Status[]).map((s) => (
            <button key={s} className={status === s ? "btn-primary" : "btn-ghost"} onClick={() => setStatus(s)}>{KYC_LABEL[s]}</button>
          ))}
        </div>
      </div>
      {msg && <p className="mt-2 text-sm text-rose-700">{msg}</p>}
      <div className="mt-4 overflow-x-auto">
        <table className="table">
          <thead><tr><th>이메일</th><th>실명</th><th>생년월일</th><th>주민번호</th><th>연락처</th><th>계좌</th><th>제출</th><th>상태</th><th>통장사본</th><th></th></tr></thead>
          <tbody>
            {rows?.length === 0 && <tr><td colSpan={10} className="text-center text-stone-500">해당 상태의 건이 없습니다.</td></tr>}
            {rows?.map((r) => (
              <tr key={r._id}>
                <td>{r.email}</td>
                <td>{r.legalName}</td>
                <td>{r.birthDate}</td>
                <td className="font-mono text-xs">******-***{r.residentNoLast4}</td>
                <td>{r.phone}</td>
                <td className="text-xs">{r.bankName} ****{r.accountNoLast4} ({r.accountHolder})</td>
                <td className="text-xs">{dateTime(r.submittedAt)}</td>
                <td><Badge value={r.status} label={KYC_LABEL[r.status]} />{r.rejectReason && <div className="text-xs text-rose-700">{r.rejectReason}</div>}</td>
                <td>
                  <button className="text-xs underline" onClick={async () => { const url = await getUrl({ kycId: r._id }); if (url) window.open(url, "_blank"); }}>열람</button>
                </td>
                <td className="whitespace-nowrap">
                  {r.status !== "APPROVED" && (
                    <button className="btn-primary !px-2 !py-1 text-xs" onClick={async () => { try { await review({ kycId: r._id, decision: "APPROVED" }); } catch (e) { setMsg(errorMessage(e)); } }}>승인</button>
                  )}
                  {r.status === "SUBMITTED" && (
                    <button className="btn-ghost ml-1 !px-2 !py-1 text-xs" onClick={async () => { const reason = prompt("반려 사유"); if (!reason) return; try { await review({ kycId: r._id, decision: "REJECTED", reason }); } catch (e) { setMsg(errorMessage(e)); } }}>반려</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
