import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT, seedProduct, setRole, signup, type T } from "./helpers";

type Rpc = { jsonrpc: "2.0"; id: number; result?: Record<string, unknown> & { tools?: { name: string }[]; serverInfo?: { name: string }; structuredContent?: unknown; isError?: boolean }; error?: { code: number; message: string; data?: { code?: string } } };

function client(t: T, url: string, headers: Record<string, string> = {}) {
  let id = 0;
  return async (method: string, params?: unknown): Promise<{ status: number; body: Rpc | null; res: Response }> => {
    const res = await t.fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Rpc) : null, res };
  };
}
const tool = async (call: ReturnType<typeof client>, name: string, args: unknown = {}) => {
  const r = await call("tools/call", { name, arguments: args });
  return { status: r.status, rpc: r.body, result: r.body?.result?.structuredContent, isError: r.body?.result?.isError as boolean | undefined };
};

async function pairDevice(t: T, user: Awaited<ReturnType<typeof signup>>) {
  const { code } = await user.as.mutation(api.devices.createPairCode, {});
  return await t.mutation(api.devices.pair, { code, deviceName: "PC", platform: "linux", appVersion: "0.1.0" });
}

describe("stateless MCP server", () => {
  it("issues credentials with role-bounded scopes and lists/revokes them", async () => {
    const t = makeT();
    const user = await signup(t, "mcp1@test.com");
    await expect(user.as.mutation(api.mcp.createCredential, { label: "x", scopes: ["super:read"] })).rejects.toThrow(/스코프/);
    const c = await user.as.mutation(api.mcp.createCredential, { label: "Claude", scopes: ["mcp:read", "mcp:write"] });
    expect(c.endpointUrl).toMatch(/\/mcp\/[A-Za-z0-9]{16}\.[A-Za-z0-9]{32}$/);
    expect(c.apiKey.startsWith("am_mcp_")).toBe(true);
    const mine = await user.as.query(api.mcp.listMine, {});
    expect(mine.credentials).toHaveLength(1);
    expect(mine.allowedScopes).toEqual(["mcp:read", "mcp:write"]);
    await user.as.mutation(api.mcp.revoke, { credentialId: c.credentialId });
    expect((await user.as.query(api.mcp.listMine, {})).credentials[0]!.status).toBe("REVOKED");
    const call = client(t, new URL(c.endpointUrl).pathname);
    expect((await call("initialize")).status).toBe(401);
  });

  it("handles initialize / tools/list / tools/call over JSON-RPC with path secret and bearer key", async () => {
    const t = makeT();
    const user = await signup(t, "mcp2@test.com");
    const c = await user.as.mutation(api.mcp.createCredential, { label: "Cursor", scopes: ["mcp:read"] });
    const path = client(t, new URL(c.endpointUrl).pathname);
    const init = await path("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.status).toBe(200);
    expect(init.body!.result!.serverInfo!.name).toBe("automoney");
    expect((await path("notifications/initialized")).status).toBe(202);
    expect((await path("ping")).body!.result).toEqual({});
    const list = await path("tools/list");
    const names = list.body!.result!.tools!.map((x) => x.name);
    expect(names).toContain("earnings_get");
    expect(names).not.toContain("post_publish"); // mcp:write 없음
    expect(names).not.toContain("super_stats");
    // bearer 경로
    const bearer = client(t, "/mcp", { authorization: `Bearer ${c.apiKey}` });
    expect((await bearer("tools/list")).status).toBe(200);
    expect((await client(t, "/mcp", { authorization: "Bearer am_mcp_nope" })("ping")).status).toBe(401);
    // 스코프 밖 툴 → -32003, 미지의 메서드 → -32601, 잘못된 인자 → -32602
    expect((await path("tools/call", { name: "post_publish", arguments: { spaceId: "x", confirmed: true } })).body!.error!.code).toBe(-32003);
    expect((await path("resources/list")).body!.error!.code).toBe(-32601);
    expect((await path("tools/call", { name: "product_search", arguments: { limit: 999 } })).body!.error!.code).toBe(-32602);
    // GET 안내
    const get = await t.fetch("/mcp", { method: "GET" });
    expect(get.status).toBe(200);
    expect((await get.json()).transport).toMatch(/stateless/);
  });

  it("runs the roadmap flow: product_search → link_issue → space → post_schedule → job_get, with confirmation gate and audit", async () => {
    const t = makeT();
    const user = await signup(t, "mcp3@test.com");
    await seedProduct(t, 100001);
    await pairDevice(t, user);
    const c = await user.as.mutation(api.mcp.createCredential, { label: "flow", scopes: ["mcp:read", "mcp:write"] });
    const call = client(t, new URL(c.endpointUrl).pathname);
    const products = (await tool(call, "product_search", { term: "테스트" })).result as { productId: string }[];
    expect(products).toHaveLength(1);
    const link = (await tool(call, "link_issue", { productId: products[0]!.productId })).result as { linkId: string; shortUrl: string; existed: boolean };
    expect(link.shortUrl).toMatch(/\/r\//);
    expect(((await tool(call, "link_issue", { productId: products[0]!.productId })).result as { existed: boolean }).existed).toBe(true);
    expect(((await tool(call, "link_list")).result as unknown[]).length).toBe(1);
    // 위험 툴 미확인 → preview
    const preview = (await tool(call, "space_create", { platform: "THREADS", name: "mcp-space" })).result as { requiresConfirmation: boolean };
    expect(preview.requiresConfirmation).toBe(true);
    expect(((await tool(call, "space_list")).result as unknown[]).length).toBe(0);
    const created = (await tool(call, "space_create", { platform: "THREADS", name: "mcp-space", confirmed: true })).result as { spaceId: string; jobId: string };
    expect(created.spaceId).toBeTruthy();
    const job = (await tool(call, "job_get", { jobId: created.jobId })).result as { jobType: string; status: string; source: string; executor: string };
    expect(job).toMatchObject({ jobType: "space.create", status: "QUEUED", source: "MCP", executor: "DESKTOP" });
    const sched = (await tool(call, "post_schedule", { spaceId: created.spaceId, kind: "DAILY", timeOfDay: "10:00", text: "MCP 예약 본문", linkId: link.linkId })).result as { scheduleId: string; nextRunAt: number | null };
    expect(sched.scheduleId).toBeTruthy();
    // post_publish: preview → confirmed(승인 대기)
    const pp = (await tool(call, "post_publish", { spaceId: created.spaceId, text: "MCP 게시" })).result as { requiresConfirmation: boolean; preview: { space: { authMode: string } } };
    expect(pp.requiresConfirmation).toBe(true);
    expect(pp.preview.space.authMode).toBe("BROWSER");
    const pub = (await tool(call, "post_publish", { spaceId: created.spaceId, text: "MCP 게시", confirmed: true })).result as { jobId: string; requiresApproval: boolean };
    expect(pub.requiresApproval).toBe(true);
    expect(((await tool(call, "job_get", { jobId: pub.jobId })).result as { status: string }).status).toBe("NEEDS_APPROVAL");
    const verify = (await tool(call, "post_verify_published", { jobId: pub.jobId })).result as { published: boolean };
    expect(verify.published).toBe(false);
    await tool(call, "job_cancel", { jobId: pub.jobId });
    expect(((await tool(call, "job_get", { jobId: pub.jobId })).result as { status: string }).status).toBe("CANCELLED");
    // 툴 에러는 isError 봉투로
    const bad = await tool(call, "job_get", { jobId: "nope" });
    expect(bad.isError).toBe(true);
    // 감사 기록 + callCount
    const audits = await t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((a) => a.action.startsWith("mcp.")));
    expect(audits.some((a) => a.action === "mcp.link_issue")).toBe(true);
    expect(audits.some((a) => a.action === "mcp.post_publish")).toBe(true);
    expect((await user.as.query(api.mcp.listMine, {})).credentials[0]!.callCount).toBeGreaterThan(5);
  });

  it("whitelists earnings fields per scope (no indirect leak for users) and gates admin/super tools by role", async () => {
    const t = makeT();
    const user = await signup(t, "mcp4@test.com");
    const owner = await signup(t, "owner@automoney.test");
    await setRole(t, owner.userId, "SUPER_ADMIN");
    const uc = await user.as.mutation(api.mcp.createCredential, { label: "u", scopes: ["mcp:read"] });
    const earnings = (await tool(client(t, new URL(uc.endpointUrl).pathname), "earnings_get")).result as Record<string, unknown>;
    expect(JSON.stringify(earnings)).not.toMatch(/indirect/i);
    expect(earnings.current).toBeDefined();
    const oc = await owner.as.mutation(api.mcp.createCredential, { label: "o", scopes: ["mcp:read", "admin:read", "super:read"] });
    const ocall = client(t, new URL(oc.endpointUrl).pathname);
    const superStats = (await tool(ocall, "super_stats")).result as { total?: unknown; month: string };
    expect(superStats.month).toMatch(/^\d{4}-\d{2}$/);
    expect(((await tool(ocall, "admin_team_stats")).result as { memberCount: number }).memberCount).toBeGreaterThanOrEqual(1);
    // 역할 강등 시 스코프 축소
    await setRole(t, owner.userId, "USER");
    const list = await ocall("tools/list");
    expect(list.body!.result!.tools!.map((x) => x.name)).not.toContain("super_stats");
  });

  it("rate limits per credential (120/min) with 429 + retry-after", async () => {
    const t = makeT();
    const user = await signup(t, "mcp5@test.com");
    const c = await user.as.mutation(api.mcp.createCredential, { label: "rl", scopes: ["mcp:read"] });
    const call = client(t, new URL(c.endpointUrl).pathname);
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await call("ping")).status;
    expect(last).toBe(429);
    const r = await call("ping");
    expect(r.body!.error!.data!.code).toBe("RATE_LIMITED");
    expect(Number(r.res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
