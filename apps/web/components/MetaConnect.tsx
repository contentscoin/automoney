"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
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
  const connectStart = useMutation(api.meta.connectStart);
  const disconnect = useMutation(api.meta.disconnect);
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
      <p className="mt-1 text-xs text-stone-500">연결된 계정은 브라우저 없이 API 로 게시하고 인사이트를 수집합니다. 토큰 만료·권한 오류 시 같은 내용으로 브라우저 스페이스에 자동 폴백합니다(데스크톱 에이전트가 있을 때).</p>
      {(msg ?? resultMsg) && <p className="mt-2 text-sm text-stone-700">{msg ?? resultMsg}</p>}
      {meta && meta.accounts.length > 0 && (
        <ul className="mt-3 grid gap-2 text-sm">
          {meta.accounts.map((a) => (
            <li key={a._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 p-2">
              <span className="font-medium">{a.platform === "THREADS" ? "스레드" : "인스타그램"}{a.username ? ` @${a.username}` : ""}</span>
              <Badge value={a.status === "ACTIVE" ? "ACTIVE" : a.status === "EXPIRED" ? "PENDING" : "DISABLED"} label={a.status === "ACTIVE" ? "연결됨" : a.status === "EXPIRED" ? "토큰 만료" : "해제됨"} />
              <span className="text-xs text-stone-500">{a.mode === "mock" ? "mock" : "graph"} · 만료 {dateTime(a.tokenExpiresAt)}</span>
              {a.lastError && <span className="text-xs text-rose-700">{a.lastError}</span>}
              {a.status !== "REVOKED" && <button className="btn-ghost ml-auto !px-2 !py-1 text-xs" onClick={async () => { if (confirm("연결을 해제할까요?")) { try { await disconnect({ accountId: a._id }); } catch (e) { setMsg(errorMessage(e)); } } }}>해제</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
