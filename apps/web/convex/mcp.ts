import { v } from "convex/values";
import { ConvexError } from "convex/values";
import {
  MCP_ENDPOINT_ID_LENGTH,
  MCP_KEY_PREFIX,
  MCP_PATH_RE,
  MCP_PROTOCOL_VERSION,
  MCP_RATE_LIMITS,
  MCP_SCOPES,
  MCP_SECRET_LENGTH,
  MCP_SERVER_INFO,
  MCP_TOOL_MAP,
  allowedScopesForRole,
  generateCode,
  validateToolArgs,
  visibleTools,
  type McpScope,
} from "@automoney/shared";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { sha256Hex } from "./lib/crypto";
import { fail } from "./lib/errors";
import { requireUser, roleOf } from "./lib/rbac";
import { issueLinkFor } from "./links";
import { runMcpTool } from "./lib/mcpTools";

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const scopeValidator = v.union(v.literal("mcp:read"), v.literal("mcp:write"), v.literal("admin:read"), v.literal("super:read"));

// ─────────────────────────── 자격증명 관리 (대시보드) ───────────────────────────

/** 자격증명 발급: 시크릿·키는 이 응답에서만 평문으로 반환된다. */
export const createCredential = mutation({
  args: { label: v.string(), scopes: v.array(scopeValidator) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const label = args.label.trim().slice(0, 60);
    if (!label) fail("INVALID_ARGUMENT", "이름을 입력하세요.");
    const allowed = allowedScopesForRole(roleOf(user));
    const scopes = [...new Set(args.scopes)].filter((s) => MCP_SCOPES.includes(s));
    if (scopes.length === 0) fail("INVALID_ARGUMENT", "스코프를 하나 이상 선택하세요.");
    for (const s of scopes) if (!allowed.includes(s)) fail("FORBIDDEN", `현재 역할로는 ${s} 스코프를 발급할 수 없습니다.`);
    const active = await ctx.db.query("mcpCredentials").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    if (active.filter((c) => c.status === "ACTIVE").length >= 10) fail("CONFLICT", "활성 자격증명은 최대 10개입니다.");
    let endpointId = "";
    for (let i = 0; i < 5; i++) {
      const cand = generateCode(MCP_ENDPOINT_ID_LENGTH, ALNUM);
      if (!(await ctx.db.query("mcpCredentials").withIndex("by_endpointId", (q) => q.eq("endpointId", cand)).unique())) {
        endpointId = cand;
        break;
      }
    }
    if (!endpointId) fail("CONFLICT", "엔드포인트 ID 생성에 실패했습니다.");
    const secret = generateCode(MCP_SECRET_LENGTH, ALNUM);
    const key = `${MCP_KEY_PREFIX}${generateCode(40, ALNUM)}`;
    const id = await ctx.db.insert("mcpCredentials", {
      userId: user._id,
      endpointId,
      secretHash: await sha256Hex(secret),
      keyHash: await sha256Hex(key),
      label,
      scopes,
      status: "ACTIVE",
      callCount: 0,
      createdAt: Date.now(),
    });
    await audit(ctx, { actorUserId: user._id, action: "mcp.credential.create", metadata: { credentialId: id, scopes, label } });
    const site = process.env.CONVEX_SITE_URL ?? process.env.SITE_URL ?? "";
    return { credentialId: id, endpointId, endpointUrl: `${site}/mcp/${endpointId}.${secret}`, bearerUrl: `${site}/mcp`, apiKey: key, scopes };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const rows = await ctx.db.query("mcpCredentials").withIndex("by_user", (q) => q.eq("userId", user._id)).order("desc").collect();
    return {
      allowedScopes: allowedScopesForRole(roleOf(user)),
      credentials: rows.map((c) => ({ _id: c._id, endpointId: c.endpointId, label: c.label, scopes: c.scopes, status: c.status, lastUsedAt: c.lastUsedAt ?? null, callCount: c.callCount, createdAt: c.createdAt, revokedAt: c.revokedAt ?? null })),
    };
  },
});

