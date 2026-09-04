"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { KYC_LABEL, dateTime, errorMessage } from "@/lib/format";

const BANKS = [
  ["004", "국민은행"], ["088", "신한은행"], ["020", "우리은행"], ["081", "하나은행"], ["011", "농협은행"],
  ["003", "기업은행"], ["023", "SC제일은행"], ["027", "씨티은행"], ["032", "부산은행"], ["031", "대구은행"],
  ["039", "경남은행"], ["034", "광주은행"], ["037", "전북은행"], ["035", "제주은행"], ["071", "우체국"],
  ["045", "새마을금고"], ["048", "신협"], ["090", "카카오뱅크"], ["089", "케이뱅크"], ["092", "토스뱅크"],
] as const;

export default function KycPage() {
  const mine = useQuery(api.kyc.getMine);
  const generateUploadUrl = useMutation(api.kyc.generateUploadUrl);
  const submit = useAction(api.kyc.submit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (mine === undefined) return <p className="text-sm text-stone-500">불러오는 중…</p>;
  const locked = mine?.status === "APPROVED";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-bold">정산 정보 (KYC)</h1>
      <p className="text-sm text-stone-500">수당 지급을 위해 본인 확인 정보와 계좌, 통장사본이 필요합니다. 주민등록번호와 계좌번호는 암호화되어 저장되며 운영자에게도 마스킹되어 표시됩니다.</p>

      {mine && (
        <div className="card mt-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">현재 상태</span>
            <Badge value={mine.status} label={KYC_LABEL[mine.status]} />
            <span className="text-xs text-stone-500">제출 {dateTime(mine.submittedAt)}</span>
          </div>
          {mine.status === "REJECTED" && <p className="mt-2 rounded-lg bg-rose-50 p-2 text-rose-700">반려 사유: {mine.rejectReason}</p>}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-600">
            <dt>이름</dt><dd>{mine.legalName}</dd>
            <dt>주민등록번호</dt><dd>{mine.residentNoMasked}</dd>
            <dt>연락처</dt><dd>{mine.phone}</dd>
            <dt>계좌</dt><dd>{mine.bankName} {mine.accountNoMasked} ({mine.accountHolder})</dd>
          </dl>
        </div>
      )}

      {!locked && (
        <form
          className="card mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setBusy(true);
            const form = e.currentTarget;
            const fd = new FormData(form);
            const file = fd.get("bankbook") as File | null;
            try {
              if (!file || file.size === 0) throw new Error("통장사본 파일을 선택해 주세요.");
              if (file.size > 10 * 1024 * 1024) throw new Error("통장사본은 10MB 이하여야 합니다.");
              const uploadUrl = await generateUploadUrl();
              const up = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
              if (!up.ok) throw new Error("파일 업로드에 실패했습니다.");
              const { storageId } = (await up.json()) as { storageId: Id<"_storage"> };
              const [bankCode, bankName] = String(fd.get("bank")).split("|");
              await submit({
                legalName: String(fd.get("legalName")),
                phone: String(fd.get("phone")),
                address: String(fd.get("address")),
                birthDate: String(fd.get("birthDate")),
                residentNo: String(fd.get("residentNo")),
                bankCode: bankCode ?? "",
                bankName: bankName ?? "",
                accountNo: String(fd.get("accountNo")),
                accountHolder: String(fd.get("accountHolder")),
                bankbookStorageId: storageId,
              });
              form.reset();
              setDone(true);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div><label className="label">실명</label><input className="input" name="legalName" required /></div>
          <div><label className="label">생년월일</label><input className="input" name="birthDate" type="date" required /></div>
          <div><label className="label">주민등록번호</label><input className="input" name="residentNo" placeholder="000000-0000000" required inputMode="numeric" /></div>
          <div><label className="label">휴대폰</label><input className="input" name="phone" placeholder="010-0000-0000" required /></div>
          <div className="sm:col-span-2"><label className="label">주소</label><input className="input" name="address" required /></div>
          <div>
            <label className="label">은행</label>
            <select className="input" name="bank" required defaultValue="">
              <option value="" disabled>선택</option>
              {BANKS.map(([code, name]) => <option key={code} value={`${code}|${name}`}>{name}</option>)}
            </select>
          </div>
          <div><label className="label">계좌번호</label><input className="input" name="accountNo" required inputMode="numeric" /></div>
          <div><label className="label">예금주</label><input className="input" name="accountHolder" required /></div>
          <div><label className="label">통장사본 (이미지/PDF, 10MB 이하)</label><input className="input" name="bankbook" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required /></div>
          {error && <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700 sm:col-span-2">{error}</p>}
          {done && <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700 sm:col-span-2">제출되었습니다. 검수 후 결과를 안내드립니다.</p>}
          <div className="sm:col-span-2"><button className="btn-primary" disabled={busy}>{busy ? "제출 중…" : mine ? "다시 제출" : "제출"}</button></div>
        </form>
      )}
    </div>
  );
}
