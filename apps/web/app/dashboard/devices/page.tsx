"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { DownloadButtons } from "@/components/DownloadButtons";
import { dateTime, errorMessage } from "@/lib/format";

export default function DevicesPage() {
  const devices = useQuery(api.devices.listMine);
  const createPairCode = useMutation(api.devices.createPairCode);
  const revoke = useMutation(api.devices.revoke);
  const [pair, setPair] = useState<{ code: string; deepLink: string; expiresAt: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">데스크톱 에이전트</h1>
        <p className="text-sm text-stone-500">SNS 포스팅과 브라우저 스페이스는 내 PC 의 automoney 에이전트가 실행합니다. 계정당 활성 디바이스는 1대이며, 새로 페어링하면 이전 디바이스는 교체됩니다.</p>
      </div>
      <section className="card">
        <h2 className="font-semibold">페어링</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-stone-700">
          <li>
            PC 에 automoney 데스크톱 앱을 설치하고 실행합니다. 서명이 없어 처음 실행 시 SmartScreen/Gatekeeper 경고가 뜨면 &quot;추가 정보 → 실행&quot; 을 누르세요. 설치 후에는 새 버전이 자동으로 갱신됩니다.
            <div className="mt-2"><DownloadButtons compact /></div>
          </li>
          <li>아래에서 페어링 코드를 발급합니다(10분 유효, 1회용).</li>
          <li>앱 트레이 패널에 코드를 입력하거나 링크를 클릭합니다.</li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="btn-primary" onClick={async () => { try { setPair(await createPairCode()); } catch (e) { setMsg(errorMessage(e)); } }}>페어링 코드 발급</button>
          {pair && (
            <div className="rounded-lg bg-stone-100 px-4 py-2 font-mono text-lg tracking-widest">
              {pair.code}
              <a className="ml-3 text-xs underline" href={pair.deepLink}>앱에서 열기</a>
              <div className="text-xs font-sans text-stone-500">만료 {dateTime(pair.expiresAt)}</div>
            </div>
          )}
        </div>
        {msg && <p className="mt-2 text-sm text-rose-700">{msg}</p>}
      </section>
      <section className="card overflow-x-auto">
        <h2 className="font-semibold">디바이스</h2>
        <table className="table mt-2">
          <thead><tr><th>이름</th><th>플랫폼</th><th>앱 버전</th><th>상태</th><th>마지막 접속</th><th>페어링</th><th></th></tr></thead>
          <tbody>
            {devices?.length === 0 && <tr><td colSpan={7} className="text-center text-stone-500">페어링된 디바이스가 없습니다.</td></tr>}
            {devices?.map((d) => (
              <tr key={d._id}>
                <td>{d.name}</td><td className="text-xs">{d.platform}</td><td className="text-xs">{d.appVersion}</td>
                <td><Badge value={d.status === "ACTIVE" ? (d.online ? "ACTIVE" : "PENDING") : "DISABLED"} label={d.status === "ACTIVE" ? (d.online ? "온라인" : "오프라인") : d.status === "REVOKED" ? "해지" : "교체됨"} /></td>
                <td className="text-xs">{d.lastSeenAt ? dateTime(d.lastSeenAt) : "-"}</td>
                <td className="text-xs">{dateTime(d.pairedAt)}</td>
                <td>{d.status === "ACTIVE" && <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => revoke({ deviceId: d._id })}>해지</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
