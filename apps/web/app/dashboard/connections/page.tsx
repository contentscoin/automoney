"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DownloadButtons } from "@/components/DownloadButtons";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage } from "@/lib/format";
import { PLATFORM_LABEL, SPACE_STATE_LABEL, SPACE_STATE_TONE } from "@/lib/agent-format";

export default function ConnectionsPage() {
  const devices = useQuery(api.devices.listMine);
  const spaces = useQuery(api.spaces.listMine);
  const createPairCode = useMutation(api.devices.createPairCode);
  const requestCodexLogin = useMutation(api.devices.requestCodexLogin);
  const requestLogin = useMutation(api.spaces.requestLogin);
  const requestVerify = useMutation(api.spaces.requestVerify);
  const [pair, setPair] = useState<{ code: string; deepLink: string; expiresAt: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const active = devices?.find((d) => d.status === "ACTIVE");
  const codex = active?.snapshot as { codexInstalled?: boolean | null; codexLoggedIn?: boolean | null; codexDetail?: string | null } | null | undefined;
  const wrap = async (action: () => Promise<unknown>, ok: string) => { try { await action(); setMsg(ok); } catch (e) { setMsg(errorMessage(e)); } };
  return <div className="flex flex-col gap-6">
    <div><h1 className="text-xl font-bold">연결 관리</h1><p className="text-sm text-stone-500">PC 앱, AI 초안 생성, SNS 게시 계정을 순서대로 준비합니다.</p></div>
    {msg && <p className="rounded-lg bg-stone-100 p-3 text-sm" role="status">{msg}</p>}
    <section className="card"><h2 className="font-semibold">PC 앱</h2><p className="mt-1 text-sm text-stone-500">브라우저 SNS 게시와 AI 생성 작업을 내 PC에서 실행합니다.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3"><DownloadButtons compact /><button className="btn-primary" onClick={async () => { try { setPair(await createPairCode()); } catch (e) { setMsg(errorMessage(e)); } }}>페어링 코드 발급</button>{pair && <div className="rounded-lg bg-stone-100 px-4 py-2"><strong className="font-mono tracking-widest">{pair.code}</strong><a className="ml-3 text-xs underline" href={pair.deepLink}>앱에서 열기</a><div className="text-xs text-stone-500">{dateTime(pair.expiresAt)} 만료</div></div>}</div>
      {active && <p className="mt-3 text-sm"><Badge value={active.online ? "ACTIVE" : "PENDING"} label={active.online ? "온라인" : "오프라인"} /> <span className="ml-2">{active.name} · v{active.appVersion} · 마지막 접속 {active.lastSeenAt ? dateTime(active.lastSeenAt) : "-"}</span></p>}
    </section>
    <section id="ai" className="card scroll-mt-4"><h2 className="font-semibold">AI 초안 생성</h2><p className="mt-1 text-sm text-stone-500">현재 PC의 Codex CLI를 사용합니다. 로그인 정보는 PC에만 저장됩니다.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3"><Badge value={codex?.codexLoggedIn ? "ACTIVE" : codex?.codexInstalled ? "PENDING" : "DISABLED"} label={codex?.codexLoggedIn ? "준비 완료" : codex?.codexInstalled ? "로그인 필요" : active?.online ? "Codex CLI 미설치" : "PC 연결 필요"} />
        {active?.online && codex?.codexInstalled && !codex.codexLoggedIn && <button className="btn-primary" onClick={() => wrap(() => requestCodexLogin(), "PC에서 Codex 로그인 창을 시작했습니다. 완료 후 잠시 기다리면 상태가 갱신됩니다.")}>Codex 로그인 시작</button>}
        {active?.online && !codex?.codexInstalled && <a className="btn-ghost" href="https://developers.openai.com/codex" target="_blank" rel="noreferrer">설치 안내</a>}
      </div>{codex?.codexDetail && !codex.codexLoggedIn && <p className="mt-2 text-xs text-stone-500">{codex.codexDetail}</p>}
    </section>
    <section id="sns" className="scroll-mt-4"><div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold">게시 계정</h2><p className="text-sm text-stone-500">정상 상태인 계정만 게시 화면에서 선택할 수 있습니다.</p></div><Link className="btn-primary" href="/dashboard/spaces">계정 추가·상세 관리</Link></div>
      <div className="grid gap-3 md:grid-cols-2">{spaces?.length === 0 && <p className="text-sm text-stone-500">연결된 게시 계정이 없습니다.</p>}{spaces?.map((s) => <article className="card" key={s._id}><div className="flex items-center justify-between"><strong>{PLATFORM_LABEL[s.platform]} · {s.name}</strong><Badge value={SPACE_STATE_TONE[s.sessionState] ?? "PENDING"} label={SPACE_STATE_LABEL[s.sessionState]} /></div><p className="mt-1 text-xs text-stone-500">{s.handle ? `@${s.handle} · ` : ""}{s.authMode === "META_API" ? "Meta API" : "PC 브라우저"}</p><div className="mt-3 flex gap-2">{s.authMode !== "META_API" && <button className="btn-ghost" disabled={!active?.online || s.locked} onClick={() => wrap(() => requestLogin({ spaceId: s._id }), "PC에서 로그인 창을 열었습니다.")}>로그인</button>}<button className="btn-ghost" disabled={!active?.online || s.locked || s.authMode === "META_API"} onClick={() => wrap(() => requestVerify({ spaceId: s._id }), "계정 상태 확인을 요청했습니다.")}>상태 확인</button></div></article>)}</div>
    </section>
  </div>;
}
