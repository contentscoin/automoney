"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage } from "@/lib/format";

const RESULT_MSG: Record<string, string> = {
  connected: "Meta 계정이 연결되었습니다. 이 스페이스의 발행은 API 로 처리됩니다.",
  error_state: "연결 세션이 만료되었습니다. 다시 시도하세요.",
  error_missing: "콜백 파라미터가 없습니다.",
  error_config: "서버에 토큰 암호화 키가 없습니다(운영자 문의).",
};

/** 스페이스 화면: Threads·Instagram 을 Meta API 로 연결(ADR-0004). 앱 자격증명이 없으면 Mock 모드로 전체 흐름을 검증한다. */
export function MetaConnect() {
  const params = useSearchParams();
  const meta = useQuery(api.meta.listMine);
  const status = useQuery(api.meta.status);
  const spaces = useQuery(api.spaces.listMine);
  const connectStart = useMutation(api.meta.connectStart);
  const disconnect = useMutation(api.meta.disconnect);
  const setFallbackSpace = useMutation(api.meta.setFallbackSpace);
  const [msg, setMsg] = useState<string | null>(null);
  const result = params.get("meta");
  const resultMsg = result ? RESULT_MSG[result] ?? `연결 실패: ${result.replace(/^error_/, "")}` : null;
  const connect = async (platform: "THREADS" | "INSTAGRAM") => {
    try {
      const r = await connectStart({ platform });
      window.location.href = r.url;
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  return (
    <section className="card" data-automoney="meta-connect">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Meta API 연결 (Threads · Instagram)</h2>
        {status && <span className="text-xs text-stone-500">{status.mode === "graph" ? "실 API 모드" : "Mock 모드(앱 자격증명 없음 — 흐름 검증용)"}</span>}
        <span className="ml-auto flex gap-2">
          <button className="btn-ghost" onClick={() => connect("THREADS")}>스레드 연결</button>
          <button className="btn-ghost" onClick={() => connect("INSTAGRAM")}>인스타그램 연결</button>
        </span>
      </div>
      <p className="mt-1 text-xs text-stone-500">연결된 계정은 브라우저 없이 API 로 게시하고 인사이트를 수집합니다. 확인된 미게시 오류에만 아래에서 지정한 동일 계정 브라우저 스페이스로 전환합니다. 게시 여부가 불명확하면 자동 재게시하지 않습니다.</p>
      {(msg ?? resultMsg) && <p className="mt-2 text-sm text-stone-700">{msg ?? resultMsg}</p>}
      {meta && meta.accounts.length > 0 && (
        <ul className="mt-3 grid gap-2 text-sm">
          {meta.accounts.map((a) => (
            <li key={a._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 p-2">
              <span className="font-medium">{a.platform === "THREADS" ? "스레드" : "인스타그램"}{a.username ? ` @${a.username}` : ""}</span>
              <Badge value={a.status === "ACTIVE" ? "ACTIVE" : a.status === "EXPIRED" ? "PENDING" : "DISABLED"} label={a.status === "ACTIVE" ? "연결됨" : a.status === "EXPIRED" ? "토큰 만료" : "해제됨"} />
              <span className="text-xs text-stone-500">{a.mode === "mock" ? "mock" : "graph"} · 만료 {dateTime(a.tokenExpiresAt)}</span>
              {a.lastError && <span className="text-xs text-rose-700">{a.lastError}</span>}
              <label className="text-xs text-stone-600">브라우저 폴백 <select className="input !w-auto !py-1" value={a.fallbackSpaceId ?? ""} onChange={async (event) => { try { await setFallbackSpace({ accountId: a._id, fallbackSpaceId: event.target.value ? event.target.value as Id<"spaces"> : undefined }); setMsg("폴백 스페이스를 변경했습니다."); } catch (e) { setMsg(errorMessage(e)); } }}>
                <option value="">사용 안 함</option>
                {spaces?.filter((space) => space.platform === a.platform && space.authMode !== "META_API" && space.sessionState === "HEALTHY" && !!space.handle && space.handle.toLowerCase() === a.username?.toLowerCase()).map((space) => <option key={space._id} value={space._id}>{space.name} @{space.handle}</option>)}
              </select></label>
              {a.status !== "REVOKED" && <button className="btn-ghost ml-auto !px-2 !py-1 text-xs" onClick={async () => { if (confirm("연결을 해제할까요?")) { try { await disconnect({ accountId: a._id }); } catch (e) { setMsg(errorMessage(e)); } } }}>해제</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
