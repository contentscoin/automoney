import { httpRouter } from "convex/server";
import { WEBHOOK_REPLAY_WINDOW_MS } from "@automoney/shared";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { claim, config, jobsRouter, spacesSync } from "./agent";
import { webhook as telegramWebhook } from "./telegram";
import { mcpHttp } from "./mcp";
import { authServerMetadata, preflight, register as oauthRegister, resourceMetadata, revoke as oauthRevoke, token as oauthToken } from "./oauth";
import { callback as metaCallback } from "./meta";
import { hmacSha256Hex, timingSafeEqual } from "./lib/crypto";

const http = httpRouter();
auth.addHttpRoutes(http);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * 아뜨랑스 주문 웹훅 (docs/04-integrations.md §1.3).
 * 서명: X-Attrangs-Signature: sha256={HMAC(secret, timestamp + "." + body)}, X-Attrangs-Timestamp(ms).
 */
export const attrangsWebhook = httpAction(async (ctx, request) => {
  const secret = process.env.ATTRANGS_WEBHOOK_SECRET;
  if (!secret) return json({ success: false, error: { code: "CONFIG_MISSING", message: "webhook secret not configured" } }, 500);

  const signature = request.headers.get("x-attrangs-signature") ?? "";
  const timestamp = request.headers.get("x-attrangs-timestamp") ?? "";
  const body = await request.text();
  if (body.length > 256_000) return json({ success: false, error: { code: "INVALID_ARGUMENT", message: "body too large" } }, 413);

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WEBHOOK_REPLAY_WINDOW_MS) {
    return json({ success: false, error: { code: "ATTRANGS_WEBHOOK_SIGNATURE_INVALID", message: "stale or missing timestamp" } }, 401);
  }
  const expected = `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
  if (!timingSafeEqual(expected, signature)) {
    return json({ success: false, error: { code: "ATTRANGS_WEBHOOK_SIGNATURE_INVALID", message: "bad signature" } }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ success: false, error: { code: "INVALID_ARGUMENT", message: "invalid json" } }, 400);
  }
  const result = await ctx.runMutation(internal.orders.ingest, { payload });
  if (!result.accepted) return json({ success: false, error: { code: "INVALID_ARGUMENT", message: result.reason } }, 400);
  return json({ success: true, data: { duplicate: result.duplicate } });
});

http.route({ path: "/partner/attrangs/webhook", method: "POST", handler: attrangsWebhook });

// 데스크톱 에이전트 (Bearer 디바이스 토큰)
http.route({ path: "/agent/claim", method: "POST", handler: claim });
http.route({ path: "/agent/config", method: "GET", handler: config });
http.route({ path: "/agent/spaces/sync", method: "POST", handler: spacesSync });
http.route({ pathPrefix: "/agent/jobs/", method: "POST", handler: jobsRouter });

// Meta OAuth 콜백 (Threads · Instagram)
http.route({ path: "/meta/callback", method: "GET", handler: metaCallback });

// Stateless MCP (POST /mcp 또는 /mcp/{endpointId}.{secret}; GET 은 안내)
http.route({ path: "/mcp", method: "POST", handler: mcpHttp });
http.route({ path: "/mcp", method: "GET", handler: mcpHttp });
http.route({ pathPrefix: "/mcp/", method: "POST", handler: mcpHttp });
http.route({ pathPrefix: "/mcp/", method: "GET", handler: mcpHttp });

// MCP OAuth 2.1 (메타데이터 · 동적 등록 · 토큰 · 폐기). 인가 화면은 웹 /oauth/authorize
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: authServerMetadata });
http.route({ path: "/.well-known/oauth-authorization-server/mcp", method: "GET", handler: authServerMetadata });
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: resourceMetadata });
http.route({ path: "/.well-known/oauth-protected-resource/mcp", method: "GET", handler: resourceMetadata });
http.route({ path: "/oauth/register", method: "POST", handler: oauthRegister });
http.route({ path: "/oauth/token", method: "POST", handler: oauthToken });
http.route({ path: "/oauth/revoke", method: "POST", handler: oauthRevoke });
for (const path of ["/mcp", "/oauth/register", "/oauth/token", "/oauth/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) http.route({ path, method: "OPTIONS", handler: preflight });

// 텔레그램 봇 웹훅 (X-Telegram-Bot-Api-Secret-Token 검증)
http.route({ path: "/telegram/webhook", method: "POST", handler: telegramWebhook });

export default http;
