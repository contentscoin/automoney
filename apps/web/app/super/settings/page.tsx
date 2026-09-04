"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { errorMessage, pct } from "@/lib/format";

export default function SuperSettingsPage() {
  const settings = useQuery(api.settings.listAll);
  const setRate = useMutation(api.settings.setDefaultUserRateBps);
  const [value, setValue] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!settings) return <p className="text-sm text-stone-500">불러오는 중…</p>;
  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-bold">요율 설정</h1>
      <div className="card mt-4">
        <p className="text-sm">현재 기본 유저 요율: <b>{pct(settings.defaultUserRateBps)}</b> ({settings.defaultUserRateBps} bps)</p>
        <p className="mt-1 text-xs text-stone-500">M1 에서는 직접구매 수당 기준금액에 단일 요율을 적용해 예상 수당을 계산합니다. 그레이드·총판·간접 요율표는 M2 정산 엔진에서 추가됩니다.</p>
        <form className="mt-4 flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { await setRate({ rateBps: Number(value) }); setMsg("저장되었습니다."); setValue(""); } catch (err) { setMsg(errorMessage(err)); } }}>
          <input className="input max-w-40" type="number" min={0} max={10000} step={1} placeholder="bps (예: 500 = 5%)" value={value} onChange={(e) => setValue(e.target.value)} required />
          <button className="btn-primary">저장</button>
        </form>
        {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
      </div>
    </div>
  );
}
