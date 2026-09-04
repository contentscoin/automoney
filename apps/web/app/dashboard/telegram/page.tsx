"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { dateTime, errorMessage } from "@/lib/format";

export default function TelegramPage() {
  const me = useQuery(api.telegram.getMine);
  const createBindCode = useMutation(api.telegram.createBindCode);
  const unbind = useMutation(api.telegram.unbind);
  const setNotify = useMutation(api.telegram.setNotify);
  const [code, setCode] = useState<{ code: string; deepLink: string | null; expiresAt: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!me) return <p className="text-sm text-stone-500">불러오는 중…</p>;
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-bold">텔레그램 봇</h1>
      <p className="text-sm text-stone-500">작업 지시(/post, /schedule …)와 결과 보고를 텔레그램으로 주고받습니다. 예약 발행 승인도 채팅에서 버튼으로 처리합니다.</p>
      <div className="card mt-4">
        {me.bound ? (
          <>
            <p className="text-sm">연결됨 {me.boundAt && <span className="text-xs text-stone-500">({dateTime(me.boundAt)})</span>}</p>
            <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={me.notify} onChange={(e) => setNotify({ notify: e.target.checked })} />작업 완료·실패 알림 받기</label>
            <button className="btn-ghost mt-3" onClick={() => unbind()}>연결 해제</button>
          </>
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-stone-700">
              <li>텔레그램에서 {me.botUsername ? <b>@{me.botUsername}</b> : "automoney 봇"} 을 엽니다.</li>
              <li>아래 코드를 발급해 <code>/start 코드</code> 로 보냅니다(10분 유효).</li>
            </ol>
            <div className="mt-3 flex items-center gap-3">
              <button className="btn-primary" onClick={async () => { try { setCode(await createBindCode()); } catch (e) { setMsg(errorMessage(e)); } }}>연결 코드 발급</button>
              {code && <div className="rounded-lg bg-stone-100 px-4 py-2 font-mono text-lg tracking-widest">{code.code}{code.deepLink && <a className="ml-3 text-xs underline" href={code.deepLink} target="_blank" rel="noreferrer">봇 열기</a>}</div>}
            </div>
          </>
        )}
        {msg && <p className="mt-2 text-sm text-rose-700">{msg}</p>}
        <div className="mt-4 rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
          <b>명령</b>: /status 에이전트·스페이스 상태 · /earnings 이번 달 실적 · /links 최근 링크 · /schedule 예약 · /post &lt;스페이스명&gt; &lt;내용&gt; 게시(승인 후) · /jobs 최근 작업
        </div>
      </div>
    </div>
  );
}