export const revoke = mutation({
  args: { credentialId: v.id("mcpCredentials") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const c = await ctx.db.get(args.credentialId);
    if (!c || c.userId !== user._id) fail("NOT_FOUND", "자격증명을 찾을 수 없습니다.");
    if (c.status === "REVOKED") return;
    await ctx.db.patch(c._id, { status: "REVOKED", revokedAt: Date.now() });
    await audit(ctx, { actorUserId: user._id, action: "mcp.credential.revoke", metadata: { credentialId: c._id } });
  },
});

// ─────────────────────────── 내부: 인증 · 레이트리밋 · 실행 ───────────────────────────

export const authenticate = internalQuery({
  args: { endpointId: v.optional(v.string()), secretHash: v.optional(v.string()), keyHash: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let c = null;
    if (args.endpointId && args.secretHash) {
      c = await ctx.db.query("mcpCredentials").withIndex("by_endpointId", (q) => q.eq("endpointId", args.endpointId!)).unique();
      if (c && c.secretHash !== args.secretHash) c = null;
    } else if (args.keyHash) {
      c = await ctx.db.query("mcpCredentials").withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash!)).unique();
    }
    if (!c || c.status !== "ACTIVE") return null;
    const u = await ctx.db.get(c.userId);
    if (!u || (u.status ?? "ACTIVE") !== "ACTIVE") return null;
    // 역할이 낮아진 경우 스코프를 현재 역할 범위로 축소
    const allowed = allowedScopesForRole(roleOf(u));
    return { credentialId: c._id, userId: u._id, scopes: c.scopes.filter((s) => allowed.includes(s as McpScope)) };
  },
});

/** 고정 창(1분) 카운터. 초과 시 false. */
export const bumpRate = internalMutation({
  args: { keys: v.array(v.object({ key: v.string(), limit: v.number() })) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    let limited: string | null = null;
    for (const { key, limit } of args.keys) {
      const row = await ctx.db.query("mcpRateBuckets").withIndex("by_key", (q) => q.eq("key", key)).unique();
      if (!row || row.windowStart !== windowStart) {
        if (row) await ctx.db.patch(row._id, { windowStart, count: 1 });
        else await ctx.db.insert("mcpRateBuckets", { key, windowStart, count: 1 });
        continue;
      }
      if (row.count >= limit) {
        limited = key;
        continue;
      }
      await ctx.db.patch(row._id, { count: row.count + 1 });
    }
    return { ok: limited === null, limitedKey: limited, retryAfterSec: Math.ceil((windowStart + 60_000 - now) / 1000) };
  },
});

export const callTool = internalMutation({
  args: { credentialId: v.id("mcpCredentials"), tool: v.string(), args: v.any() },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.credentialId);
    if (!c || c.status !== "ACTIVE") fail("UNAUTHENTICATED", "credential revoked");
    const user = await ctx.db.get(c.userId);
    if (!user) fail("UNAUTHENTICATED", "user missing");
    const allowed = allowedScopesForRole(roleOf(user));
    const scopes = c.scopes.filter((s) => allowed.includes(s as McpScope));
    await ctx.db.patch(c._id, { lastUsedAt: Date.now(), callCount: c.callCount + 1 });
    return await runMcpTool(ctx, { credentialId: c._id, user, scopes }, args.tool, args.args);
  },
});

export const touchCredential = internalMutation({
  args: { credentialId: v.id("mcpCredentials"), tool: v.string(), metadata: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.credentialId);
    if (!c) return;
    await ctx.db.patch(c._id, { lastUsedAt: Date.now(), callCount: c.callCount + 1 });
    await audit(ctx, { actorUserId: c.userId, action: `mcp.${args.tool}`, metadata: { credentialId: c._id, ...(args.metadata ?? {}) } });
  },
});

// ─────────────────────────── HTTP: Streamable HTTP(POST 전용, stateless) ───────────────────────────

