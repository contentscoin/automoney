import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { sha256Base64Url } from "../convex/lib/crypto";
import { makeT, setRole, signup, type T } from "./helpers";

const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-abcdefghijklmnop";

async function registerClient(t: T, extra: Record<string, unknown> = {}) {
  const res = await t.fetch("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost:6274/callback"], ...extra }) });
  return { status: res.status, body: (await res.json()) as { client_id: string; client_secret?: string; error?: string } };
}

async function authorize(t: T, user: Awaited<ReturnType<typeof signup>>, clientId: string, scopes: ("mcp:read" | "mcp:write" | "admin:read" | "super:read")[] = []) {
  return await user.as.mutation(api.oauth.approve, { clientId, redirectUri: "https://claude.ai/api/mcp/auth_callback", scopes, codeChallenge: await sha256Base64Url(VERIFIER), codeChallengeMethod: "S256", resource: "https://convex.automoney.test/mcp" });
}

async function exchange(t: T, o: Record<string, string>) {
  const res = await t.fetch("/oauth/token", form(o));
  return { status: res.status, body: (await res.json()) as Record<string, string | number> };
}

const mcp = async (t: T, token: string, method = "tools/list") => {
  const res = await t.fetch("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) });
  return { status: res.status, body: (await res.json()) as { result?: { tools?: { name: string }[] } }, res };
};

describe("MCP OAuth 2.1 — discovery, dynamic registration, PKCE, refresh rotation, revocation", () => {
  it("serves authorization-server and protected-resource metadata; 401 advertises resource_metadata", async () => {
    const t = makeT();
    const as = await (await t.fetch("/.well-known/oauth-authorization-server", { method: "GET" })).json();
    expect(as).toMatchObject({ issuer: "https://convex.automoney.test", authorization_endpoint: "https://app.automoney.test/oauth/authorize", token_endpoint: "https://convex.automoney.test/oauth/token", registration_endpoint: "https://convex.automoney.test/oauth/register", code_challenge_methods_supported: ["S256"] });
    const pr = await (await t.fetch("/.well-known/oauth-protected-resource/mcp", { method: "GET" })).json();
    expect(pr).toMatchObject({ resource: "https://convex.automoney.test/mcp", authorization_servers: ["https://convex.automoney.test"] });
    const unauth = await t.fetch("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toMatch(/resource_metadata="https:\/\/convex\.automoney\.test\/\.well-known\/oauth-protected-resource"/);
    expect((await t.fetch("/oauth/token", { method: "OPTIONS" })).status).toBe(204);
  });

  it("registers clients (validating redirect URIs) and runs code → token → tools/call with PKCE", async () => {
    const t = makeT();
    const user = await signup(t, "oauth1@test.com");
    const bad = await registerClient(t, { redirect_uris: ["http://evil.example.com/cb"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_redirect_uri");
    const reg = await registerClient(t);
    expect(reg.status).toBe(201);
    expect(reg.body.client_id).toMatch(/^amc_/);
    expect(reg.body.client_secret).toBeUndefined(); // 기본 public client
    const clientId = reg.body.client_id;
    expect(await user.as.query(api.oauth.clientPublic, { clientId })).toMatchObject({ clientName: "Claude" });
    // 등록 안 된 redirect_uri / 잘못된 PKCE 는 거부
    await expect(user.as.mutation(api.oauth.approve, { clientId, redirectUri: "https://other.example/cb", scopes: [], codeChallenge: await sha256Base64Url(VERIFIER), codeChallengeMethod: "S256" })).rejects.toThrow(/redirect_uri/);
    await expect(user.as.mutation(api.oauth.approve, { clientId, redirectUri: "https://claude.ai/api/mcp/auth_callback", scopes: [], codeChallenge: "plain", codeChallengeMethod: "plain" })).rejects.toThrow(/PKCE/);
    // super:read 요청은 USER 역할에서 걸러짐 → 기본 read/write
    const { code, scopes } = await authorize(t, user, clientId, ["mcp:read", "super:read"]);
    expect(scopes).toEqual(["mcp:read"]);
    // 잘못된 verifier → invalid_grant
    const wrong = await exchange(t, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: VERIFIER + "x", redirect_uri: "https://claude.ai/api/mcp/auth_callback" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    const ok = await exchange(t, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: VERIFIER, redirect_uri: "https://claude.ai/api/mcp/auth_callback" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: "Bearer", scope: "mcp:read", expires_in: 3600 });
    expect(String(ok.body.access_token)).toMatch(/^am_mcp_/);
    expect(String(ok.body.refresh_token)).toMatch(/^amr_/);
    // 코드 재사용 → 거부 + 발급 토큰 폐기
    const reuse = await exchange(t, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: VERIFIER });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await mcp(t, String(ok.body.access_token))).status).toBe(401);
    // 정상 흐름 다시: 토큰으로 tools/list (read 스코프만)
    const { code: code2 } = await authorize(t, user, clientId, ["mcp:read", "mcp:write"]);
    const tok = await exchange(t, { grant_type: "authorization_code", code: code2, client_id: clientId, code_verifier: VERIFIER });
    const list = await mcp(t, String(tok.body.access_token));
    expect(list.status).toBe(200);
    const names = list.body.result!.tools!.map((x) => x.name);
    expect(names).toContain("post_publish");
    // 대시보드 목록에 OAuth 자격증명으로 표시
    const mine = await user.as.query(api.mcp.listMine, {});
    expect(mine.credentials.some((c) => c.kind === "OAUTH" && c.label === "OAuth · Claude" && c.status === "ACTIVE")).toBe(true);
    expect(mine.oauth.serverUrl).toBe("https://convex.automoney.test/mcp");
  });

  it("rotates refresh tokens, detects reuse, honours expiry and revocation", async () => {
    const t = makeT();
    const user = await signup(t, "oauth2@test.com");
    const owner = await signup(t, "owner@automoney.test");
    await setRole(t, owner.userId, "SUPER_ADMIN");
    const reg = await registerClient(t, { token_endpoint_auth_method: "client_secret_post", client_name: "Cursor" });
    const clientId = reg.body.client_id;
    const secret = reg.body.client_secret!;
    expect(secret).toMatch(/^amcs_/);
    const { code } = await authorize(t, user, clientId, ["mcp:read", "mcp:write"]);
    // confidential client: secret 없으면 invalid_client
    expect((await exchange(t, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: VERIFIER })).status).toBe(401);
    const t1 = await exchange(t, { grant_type: "authorization_code", code, client_id: clientId, client_secret: secret, code_verifier: VERIFIER });
    expect(t1.status).toBe(200);
    // 리프레시(스코프 축소) → 새 액세스·리프레시, 이전 액세스 토큰은 무효
    const t2 = await exchange(t, { grant_type: "refresh_token", refresh_token: String(t1.body.refresh_token), client_id: clientId, client_secret: secret, scope: "mcp:read" });
    expect(t2.status).toBe(200);
    expect(t2.body.scope).toBe("mcp:read");
    expect(t2.body.access_token).not.toBe(t1.body.access_token);
    expect((await mcp(t, String(t1.body.access_token))).status).toBe(401);
    expect((await mcp(t, String(t2.body.access_token))).status).toBe(200);
    // 회전된 리프레시 토큰 재사용 → 자격증명 전체 폐기
    const reuse = await exchange(t, { grant_type: "refresh_token", refresh_token: String(t1.body.refresh_token), client_id: clientId, client_secret: secret });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await mcp(t, String(t2.body.access_token))).status).toBe(401);
    expect((await exchange(t, { grant_type: "refresh_token", refresh_token: String(t2.body.refresh_token), client_id: clientId, client_secret: secret })).body.error).toBe("invalid_grant");
    // 액세스 토큰 만료 시뮬레이션
    const { code: c3 } = await authorize(t, user, clientId);
    const t3 = await exchange(t, { grant_type: "authorization_code", code: c3, client_id: clientId, client_secret: secret, code_verifier: VERIFIER });
    await t.run(async (ctx) => {
      const cred = (await ctx.db.query("mcpCredentials").collect()).find((c) => c.status === "ACTIVE" && c.kind === "OAUTH")!;
      await ctx.db.patch(cred._id, { expiresAt: Date.now() - 1 });
    });
    expect((await mcp(t, String(t3.body.access_token))).status).toBe(401);
    const t4 = await exchange(t, { grant_type: "refresh_token", refresh_token: String(t3.body.refresh_token), client_id: clientId, client_secret: secret });
    expect(t4.status).toBe(200);
    expect((await mcp(t, String(t4.body.access_token))).status).toBe(200);
    // RFC 7009 폐기: 리프레시 토큰으로 → 액세스도 무효, 모르는 토큰도 200
    expect((await t.fetch("/oauth/revoke", form({ token: String(t4.body.refresh_token), client_id: clientId }))).status).toBe(200);
    expect((await mcp(t, String(t4.body.access_token))).status).toBe(401);
    expect((await t.fetch("/oauth/revoke", form({ token: "nope" }))).status).toBe(200);
    // 대시보드 폐기도 동일하게 401
    const { code: c5 } = await authorize(t, user, clientId);
    const t5 = await exchange(t, { grant_type: "authorization_code", code: c5, client_id: clientId, client_secret: secret, code_verifier: VERIFIER });
    const cred = (await user.as.query(api.mcp.listMine, {})).credentials.find((c) => c.kind === "OAUTH" && c.status === "ACTIVE")!;
    await user.as.mutation(api.mcp.revoke, { credentialId: cred._id });
    expect((await mcp(t, String(t5.body.access_token))).status).toBe(401);
    // 감사 기록
    const audits = await t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).map((a) => a.action));
    for (const a of ["oauth.client.register", "oauth.authorize", "oauth.token.issue", "oauth.refresh.reuse_detected", "oauth.token.revoke"]) expect(audits).toContain(a);
  });
});
