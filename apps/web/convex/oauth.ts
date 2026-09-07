import { v } from "convex/values";
import { MCP_KEY_PREFIX, MCP_OAUTH, MCP_SCOPES, allowedScopesForRole, generateCode, isAllowedRedirectUri } from "@automoney/shared";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { sha256Base64Url, sha256Hex } from "./lib/crypto";
import { fail } from "./lib/errors";
import { requireUser, roleOf } from "./lib/rbac";

/**
 * MCP 용 OAuth 2.1 인가 서버 (ADR-0007 후속).
 * - 동적 클라이언트 등록(RFC 7591) · PKCE S256 필수 · 리프레시 토큰 회전 · 토큰 폐기(RFC 7009)
 * - 액세스 토큰은 `mcpCredentials`(kind=OAUTH) 의 keyHash 로 저장되어 API 키와 같은 인증 경로를 탄다.
 * - 인가 화면은 웹(`${SITE_URL}/oauth/authorize`), 토큰·등록·메타데이터는 Convex HTTP.
 */

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const scopeValidator = v.union(v.literal("mcp:read"), v.literal("mcp:write"), v.literal("admin:read"), v.literal("super:read"));

function convexSite(): string {
  return process.env.CONVEX_SITE_URL ?? "";
}
function webSite(): string {
  return process.env.SITE_URL ?? "";
}