type RpcId = string | number | null;
const rpcError = (id: RpcId, code: number, message: string, data?: unknown, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const rpcResult = (id: RpcId, result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function toolError(e: unknown): { code: string; message: string } {
  if (e instanceof ConvexError) {
    const d = e.data as { code?: string; message?: string } | string;
    if (typeof d === "object" && d) return { code: d.code ?? "INTERNAL", message: d.message ?? "error" };
    return { code: "INTERNAL", message: String(d) };
  }
  return { code: "INTERNAL", message: (e as Error)?.message ?? "error" };
}

export const mcpHttp = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  if (request.method === "GET") {
    return new Response(JSON.stringify({ name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version, protocolVersion: MCP_PROTOCOL_VERSION, transport: "streamable-http (POST only, stateless)", auth: ["path: /mcp/{endpointId}.{secret}", `header: Authorization: Bearer ${MCP_KEY_PREFIX}...`], tools: visibleTools(MCP_SCOPES).map((t) => t.name) }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });

  // 1) 인증
  let authArgs: { endpointId?: string; secretHash?: string; keyHash?: string } | null = null;
  const m = MCP_PATH_RE.exec(url.pathname);
  const bearer = request.headers.get("authorization") ?? "";
  if (m) authArgs = { endpointId: m[1]!, secretHash: await sha256Hex(m[2]!) };
  else if (url.pathname === "/mcp" && bearer.startsWith(`Bearer ${MCP_KEY_PREFIX}`)) authArgs = { keyHash: await sha256Hex(bearer.slice(7).trim()) };
  if (!authArgs) return rpcError(null, -32001, "unauthorized: use /mcp/{endpointId}.{secret} or Authorization: Bearer am_mcp_...", undefined, 401);
  const cred = await ctx.runQuery(internal.mcp.authenticate, authArgs);
  if (!cred) return rpcError(null, -32001, "unauthorized: invalid or revoked credential", undefined, 401);

  // 2) 레이트리밋 (유저 120/min, IP 600/min)
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
  const rate = await ctx.runMutation(internal.mcp.bumpRate, { keys: [{ key: `u:${cred.credentialId}`, limit: MCP_RATE_LIMITS.perUserPerMinute }, { key: `ip:${ip}`, limit: MCP_RATE_LIMITS.perIpPerMinute }] });
  if (!rate.ok) {
    const res = rpcError(null, -32029, "rate limited", { code: "RATE_LIMITED", retryAfterSec: rate.retryAfterSec }, 429);
    res.headers.set("retry-after", String(rate.retryAfterSec));
    return res;
  }

  // 3) JSON-RPC
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 256_000) return rpcError(null, -32600, "request too large", undefined, 413);
    body = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "parse error", undefined, 400);
  }
  if (Array.isArray(body)) return rpcError(null, -32600, "batch requests are not supported", undefined, 400);
  const req = (body ?? {}) as { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> };
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return rpcError(req.id ?? null, -32600, "invalid request", undefined, 400);
  const id = req.id ?? null;
  const params = req.params ?? {};

  switch (req.method) {
    case "initialize":
      return rpcResult(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO, instructions: "automoney 파트너 툴. write 툴은 잡 id 를 반환하며 job_get 으로 결과를 폴링하세요. post_publish·space_create 는 confirmed=true 가 필요합니다." });
    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202 });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: visibleTools(cred.scopes).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = MCP_TOOL_MAP[name];
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      if (!cred.scopes.includes(tool.scope)) return rpcError(id, -32003, `scope ${tool.scope} required`, { code: "FORBIDDEN" });
      const bad = validateToolArgs(tool, params.arguments);
      if (bad) return rpcError(id, -32602, bad, { code: "INVALID_ARGUMENT" });
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        let result: unknown;
        if (name === "link_issue") {
          result = await issueLinkFor(ctx, cred.userId, args.productId as Id<"products">);
          const r = result as { shortCode: string };
          result = { ...r, shortUrl: `${process.env.SITE_URL ?? ""}/r/${r.shortCode}` };
          await ctx.runMutation(internal.mcp.touchCredential, { credentialId: cred.credentialId, tool: name, metadata: { productId: args.productId } });
        } else {
          result = await ctx.runMutation(internal.mcp.callTool, { credentialId: cred.credentialId, tool: name, args });
        }
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (e) {
        const err = toolError(e);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: err }) }], structuredContent: { error: err }, isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${req.method}`);
  }
});
