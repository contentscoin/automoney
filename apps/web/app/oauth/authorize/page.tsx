"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { MCP_SCOPES, type McpScope } from "@automoney/shared";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/format";

const SCOPE_LABEL: Record<string, string> = { "mcp:read": "실적·링크·콘텐츠 조회", "mcp:write": "링크 발급·발행·예약·콘텐츠 생성 요청", "admin:read": "파트너 팀 통계 조회", "super:read": "운영 전체 통계 조회" };

function redirectWith(redirectUri: string, params: Record<string, string | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, val] of Object.entries(params)) if (val) u.searchParams.set(k, val);
  window.location.assign(u.toString());
}

function Consent() {
  const sp = useSearchParams();
  const clientId = sp.get("client_id") ?? "";
  const redirectUri = sp.get("redirect_uri") ?? "";
  const state = sp.get("state") ?? undefined;
  const responseType = sp.get("response_type") ?? "code";
  const codeChallenge = sp.get("code_challenge") ?? "";
  const codeChallengeMethod = sp.get("code_challenge_method") ?? "";
  const resource = sp.get("resource") ?? undefined;
  const requestedScopes = (sp.get("scope") ?? "").split(/[\s+]+/).filter((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s));
  const client = useQuery(api.oauth.clientPublic, clientId ? { clientId } : "skip");
  const me = useQuery(api.mcp.listMine, {});
  const approve = useMutation(api.oauth.approve);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const problem = !clientId || !redirectUri ? "client_id 와 redirect_uri 가 필요합니다." : client === null ? "등록되지 않은 클라이언트입니다." : client && !client.redirectUris.includes(redirectUri) ? "redirect_uri 가 등록된 값과 다릅니다." : responseType !== "code" ? "response_type=code 만 지원합니다." : codeChallengeMethod !== "S256" || !codeChallenge ? "PKCE(S256) code_challenge 가 필요합니다." : null;
  const allowed = me?.allowedScopes ?? [];
  const effective = (requestedScopes.length > 0 ? requestedScopes : (["mcp:read", "mcp:write"] as McpScope[])).filter((s) => allowed.includes(s));
  const canRedirectError = client && client.redirectUris.includes(redirectUri);

  if (!client || !me) return <p className="text-sm text-stone-500">확인 중…</p>;
  return (
    <>
      <div className="flex items-center gap-3">
        {client.logoUri && <img src={client.logoUri} alt="" className="h-10 w-10 rounded" />}
        <div>
          <div className="font-semibold">{client.clientName}</div>
          {client.clientUri && <a className="text-xs text-stone-500 underline" href={client.clientUri} target="_blank" rel="noreferrer">{client.clientUri}</a>}
        </div>
      </div>
      <p className="mt-4 text-sm text-stone-700">이 앱이 내 automoney 계정으로 다음 작업을 할 수 있게 허용합니다.</p>
      <ul className="mt-2 space-y-1 text-sm">
        {effective.map((s) => <li key={s} className="rounded-lg border border-stone-200 px-3 py-2">✓ {SCOPE_LABEL[s] ?? s} <span className="text-xs text-stone-400">({s})</span></li>)}
        {effective.length === 0 && <li className="text-sm text-red-600">현재 역할로 허용되는 권한이 없습니다.</li>}
      </ul>
      <p className="mt-3 text-xs text-stone-500">발행·스페이스 생성은 앱이 확인(confirmed)을 보내야 실행되며, 언제든 대시보드 &gt; MCP 연동에서 연결을 끊을 수 있습니다. 액세스 토큰은 1시간마다 갱신되고 30일간 사용하지 않으면 만료됩니다.</p>
      {problem && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{problem}</p>}
      {err && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{err}</p>}
      <div className="mt-5 flex gap-2">
        <button
          className="btn-primary"
          disabled={busy || !!problem || effective.length === 0}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await approve({ clientId, redirectUri, scopes: effective, codeChallenge, codeChallengeMethod, resource });
              redirectWith(redirectUri, { code: r.code, state });
            } catch (e) {
              setErr(errorMessage(e));
              setBusy(false);
            }
          }}
        >
          허용
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => (canRedirectError ? redirectWith(redirectUri, { error: "access_denied", error_description: "user denied", state }) : window.history.back())}>
          거부
        </button>
      </div>
    </>
  );
}

export default function AuthorizePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="card">
        <div className="mb-3 text-xs font-medium text-stone-500">automoney 연결 요청</div>
        <Suspense fallback={<p className="text-sm text-stone-500">확인 중…</p>}>
          <AuthLoading><p className="text-sm text-stone-500">로그인 확인 중…</p></AuthLoading>
          <Unauthenticated>
            <p className="text-sm text-stone-700">계속하려면 automoney 에 로그인하세요.</p>
            <SignInLink />
          </Unauthenticated>
          <Authenticated>
            <Consent />
          </Authenticated>
        </Suspense>
      </div>
    </main>
  );
}

function SignInLink() {
  const sp = useSearchParams();
  const next = `/oauth/authorize?${sp.toString()}`;
  return (
    <div className="mt-4 flex gap-2">
      <Link className="btn-primary" href={`/signin?next=${encodeURIComponent(next)}`}>로그인</Link>
      <Link className="btn-ghost" href={`/signup?next=${encodeURIComponent(next)}`}>파트너 가입</Link>
    </div>
  );
}