export function oauthMetadata() {
  const issuer = convexSite();
  return {
    issuer,
    authorization_endpoint: `${webSite()}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...MCP_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: `${webSite()}/dashboard/mcp`,
  };
}

export function protectedResourceMetadata() {
  const issuer = convexSite();
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: [...MCP_SCOPES], bearer_methods_supported: ["header"], resource_name: "automoney MCP" };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version" };
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...headers } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));
export const authServerMetadata = httpAction(async () => json(oauthMetadata()));
export const resourceMetadata = httpAction(async () => json(protectedResourceMetadata()));

// ─────────────────────────── 클라이언트 등록 (DCR) ───────────────────────────

export const registerClient = internalMutation({
  args: { clientName: v.string(), redirectUris: v.array(v.string()), tokenEndpointAuthMethod: v.union(v.literal("none"), v.literal("client_secret_post")), clientUri: v.optional(v.string()), logoUri: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const clientId = `amc_${generateCode(24, ALNUM)}`;
    const secret = args.tokenEndpointAuthMethod === "client_secret_post" ? `amcs_${generateCode(40, ALNUM)}` : undefined;
    await ctx.db.insert("oauthClients", {
      clientId,
      clientName: args.clientName,
      redirectUris: args.redirectUris,
      tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
      clientSecretHash: secret ? await sha256Hex(secret) : undefined,
      clientUri: args.clientUri,
      logoUri: args.logoUri,
      createdAt: Date.now(),
    });
    await audit(ctx, { action: "oauth.client.register", metadata: { clientId, clientName: args.clientName, redirectUris: args.redirectUris } });
    return { clientId, clientSecret: secret };
  },
});

export const register = httpAction(async (ctx, request) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "body must be JSON");
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (redirectUris.length === 0 || redirectUris.length > MCP_OAUTH.maxRedirectUris) return oauthError("invalid_redirect_uri", "redirect_uris required (1-10)");
  for (const u of redirectUris) if (!isAllowedRedirectUri(u)) return oauthError("invalid_redirect_uri", `redirect_uri not allowed: ${u}`);
  const method = body.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";
  const grants = Array.isArray(body.grant_types) ? (body.grant_types as unknown[]) : ["authorization_code"];
  if (!grants.includes("authorization_code")) return oauthError("invalid_client_metadata", "authorization_code grant required");
  const clientName = (typeof body.client_name === "string" && body.client_name.trim().slice(0, 80)) || "MCP client";
  const str = (k: string) => (typeof body[k] === "string" && /^https?:\/\//.test(body[k] as string) ? (body[k] as string).slice(0, 300) : undefined);
  const { clientId, clientSecret } = await ctx.runMutation(internal.oauth.registerClient, { clientName, redirectUris, tokenEndpointAuthMethod: method, clientUri: str("client_uri"), logoUri: str("logo_uri") });
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: MCP_SCOPES.join(" "),
    },
    201,
  );
});

// ─────────────────────────── 인가 (웹 동의 화면이 호출) ───────────────────────────

/** 동의 화면 렌더용 공개 정보. 등록되지 않은 클라이언트면 null. */
export const clientPublic = query({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db.query("oauthClients").withIndex("by_clientId", (q) => q.eq("clientId", args.clientId)).unique();
    if (!c) return null;
    return { clientId: c.clientId, clientName: c.clientName, clientUri: c.clientUri ?? null, logoUri: c.logoUri ?? null, redirectUris: c.redirectUris };
  },
});

/** 로그인한 유저가 동의 → 인가 코드 발급. 스코프는 요청 ∩ 역할 허용(요청 없으면 기본 read/write). */
export const approve = mutation({
  args: { clientId: v.string(), redirectUri: v.string(), scopes: v.array(scopeValidator), codeChallenge: v.string(), codeChallengeMethod: v.string(), resource: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const client = await ctx.db.query("oauthClients").withIndex("by_clientId", (q) => q.eq("clientId", args.clientId)).unique();
    if (!client) fail("NOT_FOUND", "등록되지 않은 클라이언트입니다.");
    if (!client.redirectUris.includes(args.redirectUri)) fail("INVALID_ARGUMENT", "등록되지 않은 redirect_uri 입니다.");
    if (args.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(args.codeChallenge)) fail("INVALID_ARGUMENT", "PKCE S256 code_challenge 가 필요합니다.");
    const allowed = allowedScopesForRole(roleOf(user));
    const requested = args.scopes.length > 0 ? args.scopes : MCP_OAUTH.defaultScopes;
    const scopes = [...new Set(requested)].filter((s) => allowed.includes(s));
    if (scopes.length === 0) fail("FORBIDDEN", "현재 역할로 허용되는 스코프가 없습니다.");
    const code = generateCode(48, ALNUM);
    await ctx.db.insert("oauthCodes", { codeHash: await sha256Hex(code), clientId: client.clientId, userId: user._id, redirectUri: args.redirectUri, scopes, codeChallenge: args.codeChallenge, resource: args.resource, expiresAt: Date.now() + MCP_OAUTH.codeTtlMs, createdAt: Date.now() });
    await ctx.db.patch(client._id, { lastUsedAt: Date.now() });
    await audit(ctx, { actorUserId: user._id, action: "oauth.authorize", metadata: { clientId: client.clientId, scopes } });
    return { code, scopes };
  },
});

// ─────────────────────────── 토큰 발급 · 회전 · 폐기 ───────────────────────────

type TokenResult = { error: string; description: string; status: number } | { ok: true; accessToken: string; refreshToken: string; expiresIn: number; scope: string; credentialId: Id<"mcpCredentials"> };

async function issueTokens(ctx: { db: import("./_generated/server").DatabaseWriter }, opts: { userId: Id<"users">; client: Doc<"oauthClients">; scopes: string[]; existing?: Doc<"mcpCredentials"> }) {
  const now = Date.now();
  const accessToken = `${MCP_KEY_PREFIX}${generateCode(40, ALNUM)}`;
  const refreshToken = `amr_${generateCode(48, ALNUM)}`;
  let credentialId: Id<"mcpCredentials">;
  if (opts.existing) {
    credentialId = opts.existing._id;
    await ctx.db.patch(credentialId, { keyHash: await sha256Hex(accessToken), expiresAt: now + MCP_OAUTH.accessTtlMs });
  } else {
    credentialId = await ctx.db.insert("mcpCredentials", {
      userId: opts.userId,
      endpointId: generateCode(16, ALNUM),
      secretHash: await sha256Hex(generateCode(32, ALNUM)), // 경로 인증은 쓰지 않지만 스키마 필수 — 평문은 버린다
      keyHash: await sha256Hex(accessToken),
      label: `OAuth · ${opts.client.clientName}`,
      scopes: opts.scopes,
      status: "ACTIVE",
      callCount: 0,
      createdAt: now,
      kind: "OAUTH",
      clientId: opts.client.clientId,
      expiresAt: now + MCP_OAUTH.accessTtlMs,
    });
  }
  await ctx.db.insert("oauthRefreshTokens", { tokenHash: await sha256Hex(refreshToken), credentialId, clientId: opts.client.clientId, userId: opts.userId, status: "ACTIVE", expiresAt: now + MCP_OAUTH.refreshTtlMs, createdAt: now });
  return { accessToken, refreshToken, expiresIn: Math.floor(MCP_OAUTH.accessTtlMs / 1000), scope: opts.scopes.join(" "), credentialId };
}

export const exchangeCode = internalMutation({
  args: { codeHash: v.string(), clientId: v.string(), clientSecretHash: v.optional(v.string()), redirectUri: v.optional(v.string()), codeVerifierChallenge: v.string() },
  handler: async (ctx, args) => {
    const client = await ctx.db.query("oauthClients").withIndex("by_clientId", (q) => q.eq("clientId", args.clientId)).unique();
    if (!client) return { error: "invalid_client", description: "unknown client_id", status: 401 } as const;
    if (client.tokenEndpointAuthMethod === "client_secret_post" && client.clientSecretHash !== args.clientSecretHash) return { error: "invalid_client", description: "bad client_secret", status: 401 } as const;
    const row = await ctx.db.query("oauthCodes").withIndex("by_codeHash", (q) => q.eq("codeHash", args.codeHash)).unique();
    if (!row || row.clientId !== client.clientId) return { error: "invalid_grant", description: "unknown code", status: 400 } as const;
    if (row.usedAt) {
      // 코드 재사용 → 해당 코드로 발급된 토큰 전부 폐기 (RFC 6749 §4.1.2)
      const creds = await ctx.db.query("mcpCredentials").withIndex("by_user", (q) => q.eq("userId", row.userId)).collect();
      for (const c of creds) if (c.kind === "OAUTH" && c.clientId === client.clientId && c.status === "ACTIVE" && c.createdAt >= row.usedAt) await ctx.db.patch(c._id, { status: "REVOKED", revokedAt: Date.now() });
      return { error: "invalid_grant", description: "code already used", status: 400 } as const;
    }
    if (row.expiresAt < Date.now()) return { error: "invalid_grant", description: "code expired", status: 400 } as const;
    if (args.redirectUri && args.redirectUri !== row.redirectUri) return { error: "invalid_grant", description: "redirect_uri mismatch", status: 400 } as const;
    if (row.codeChallenge !== args.codeVerifierChallenge) return { error: "invalid_grant", description: "PKCE verification failed", status: 400 } as const;
    const user = await ctx.db.get(row.userId);
    if (!user || (user.status ?? "ACTIVE") !== "ACTIVE") return { error: "invalid_grant", description: "user unavailable", status: 400 } as const;
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    const tokens = await issueTokens(ctx, { userId: row.userId, client, scopes: row.scopes });
    await audit(ctx, { actorUserId: row.userId, action: "oauth.token.issue", metadata: { clientId: client.clientId, credentialId: tokens.credentialId, scopes: row.scopes } });
    return { ok: true, ...tokens } as const;
  },
});

export const refresh = internalMutation({
  args: { refreshHash: v.string(), clientId: v.string(), clientSecretHash: v.optional(v.string()), scopes: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const client = await ctx.db.query("oauthClients").withIndex("by_clientId", (q) => q.eq("clientId", args.clientId)).unique();
    if (!client) return { error: "invalid_client", description: "unknown client_id", status: 401 } as const;
    if (client.tokenEndpointAuthMethod === "client_secret_post" && client.clientSecretHash !== args.clientSecretHash) return { error: "invalid_client", description: "bad client_secret", status: 401 } as const;
    const rt = await ctx.db.query("oauthRefreshTokens").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.refreshHash)).unique();
    if (!rt || rt.clientId !== client.clientId) return { error: "invalid_grant", description: "unknown refresh_token", status: 400 } as const;
    const cred = await ctx.db.get(rt.credentialId);
    if (rt.status !== "ACTIVE") {
      // 회전된 토큰 재사용 = 탈취 신호 → 자격증명 전체 폐기
      if (cred && cred.status === "ACTIVE") await ctx.db.patch(cred._id, { status: "REVOKED", revokedAt: Date.now() });
      for (const t of await ctx.db.query("oauthRefreshTokens").withIndex("by_credential", (q) => q.eq("credentialId", rt.credentialId)).collect()) if (t.status === "ACTIVE") await ctx.db.patch(t._id, { status: "REVOKED" });
      await audit(ctx, { actorUserId: rt.userId, action: "oauth.refresh.reuse_detected", metadata: { clientId: client.clientId, credentialId: rt.credentialId } });
      return { error: "invalid_grant", description: "refresh_token reused; credential revoked", status: 400 } as const;
    }
    if (rt.expiresAt < Date.now()) return { error: "invalid_grant", description: "refresh_token expired", status: 400 } as const;
    if (!cred || cred.status !== "ACTIVE") return { error: "invalid_grant", description: "credential revoked", status: 400 } as const;
    const user = await ctx.db.get(cred.userId);
    if (!user || (user.status ?? "ACTIVE") !== "ACTIVE") return { error: "invalid_grant", description: "user unavailable", status: 400 } as const;
    // 스코프 축소만 허용
    const scopes = args.scopes && args.scopes.length > 0 ? cred.scopes.filter((s) => args.scopes!.includes(s)) : cred.scopes;
    if (scopes.length === 0) return { error: "invalid_scope", description: "requested scope exceeds grant", status: 400 } as const;
    await ctx.db.patch(rt._id, { status: "ROTATED" });
    if (scopes.length !== cred.scopes.length) await ctx.db.patch(cred._id, { scopes });
    const tokens = await issueTokens(ctx, { userId: cred.userId, client, scopes, existing: cred });
    return { ok: true, ...tokens } as const;
  },
});

export const revokeToken = internalMutation({
  args: { tokenHash: v.string(), clientId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const revokeCredential = async (id: Id<"mcpCredentials">) => {
      const c = await ctx.db.get(id);
      if (c && c.status === "ACTIVE") await ctx.db.patch(id, { status: "REVOKED", revokedAt: now });
      for (const t of await ctx.db.query("oauthRefreshTokens").withIndex("by_credential", (q) => q.eq("credentialId", id)).collect()) if (t.status === "ACTIVE") await ctx.db.patch(t._id, { status: "REVOKED" });
      if (c) await audit(ctx, { actorUserId: c.userId, action: "oauth.token.revoke", metadata: { credentialId: id, clientId: args.clientId } });
    };
    const rt = await ctx.db.query("oauthRefreshTokens").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    if (rt && (!args.clientId || rt.clientId === args.clientId)) return await revokeCredential(rt.credentialId);
    const cred = await ctx.db.query("mcpCredentials").withIndex("by_keyHash", (q) => q.eq("keyHash", args.tokenHash)).unique();
    if (cred && cred.kind === "OAUTH" && (!args.clientId || cred.clientId === args.clientId)) return await revokeCredential(cred._id);
  },
});

async function formOrJson(request: Request): Promise<Record<string, string>> {
  const ct = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (ct.includes("application/json")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string") as [string, string][]);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text).entries());
}

/** client_id 는 본문 또는 HTTP Basic 에서, client_secret 도 동일 */
function clientAuth(request: Request, body: Record<string, string>): { clientId?: string; clientSecret?: string } {
  const h = request.headers.get("authorization") ?? "";
  if (h.startsWith("Basic ")) {
    try {
      const [id, secret] = atob(h.slice(6)).split(":");
      return { clientId: decodeURIComponent(id ?? ""), clientSecret: secret ? decodeURIComponent(secret) : undefined };
    } catch {
      /* fallthrough */
    }
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

export const token = httpAction(async (ctx, request) => {
  const body = await formOrJson(request);
  const { clientId, clientSecret } = clientAuth(request, body);
  if (!clientId) return oauthError("invalid_client", "client_id required", 401);
  const clientSecretHash = clientSecret ? await sha256Hex(clientSecret) : undefined;
  let result: TokenResult;
  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier) return oauthError("invalid_request", "code and code_verifier required");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) return oauthError("invalid_grant", "malformed code_verifier");
    result = await ctx.runMutation(internal.oauth.exchangeCode, { codeHash: await sha256Hex(body.code), clientId, clientSecretHash, redirectUri: body.redirect_uri || undefined, codeVerifierChallenge: await sha256Base64Url(body.code_verifier) });
  } else if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) return oauthError("invalid_request", "refresh_token required");
    result = await ctx.runMutation(internal.oauth.refresh, { refreshHash: await sha256Hex(body.refresh_token), clientId, clientSecretHash, scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : undefined });
  } else {
    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }
  if ("error" in result) return oauthError(result.error, result.description, result.status);
  return json({ access_token: result.accessToken, token_type: "Bearer", expires_in: result.expiresIn, refresh_token: result.refreshToken, scope: result.scope });
});

export const revoke = httpAction(async (ctx, request) => {
  const body = await formOrJson(request);
  const { clientId } = clientAuth(request, body);
  if (body.token) await ctx.runMutation(internal.oauth.revokeToken, { tokenHash: await sha256Hex(body.token), clientId: clientId || undefined });
  return new Response(null, { status: 200, headers: CORS }); // RFC 7009: 모르는 토큰도 200
});

/** 인증 조회에 쓰는 만료 확인(테스트·mcp.ts 공용) */
export const isCredentialUsable = (c: Doc<"mcpCredentials">, now = Date.now()) => c.status === "ACTIVE" && (c.expiresAt === undefined || c.expiresAt > now);
