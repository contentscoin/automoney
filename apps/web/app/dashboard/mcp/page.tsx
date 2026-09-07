"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { MCP_TOOLS, type McpScope } from "@automoney/shared";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/Badge";
import { dateTime, errorMessage } from "@/lib/format";

const SCOPE_LABEL: Record<string, string> = { "mcp:read": "읽기(실적·링크·콘텐츠 조회)", "mcp:write": "쓰기(링크 발급·발행·예약·생성 요청)", "admin:read": "총판 통계", "super:read": "운영 전체 통계" };

export default function McpPage() {
  const data = useQuery(api.mcp.listMine);
  const create = useMutation(api.mcp.createCredential);
  const revoke = useMutation(api.mcp.revoke);
  const [label, setLabel] = useState("Claude Desktop");
  const [scopes, setScopes] = useState<McpScope[]>(["mcp:read", "mcp:write"]);
  const [issued, setIssued] = useState<{ endpointUrl: string; bearerUrl: string; apiKey: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = (s: McpScope) => setScopes(scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s]);
  const claudeConfig = issued ? JSON.stringify({ mcpServers: { automoney: { type: "http", url: issued.endpointUrl } } }, null, 2) : "";
  const cursorConfig = issued ? JSON.stringify({ mcpServers: { automoney: { url: issued.bearerUrl, headers: { Authorization: `Bearer ${issued.apiKey}` } } } }, null, 2) : "";
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">MCP 연동</h1>
        <p className="text-sm text-stone-500">Claude·Cursor 같은 AI 클라이언트에서 automoney 툴(링크 발급·발행·예약·실적 조회)을 직접 호출합니다. 세션 상태 없는 HTTP(POST) 서버이며, 발행·스페이스 생성은 확인(confirmed) 없이는 미리보기만 반환합니다.</p>
      </div>
      <section className="card">
        <h2 className="font-semibold">OAuth 로 연결 (권장)</h2>
        <p className="mt-1 text-sm text-stone-600">Claude.ai 커넥터, Claude Code, Cursor 등 OAuth 를 지원하는 클라이언트에는 아래 서버 URL 만 넣으세요. 로그인·권한 동의 화면을 거쳐 자동으로 연결되고, 토큰은 1시간마다 갱신됩니다. 발급된 연결은 아래 목록에 &quot;OAuth · 클라이언트명&quot; 으로 표시되며 언제든 폐기할 수 있습니다.</p>
        <code className="mt-2 block break-all rounded bg-stone-50 p-2 text-xs" data-automoney="mcp-oauth-url">{data?.oauth.serverUrl ?? "…"}</code>
        <pre className="mt-2 overflow-x-auto rounded bg-stone-50 p-2 text-xs">{`claude mcp add --transport http automoney ${data?.oauth.serverUrl ?? ""}`}</pre>
      </section>
      <section className="card">
        <h2 className="font-semibold">API 키 직접 발급 (OAuth 를 지원하지 않는 클라이언트)</h2>
        <form className="mt-2 grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); try { const r = await create({ label, scopes }); setIssued(r); setMsg("발급했습니다. 시크릿은 지금만 표시됩니다."); } catch (err) { setMsg(errorMessage(err)); } }}>
          <div><label className="label">이름</label><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} required /></div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="label">스코프</span>
            {(data?.allowedScopes ?? ["mcp:read", "mcp:write"]).map((s) => <label key={s} className="flex items-center gap-2"><input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />{SCOPE_LABEL[s] ?? s}</label>)}
          </div>
          <div className="sm:col-span-2"><button className="btn-primary" disabled={scopes.length === 0}>발급</button></div>
        </form>
        {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
        {issued && (
          <div className="mt-3 grid gap-3 text-sm" data-automoney="mcp-issued">
            <div><div className="label">원타임 엔드포인트 URL (Claude Desktop 등 URL 만 받는 클라이언트)</div><code className="block break-all rounded bg-stone-50 p-2 text-xs">{issued.endpointUrl}</code></div>
            <div><div className="label">API 키 (Authorization: Bearer)</div><code className="block break-all rounded bg-stone-50 p-2 text-xs">{issued.apiKey}</code></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><div className="label">claude_desktop_config.json</div><pre className="overflow-x-auto rounded bg-stone-50 p-2 text-xs">{claudeConfig}</pre></div>
              <div><div className="label">Cursor mcp.json</div><pre className="overflow-x-auto rounded bg-stone-50 p-2 text-xs">{cursorConfig}</pre></div>
            </div>
          </div>
        )}
      </section>
      <section className="card overflow-x-auto">
        <h2 className="font-semibold">내 자격증명</h2>
        <table className="table mt-2">
          <thead><tr><th>이름</th><th>엔드포인트</th><th>스코프</th><th>상태</th><th>호출</th><th>마지막 사용</th><th></th></tr></thead>
          <tbody>
            {data?.credentials.length === 0 && <tr><td colSpan={7} className="text-center text-stone-500">발급된 자격증명이 없습니다.</td></tr>}
            {data?.credentials.map((c) => (
              <tr key={c._id}>
                <td className="text-sm">{c.label}{c.kind === "OAUTH" && <span className="ml-1 rounded bg-stone-100 px-1 text-[10px] text-stone-500">OAuth</span>}</td>
                <td className="font-mono text-xs">{c.endpointId}</td>
                <td className="text-xs">{c.scopes.join(", ")}</td>
                <td><Badge value={c.status === "ACTIVE" ? "ACTIVE" : "DISABLED"} label={c.status === "ACTIVE" ? "활성" : "폐기"} /></td>
                <td className="text-xs">{c.callCount}</td>
                <td className="text-xs">{c.lastUsedAt ? dateTime(c.lastUsedAt) : "-"}</td>
                <td>{c.status === "ACTIVE" && <button className="btn-ghost !px-2 !py-1 text-xs" onClick={async () => { if (confirm("폐기할까요? 이 키를 쓰는 클라이언트는 즉시 401 을 받습니다.")) await revoke({ credentialId: c._id }); }}>폐기</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card overflow-x-auto">
        <h2 className="font-semibold">툴 카탈로그 ({MCP_TOOLS.length})</h2>
        <table className="table mt-2">
          <thead><tr><th>툴</th><th>설명</th><th>스코프</th><th>비고</th></tr></thead>
          <tbody>{MCP_TOOLS.map((t) => <tr key={t.name}><td className="font-mono text-xs">{t.name}</td><td className="text-xs">{t.description}</td><td className="text-xs">{t.scope}</td><td className="text-xs">{t.dangerous ? "confirmed 필요 " : ""}{t.returnsJob ? "잡 id 반환" : ""}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
