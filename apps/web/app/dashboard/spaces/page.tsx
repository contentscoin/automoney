"use client";

import { Suspense, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage } from "@/lib/format";
import { PLATFORM_LABEL, SPACE_STATE_LABEL, SPACE_STATE_TONE } from "@/lib/agent-format";
import { MetaConnect } from "@/components/MetaConnect";

type Platform = "THREADS" | "X" | "INSTAGRAM" | "TIKTOK" | "NAVER_BLOG";

export default function SpacesPage() {
  const spaces = useQuery(api.spaces.listMine);
  const devices = useQuery(api.devices.listMine);
  const create = useMutation(api.spaces.create);
  const setPinned = useMutation(api.spaces.setPinned);
  const setPaused = useMutation(api.spaces.setPaused);
  const requestLogin = useMutation(api.spaces.requestLogin);
  const requestVerify = useMutation(api.spaces.requestVerify);
  const remove = useMutation(api.spaces.remove);
  const [form, setForm] = useState<{ platform: Platform; name: string; handle: string }>({ platform: "THREADS", name: "", handle: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const hasDevice = devices?.some((d) => d.status === "ACTIVE");
  const wrap = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); } catch (e) { setMsg(errorMessage(e)); } };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">브라우저 스페이스</h1>
        <p className="text-sm text-stone-500">SNS 계정 1개 = 스페이스 1개. 쿠키·세션·작업 이력이 계정별로 격리되며, 고정(핀)하면 다른 계정 로그인과 지문 변경이 차단됩니다. 최초 로그인은 내 PC 에서 직접 합니다.</p>
      </div>
      <Suspense fallback={null}>
        <MetaConnect />
      </Suspense>
      {!hasDevice && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">먼저 <a className="underline" href="/dashboard/devices">데스크톱 에이전트</a>를 페어링하세요.</div>}
      <section className="card">
        <h2 className="font-semibold">새 스페이스</h2>
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void wrap(() => create({ platform: form.platform, name: form.name, handle: form.handle || undefined }), "스페이스를 만들었습니다. 에이전트가 프로필을 준비하면 로그인 창을 열 수 있습니다."); }}>
          <div><label className="label">플랫폼</label><select className="input" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as Platform })}>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label className="label">이름</label><input className="input" required maxLength={40} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="예: 메인, 서브1" /></div>
          <div><label className="label">계정 핸들(선택)</label><input className="input" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} placeholder="@handle" /></div>
          <button className="btn-primary" disabled={!hasDevice}>만들기</button>
        </form>
        {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
      </section>
      <section className="grid gap-4 md:grid-cols-2">
        {spaces?.length === 0 && <p className="text-sm text-stone-500">스페이스가 없습니다.</p>}
        {spaces?.map((s) => (
          <div key={s._id} className="card flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div><span className="text-xs text-stone-500">{PLATFORM_LABEL[s.platform]}</span><div className="font-semibold">{s.name} {s.handle && <span className="text-sm font-normal text-stone-500">@{s.handle}</span>}</div></div>
              <div className="flex items-center gap-1">
                {s.pinned && <span className="badge bg-orange-100 text-orange-800">고정</span>}
                <Badge value={SPACE_STATE_TONE[s.sessionState] ?? "PENDING"} label={SPACE_STATE_LABEL[s.sessionState]} />
                {s.authMode === "META_API" && <span className="rounded bg-sky-50 px-2 py-0.5 text-xs text-sky-800" title="Meta API 로 발행(브라우저 불필요). 토큰 만료 시 브라우저 스페이스로 폴백">Meta API</span>}
              </div>
            </div>
            <div className="text-xs text-stone-500">일일 한도 {s.dailyPostLimit}회 · 마지막 확인 {s.lastCheckedAt ? dateTime(s.lastCheckedAt) : "-"}{s.locked ? " · 작업 진행 중" : ""}</div>
            {s.lastError && <div className="rounded bg-rose-50 p-2 text-xs text-rose-700">{s.lastError}</div>}
            <div className="flex flex-wrap gap-1">
              <button className="btn-ghost !px-2 !py-1 text-xs" disabled={s.locked} onClick={() => wrap(() => requestLogin({ spaceId: s._id }), "PC 에서 로그인 창이 열립니다.")}>로그인 창 열기</button>
              <button className="btn-ghost !px-2 !py-1 text-xs" disabled={s.locked} onClick={() => wrap(() => requestVerify({ spaceId: s._id }), "세션 검증을 요청했습니다.")}>세션 검증</button>
              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => wrap(() => setPinned({ spaceId: s._id, pinned: !s.pinned }), s.pinned ? "고정 해제" : "고정했습니다.")}>{s.pinned ? "고정 해제" : "고정"}</button>
              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => wrap(() => setPaused({ spaceId: s._id, paused: s.sessionState !== "PAUSED" }), "변경했습니다.")}>{s.sessionState === "PAUSED" ? "재개" : "일시정지"}</button>
              {!s.pinned && <button className="btn-ghost !px-2 !py-1 text-xs text-rose-700" onClick={() => { if (confirm("스페이스를 삭제할까요? 예약도 중지됩니다.")) void wrap(() => remove({ spaceId: s._id }), "삭제했습니다."); }}>삭제</button>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
