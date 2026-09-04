/**
 * 로컬 E2E: 가입 → 상품 동기화 → 링크 발급 → 리다이렉터 클릭 → 아뜨랑스 웹훅 → 대시보드 확인.
 * 사전 조건: `npx convex dev` (익명 로컬), `next dev` 실행, Convex env 설정.
 *   node scripts/e2e-local.mjs
 */
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { createHmac } from "node:crypto";

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? "http://127.0.0.1:3210";
const CONVEX_SITE_URL = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:3000";
const WEBHOOK_SECRET = process.env.ATTRANGS_WEBHOOK_SECRET ?? "e2e-webhook-secret";
const api = anyApi;
const stamp = Date.now();

function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

async function signUp(email, name, extra = {}, { allowExisting = false } = {}) {
  const client = new ConvexHttpClient(CONVEX_URL);
  let res;
  try {
    res = await client.action(api.auth.signIn, {
      provider: "password",
      params: { email, password: "Passw0rd!", flow: "signUp", name, ...extra },
    });
  } catch (e) {
    if (!allowExisting) throw e;
    res = await client.action(api.auth.signIn, { provider: "password", params: { email, password: "Passw0rd!", flow: "signIn" } });
  }
  assert(res.tokens?.token, `가입/로그인 ${email}`);
  client.setAuth(res.tokens.token);
  return client;
}

// SUPER_ADMIN_EMAILS=owner-e2e@automoney.test 로 설정되어 있어야 한다. 재실행 시에는 로그인으로 대체.
const owner = await signUp("owner-e2e@automoney.test", "운영자", {}, { allowExisting: true });
const ownerMe = await owner.query(api.users.me, {});
assert(ownerMe.role === "SUPER_ADMIN", `SUPER_ADMIN_EMAILS 매칭 → role=${ownerMe.role}`);

const sync = await owner.action(api.products.syncFromAttrangs, {});
assert(sync.inserted + sync.updated === 8, `Mock 상품 동기화 (${sync.inserted} 추가, ${sync.updated} 갱신)`);

const admin = await signUp(`admin+${stamp}@test.com`, "총판");
await owner.mutation(api.users.setRole, { userId: (await admin.query(api.users.me, {}))._id, role: "ADMIN" });
const invite = await admin.mutation(api.invites.create, { maxUses: 5 });
assert(invite.code?.length === 8, `초대 코드 발급 ${invite.code}`);

const user = await signUp(`user+${stamp}@test.com`, "마케터", { inviteCode: invite.code });
const me = await user.query(api.users.me, {});
assert(me.parentAdminId, "초대 코드로 총판 연결");

const products = await user.query(api.products.search, {});
const link = await user.action(api.links.issue, { productId: products[0]._id });
assert(link.shortCode?.length === 7, `링크 발급 shortCode=${link.shortCode} tracking=${link.trackingCode}`);

const redirect = await fetch(`${WEB_URL}/r/${link.shortCode}`, { redirect: "manual", headers: { referer: "https://www.instagram.com/" } });
assert(redirect.status === 302, `리다이렉터 302 (${redirect.status})`);
const loc = redirect.headers.get("location") ?? "";
assert(loc.includes(`am_tc=${link.trackingCode}`), `리다이렉트 URL 에 am_tc 포함: ${loc}`);

const now = new Date();
const body = JSON.stringify({
  event_id: `evt_${stamp}`,
  event_type: "order.created",
  occurred_at: now.toISOString(),
  order: {
    order_id: `E2E-${stamp}`,
    ordered_at: now.toISOString(),
    tracking_code: link.trackingCode,
    attribution: "direct",
    clicked_at: new Date(now.getTime() - 60_000).toISOString(),
    landing_product_id: products[0].attrangsProductId,
    items: [{ product_id: products[0].attrangsProductId, qty: 1, amount: 39000, commissionable_amount: 35000 }],
    order_amount: 39000,
    commissionable_amount: 35000,
    status: "paid",
  },
});
const ts = String(Date.now());
const sig = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex")}`;
const bad = await fetch(`${CONVEX_SITE_URL}/partner/attrangs/webhook`, { method: "POST", body, headers: { "x-attrangs-timestamp": ts, "x-attrangs-signature": "sha256=deadbeef" } });
assert(bad.status === 401, `잘못된 서명 거부 (${bad.status})`);
const ok = await fetch(`${CONVEX_SITE_URL}/partner/attrangs/webhook`, { method: "POST", body, headers: { "x-attrangs-timestamp": ts, "x-attrangs-signature": sig } });
assert(ok.status === 200, `웹훅 수신 (${ok.status}) ${await ok.text()}`);
const dup = await fetch(`${CONVEX_SITE_URL}/partner/attrangs/webhook`, { method: "POST", body, headers: { "x-attrangs-timestamp": ts, "x-attrangs-signature": sig } });
assert((await dup.json()).data.duplicate === true, "동일 event_id 멱등 처리");

const summary = await user.query(api.dashboard.userSummary, {});
assert(summary.current.clicks === 1, `대시보드 클릭 1 (${summary.current.clicks})`);
assert(summary.current.orders === 1 && summary.current.sales === 39000, `대시보드 주문 1 / 매출 39,000`);
assert(summary.current.estimatedCommission === 1750, `예상 수당 1,750원 (5%)`);
const orders = await user.query(api.orders.listMine, {});
assert(orders.length === 1 && orders[0].estimatedCommission === 1750, "주문 실적 목록");
const adminSummary = await admin.query(api.dashboard.adminSummary, {});
assert(adminSummary.total.sales === 39000, "총판 대시보드에 하부 실적 반영");
const superSummary = await owner.query(api.dashboard.superSummary, {});
assert(superSummary.direct.orders >= 1, "수퍼어드민 집계 반영");
console.log("\nE2E OK");
