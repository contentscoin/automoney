/**
 * MCP E2E (로드맵 M5 완료 기준): 외부 MCP 클라이언트(순수 JSON-RPC over HTTP)로
 *  자격증명 발급 → initialize → tools/list → product_search → link_issue → Meta(mock) 연결 → post_publish(confirmed)
 *  → job_get 폴링 → post_verify_published → post_schedule → earnings_get. 사전: apps/web 에서 `npx convex dev` 실행 중.
 */
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? "http://127.0.0.1:3210";
const SITE = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const api = anyApi;
const stamp = Date.now();
function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 유저 가입 + 자격증명 발급(대시보드 뮤테이션과 동일)
const client = new ConvexHttpClient(CONVEX_URL);
const res = await client.action(api.auth.signIn, { provider: "password", params: { email: `mcp+${stamp}@test.com`, password: "Passw0rd!", flow: "signUp", name: "MCP유저" } });
client.setAuth(res.tokens.token);
const cred = await client.mutation(api.mcp.createCredential, { label: "e2e", scopes: ["mcp:read", "mcp:write"] });
assert(cred.apiKey.startsWith("am_mcp_"), "MCP 자격증명 발급");
const endpoint = `${SITE}${new URL(cred.endpointUrl).pathname}`;

// 2) 순수 JSON-RPC 클라이언트 (SDK 없이)
let rpcId = 0;
async function rpc(method, params, { bearer } = {}) {
  const r = await fetch(bearer ? `${SITE}/mcp` : endpoint, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${cred.apiKey}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.body?.error) throw new Error(`${name}: ${r.body.error.message}`);
  const out = r.body.result;
  if (out.isError) throw new Error(`${name}: ${JSON.stringify(out.structuredContent)}`);
  return out.structuredContent;
};

const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
assert(init.status === 200 && init.body.result.serverInfo.name === "automoney", "initialize");
assert((await rpc("notifications/initialized")).status === 202, "notifications/initialized → 202");
const tools = (await rpc("tools/list")).body.result.tools.map((t) => t.name);
assert(tools.includes("link_issue") && tools.includes("post_publish") && !tools.includes("super_stats"), `tools/list (${tools.length}개, 스코프 필터)`);
assert((await rpc("ping", {}, { bearer: true })).status === 200, "Bearer 키 경로 인증");

// 3) 상품 → 링크
const products = await call("product_search", { term: "니트", limit: 5 });
assert(products.length > 0, `product_search ${products.length}건`);
const link = await call("link_issue", { productId: products[0].productId });
assert(link.shortUrl.includes("/r/"), `link_issue ${link.shortUrl}`);
const links = await call("link_list");
assert(links.length === 1 && links[0].linkId === link.linkId, "link_list");

// 4) Meta(mock) 연결 → API 스페이스
const { url } = await client.mutation(api.meta.connectStart, { platform: "THREADS" });
const cb = await fetch(url, { redirect: "manual" });
assert(cb.status === 302 && (cb.headers.get("location") ?? "").includes("meta=connected"), "Meta mock OAuth 콜백 → connected");
const spaces = await call("space_list");
const apiSpace = spaces.find((s) => s.authMode === "META_API");
assert(apiSpace && apiSpace.sessionState === "HEALTHY", `space_list: META_API 스페이스 (${apiSpace?.name})`);

// 5) 발행: preview → confirmed → 클라우드 실행 → 폴링
const preview = await call("post_publish", { spaceId: apiSpace.spaceId ?? apiSpace._id, text: "MCP 에서 보낸 스레드 글, 뭐 입을까요?\n\n링크에서 확인", linkId: link.linkId });
assert(preview.requiresConfirmation === true, "post_publish 미확인 → preview");
const pub = await call("post_publish", { spaceId: apiSpace._id, text: "MCP 에서 보낸 스레드 글, 뭐 입을까요?\n\n링크에서 확인", linkId: link.linkId, requireApproval: false, confirmed: true });
let job;
for (let i = 0; i < 30; i++) {
  job = await call("job_get", { jobId: pub.jobId });
  if (["SUCCEEDED", "FAILED"].includes(job.status)) break;
  await sleep(500);
}
assert(job.status === "SUCCEEDED" && job.executor === "CLOUD", `job_get → SUCCEEDED (executor=${job.executor}, ${job.postUrl})`);
const verify = await call("post_verify_published", { jobId: pub.jobId });
assert(verify.published === true && verify.metrics && verify.metrics.nextWindow === "24h", "post_verify_published + readback 24h 대기");

// 6) 예약 + 실적
const sched = await call("post_schedule", { spaceId: apiSpace._id, kind: "DAILY", timeOfDay: "10:30", jitterMinutes: 10, text: "예약 본문", linkId: link.linkId });
assert(sched.scheduleId && sched.nextRunAt, `post_schedule 다음 실행 ${new Date(sched.nextRunAt).toISOString()}`);
const earnings = await call("earnings_get");
assert(earnings.current && !JSON.stringify(earnings).toLowerCase().includes("indirect"), "earnings_get (간접 필드 없음)");
const status = await call("agent_get_status");
assert(Array.isArray(status.devices) && status.minAppVersion, "agent_get_status");

// 7) 폐기 → 401
await client.mutation(api.mcp.revoke, { credentialId: cred.credentialId });
assert((await rpc("ping")).status === 401, "폐기 후 401");
console.log("\nMCP E2E OK (M5)");
