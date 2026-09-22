"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

function Step({ done, title, description, href, action }: { done: boolean; title: string; description: string; href: string; action: string }) {
  return <li className="card flex items-start gap-3"><span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>{done ? "✓" : "·"}</span><div className="min-w-0 flex-1"><h2 className="font-semibold">{title}</h2><p className="text-sm text-stone-500">{description}</p></div><Link className={done ? "btn-ghost" : "btn-primary"} href={href}>{done ? "확인" : action}</Link></li>;
}

export default function StartPage() {
  const devices = useQuery(api.devices.listMine);
  const spaces = useQuery(api.spaces.listMine);
  const library = useQuery(api.content.listLibrary, { limit: 10 });
  const jobs = useQuery(api.jobs.listMine, { limit: 20 });
  const active = devices?.find((d) => d.status === "ACTIVE");
  const snapshot = active?.snapshot as { codexLoggedIn?: boolean | null } | null | undefined;
  const hasContent = (library?.length ?? 0) > 0;
  const hasAccount = spaces?.some((s) => s.sessionState === "HEALTHY" && !s.locked) ?? false;
  const hasPosted = jobs?.some((j) => j.jobType === "post.publish" && j.status === "SUCCEEDED") ?? false;
  return <div className="flex flex-col gap-6">
    <div><h1 className="text-xl font-bold">첫 게시 시작하기</h1><p className="text-sm text-stone-500">AI는 선택 사항입니다. 운영 제공 콘텐츠나 직접 작성으로도 게시할 수 있습니다.</p></div>
    <ol className="grid gap-3">
      <Step done={hasContent} title="1. 콘텐츠 고르기" description="제공 콘텐츠를 가져오거나, 직접 작성하거나, AI로 초안을 만드세요." href="/dashboard/content" action="콘텐츠 찾기" />
      <Step done={!!active?.online} title="2. PC 연결" description={active?.online ? `${active.name} 에이전트가 온라인입니다.` : "브라우저로 SNS에 게시하거나 AI 초안을 만들 때 PC 앱이 필요합니다."} href="/dashboard/connections" action="PC 연결" />
      <Step done={snapshot?.codexLoggedIn === true} title="3. AI 초안 생성 준비 (선택)" description={snapshot?.codexLoggedIn ? "Codex 로그인이 확인됐습니다." : "AI 초안을 쓸 때만 Codex CLI 로그인이 필요합니다."} href="/dashboard/connections#ai" action="AI 연결" />
      <Step done={hasAccount} title="4. 게시 계정 연결" description={hasAccount ? "게시 가능한 SNS 계정이 있습니다." : "사용할 SNS 계정에 로그인하고 세션을 확인하세요."} href="/dashboard/connections#sns" action="계정 연결" />
      <Step done={hasPosted} title="5. 첫 게시" description={hasContent ? "콘텐츠와 게시 계정을 검토한 뒤 승인 요청을 등록하세요." : "콘텐츠를 준비하면 게시 검토를 시작할 수 있습니다."} href="/dashboard/publish" action="게시 준비" />
    </ol>
  </div>;
}
