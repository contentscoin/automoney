/**
 * 에이전트 E2E (로컬 Convex + 데스크톱 CLI):
 *  가입 → 페어 코드 → cli pair → 스페이스 생성 → cli run(space.create) → 세션 검증(픽스처 X 페이지) → 드라이런 게시 → 클라우드 상태 확인
 *  M4: 매거진 HTML 등록(수퍼어드민) → 콘텐츠 생성 요청 → cli run(content.generate, template) → 품질 게이트 APPROVED → pieceId 로 게시
 *  사전: apps/web 에서 `npx convex dev` 실행 중, `pnpm --filter @automoney/desktop build` 완료
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? "http://127.0.0.1:3210";
const CONVEX_SITE_URL = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const api = anyApi;
const stamp = Date.now();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-e2e-agent-"));
const fx = (n) => pathToFileURL(path.join(here, "..", "tests", "fixtures", n)).toString();
const fixture = fx("fake-x.html");
// 미디어 URL 용 로컬 정적 서버 (이미지/영상 다운로드 경로 검증)
import http from "node:http";
const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-e2e-media-"));
fs.writeFileSync(path.join(mediaDir, "a.jpg"), "fake-jpg");
fs.writeFileSync(path.join(mediaDir, "a.mp4"), "fake-mp4");
const mediaServer = http.createServer((req, res) => {
  const f = path.join(mediaDir, path.basename(req.url ?? "/"));
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", f.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => mediaServer.listen(0, "127.0.0.1", r));
const MEDIA = `http://127.0.0.1:${mediaServer.address().port}`;

const env = {
  ...process.env,
  AUTOMONEY_USER_DATA: userData,
  AUTOMONEY_CONVEX_SITE_URL: CONVEX_SITE_URL,
  AUTOMONEY_X_URL: fixture,
  AUTOMONEY_INSTAGRAM_URL: fx("fake-instagram.html"),
  AUTOMONEY_TIKTOK_URL: fx("fake-tiktok.html"),
  AUTOMONEY_NAVER_URL: fx("fake-naver.html"),
  AUTOMONEY_BROWSER_EXECUTABLE: process.env.AUTOMONEY_BROWSER_EXECUTABLE ?? "/opt/pw-browsers/chromium",
  AUTOMONEY_HEADLESS: "1",
  AUTOMONEY_ONCE_TIMEOUT_MS: "90000",
};
// 비동기 실행: 부모의 미디어 서버가 자식의 다운로드 요청에 응답할 수 있어야 한다
const cli = async (...args) => {
  const { stdout, stderr } = await execFileAsync("node", [path.join(here, "..", "dist", "cli.js"), ...args], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (process.env.E2E_VERBOSE) process.stderr.write(stderr);
  return stdout.trim().split("\n").filter(Boolean).at(-1);
};

function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

const client = new ConvexHttpClient(CONVEX_URL);
const res = await client.action(api.auth.signIn, { provider: "password", params: { email: `agent+${stamp}@test.com`, password: "Passw0rd!", flow: "signUp", name: "에이전트유저" } });
client.setAuth(res.tokens.token);
assert(res.tokens?.token, "유저 가입");

const pair = await client.mutation(api.devices.createPairCode, {});
const paired = JSON.parse(await cli("pair", pair.code));
assert(paired.paired === true, `CLI 페어링 (${paired.deviceId})`);
const devices = await client.query(api.devices.listMine, {});
assert(devices[0]?.status === "ACTIVE", "디바이스 ACTIVE");

const { spaceId } = await client.mutation(api.spaces.create, { platform: "X", name: "e2e-x" });
let run = JSON.parse(await cli("run", "--max", "1"));
assert(run.processed === 1, "space.create 잡 처리");
let spaces = await client.query(api.spaces.listMine, {});
assert(spaces[0]?.sessionState === "LOGIN_REQUIRED", `스페이스 상태 LOGIN_REQUIRED (${spaces[0]?.sessionState})`);
assert(fs.existsSync(path.join(userData, "spaces", spaceId, "meta.json")), "로컬 프로필 디렉터리 생성");

await client.mutation(api.spaces.requestVerify, { spaceId });
run = JSON.parse(await cli("run", "--max", "1"));
assert(run.processed === 1, "space.verify 잡 처리(픽스처 페이지)");
spaces = await client.query(api.spaces.listMine, {});
assert(spaces[0]?.sessionState === "HEALTHY", `세션 검증 → HEALTHY (${spaces[0]?.sessionState})`);
assert(spaces[0]?.handle === "e2e_handle", `핸들 동기화 (${spaces[0]?.handle})`);

const jobId = await client.mutation(api.jobs.enqueuePublish, { spaceId, text: "E2E 드라이런 게시 #automoney", mediaUrls: [], requireApproval: true, dryRun: true });
let jobs = await client.query(api.jobs.listMine, {});
assert(jobs[0]?.status === "NEEDS_APPROVAL", "발행 잡 승인 대기");
await client.mutation(api.jobs.approve, { jobId });
run = JSON.parse(await cli("run", "--max", "1"));
assert(run.processed === 1, "post.publish(드라이런) 잡 처리");
jobs = await client.query(api.jobs.listMine, {});
const pub = jobs.find((j) => j._id === jobId);
assert(pub?.status === "SUCCEEDED", `발행 잡 SUCCEEDED (${pub?.status} ${pub?.errorCode ?? ""} ${pub?.errorMessage ?? ""})`);
assert(pub?.result?.data?.dryRun === true, "드라이런 결과 봉투");

// 실제 게시 경로(픽스처 페이지에서 Post 클릭 → post-link 생성)
const jobId2 = await client.mutation(api.jobs.enqueuePublish, { spaceId, text: "E2E 실제 게시 (픽스처)", mediaUrls: [], requireApproval: false });
run = JSON.parse(await cli("run", "--max", "1"));
jobs = await client.query(api.jobs.listMine, {});
const pub2 = jobs.find((j) => j._id === jobId2);
assert(pub2?.status === "SUCCEEDED" && String(pub2?.result?.data?.postUrl ?? "").includes("/status/1234567890"), `게시 URL 수집 (${pub2?.result?.data?.postUrl})`);

const history = fs.readFileSync(path.join(userData, "spaces", spaceId, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert(history.map((h) => h.action).join(",") === "space.create,space.verify,post.publish,post.publish", `스페이스 이력 4건 (${history.map((h) => h.action).join(",")})`);

// ───────── M3-2: 인스타그램·틱톡·네이버 레시피 + 오토파일럿 복구 ─────────
async function runSpace(platform, name, text, mediaUrls) {
  const { spaceId: sid } = await client.mutation(api.spaces.create, { platform, name });
  await cli("run", "--max", "1"); // space.create
  await client.mutation(api.spaces.requestVerify, { spaceId: sid });
  await cli("run", "--max", "1");
  const sp = (await client.query(api.spaces.listMine, {})).find((s) => s._id === sid);
  assert(sp?.sessionState === "HEALTHY", `${platform} 세션 검증 HEALTHY (@${sp?.handle})`);
  const jid = await client.mutation(api.jobs.enqueuePublish, { spaceId: sid, text, mediaUrls, requireApproval: false });
  await cli("run", "--max", "1");
  const j = (await client.query(api.jobs.listMine, {})).find((x) => x._id === jid);
  assert(j?.status === "SUCCEEDED", `${platform} 게시 SUCCEEDED (${j?.status} ${j?.errorCode ?? ""} ${j?.errorMessage ?? ""})`);
  return j;
}
const ig = await runSpace("INSTAGRAM", "e2e-ig", "인스타 E2E 캡션 #automoney", [`${MEDIA}/a.jpg`]);
assert(String(ig.result?.data?.postUrl).includes("/p/ABC123"), `인스타 게시 URL (${ig.result?.data?.postUrl})`);
const tt = await runSpace("TIKTOK", "e2e-tt", "틱톡 E2E 캡션", [`${MEDIA}/a.mp4`]);
assert(String(tt.result?.data?.postUrl).includes("/video/"), `틱톡 게시 URL (${tt.result?.data?.postUrl})`);
const nb = await runSpace("NAVER_BLOG", "e2e-nb", "E2E 제목\n본문 첫 문단입니다.", []);
assert(String(nb.result?.data?.postUrl).includes("/223000000001"), `네이버 게시 URL (${nb.result?.data?.postUrl})`);
try {
  await client.mutation(api.jobs.enqueuePublish, { spaceId: (await client.query(api.spaces.listMine, {})).find((s) => s.platform === "INSTAGRAM")._id, text: "no media", mediaUrls: [], requireApproval: false });
  assert(false, "인스타 미디어 없는 발행은 거부되어야 함");
} catch (e) {
  assert(String(e).includes("requires media"), "인스타 미디어 필수 검증(클라우드)");
}

// 오토파일럿 복구: 레시피 셀렉터가 깨진 X 픽스처 + scripted 플래너
env.AUTOMONEY_X_URL = fx("fake-x-broken.html");
env.AUTOMONEY_AUTOPILOT_PLANNER = "scripted";
const apJob = await client.mutation(api.jobs.enqueuePublish, { spaceId, text: "오토파일럿 복구 게시", mediaUrls: [], requireApproval: false });
await cli("run", "--max", "1");
const apRes = (await client.query(api.jobs.listMine, {})).find((x) => x._id === apJob);
assert(apRes?.status === "SUCCEEDED" && apRes?.result?.data?.recoveredBy === "scripted", `오토파일럿 복구 (${apRes?.status} recoveredBy=${apRes?.result?.data?.recoveredBy} ${apRes?.errorMessage ?? ""})`);
assert(String(apRes?.result?.data?.postUrl).includes("/status/999"), `오토파일럿 게시 URL (${apRes?.result?.data?.postUrl})`);
const hist2 = fs.readFileSync(path.join(userData, "spaces", spaceId, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert(hist2.some((h) => h.action === "autopilot.step"), "오토파일럿 스텝 이력 기록");
env.AUTOMONEY_AUTOPILOT_PLANNER = "off";
env.AUTOMONEY_X_URL = fixture;

// ───────── M4: 매거진 → 콘텐츠 생성(에이전트 template provider) → 라이브러리 → pieceId 게시 ─────────
// SUPER_ADMIN_EMAILS=owner-e2e@automoney.test 가 설정되어 있어야 한다(web e2e 와 동일).
const owner = new ConvexHttpClient(CONVEX_URL);
let ownerRes;
try {
  ownerRes = await owner.action(api.auth.signIn, { provider: "password", params: { email: "owner-e2e@automoney.test", password: "Passw0rd!", flow: "signUp", name: "운영자" } });
} catch {
  ownerRes = await owner.action(api.auth.signIn, { provider: "password", params: { email: "owner-e2e@automoney.test", password: "Passw0rd!", flow: "signIn" } });
}
owner.setAuth(ownerRes.tokens.token);
assert((await owner.query(api.users.me, {})).role === "SUPER_ADMIN", "운영자 로그인(SUPER_ADMIN)");
await owner.action(api.products.syncFromAttrangs, {});
const MAG_HTML = `<html><head><title>가을 니트 스타일링</title><meta property="og:title" content="E2E 가을 니트 스타일링 ${stamp}" /><meta property="og:description" content="니트 하나로 완성하는 데일리룩" /></head><body><article>
<p>올가을 니트는 어깨선이 살짝 떨어지는 루즈핏이 대세입니다. 와이드 슬랙스와 매치하면 편안하면서도 단정해 보여요.</p>
<img src="${MEDIA}/a.jpg" />
<p>베이직 브이넥 니트 는 소매가 길어 손등을 살짝 덮는 디자인이라 가을 감성에 딱 맞아요. <a href="https://attrangs.co.kr/shop/view.php?index_no=100002">상품 보기</a></p>
<p>하이웨스트 와이드 슬랙스 와 톤온톤으로 맞추면 키가 커 보이는 효과가 있습니다. <a href="/shop/view.php?index_no=100003">슬랙스</a></p>
</article></body></html>`;
const mag = await owner.action(api.magazines.register, { html: MAG_HTML, url: `https://attrangs.co.kr/magazine/e2e-${stamp}` });
assert(mag.productCount === 2 && mag.atomCount >= 3, `매거진 등록: 소재 ${mag.atomCount} · 상품 ${mag.productCount}`);
const magList = await client.query(api.magazines.list, {});
assert(magList.some((m) => m._id === mag.magazineId), "유저에게 매거진 노출");

env.AUTOMONEY_CONTENT_PROVIDER = "template";
const genJob = await client.mutation(api.content.requestGenerate, { magazineId: mag.magazineId, channels: ["X", "THREADS", "INSTAGRAM_REEL"] });
run = JSON.parse(await cli("run", "--max", "1"));
assert(run.processed === 1, "content.generate 잡 처리(template provider)");
const genRes = (await client.query(api.jobs.listMine, {})).find((j) => j._id === genJob);
assert(genRes?.status === "SUCCEEDED" && genRes?.result?.data?.generatedBy === "template", `생성 잡 SUCCEEDED (${genRes?.status} by=${genRes?.result?.data?.generatedBy} ${genRes?.errorMessage ?? ""})`);
const lib = await client.query(api.content.listLibrary, {});
const mineLib = lib.filter((p) => p.mine);
assert(mineLib.length === 3, `내 라이브러리 조각 3개 (${mineLib.length}, 공유 포함 ${lib.length})`);
const approvedX = mineLib.find((p) => p.channel === "X" && p.status === "APPROVED");
assert(approvedX && approvedX.hashtags.includes("광고"), `X 조각 자동 승인 + #광고 (${lib.map((p) => `${p.channel}:${p.status}:${p.qualityScore}`).join(", ")})`);
assert(mineLib.find((p) => p.channel === "INSTAGRAM_REEL")?.script, "릴스 조각에 숏폼 대본 포함");
const pieceJob = await client.mutation(api.jobs.enqueuePublish, { spaceId, text: "", mediaUrls: [], pieceId: approvedX._id, requireApproval: false });
await cli("run", "--max", "1");
const pieceRes = (await client.query(api.jobs.listMine, {})).find((j) => j._id === pieceJob);
assert(pieceRes?.status === "SUCCEEDED" && String(pieceRes?.result?.data?.postUrl).includes("/status/"), `라이브러리 조각으로 게시 (${pieceRes?.status} ${pieceRes?.result?.data?.postUrl ?? pieceRes?.errorMessage ?? ""})`);
assert((await client.query(api.content.getPiece, { pieceId: approvedX._id })).usageCount === 1, "조각 사용 횟수 증가");
await owner.mutation(api.content.setVisibility, { pieceId: approvedX._id, visibility: "SHARED" });
const other = new ConvexHttpClient(CONVEX_URL);
const otherRes = await other.action(api.auth.signIn, { provider: "password", params: { email: `agent2+${stamp}@test.com`, password: "Passw0rd!", flow: "signUp", name: "다른유저" } });
other.setAuth(otherRes.tokens.token);
const otherLib = await other.query(api.content.listLibrary, {});
assert(otherLib.some((p) => p._id === approvedX._id) && otherLib.every((p) => !p.mine), "타 유저에게 공유 조각만 노출");
const facts = await client.mutation(api.curation.buildProductFacts, { productId: magList.find((m) => m._id === mag.magazineId) && (await client.query(api.magazines.get, { magazineId: mag.magazineId })).products[0]._id });
assert(facts.inserted + facts.updated === 5, "제품 정보 팩 5건");
delete env.AUTOMONEY_CONTENT_PROVIDER;

// ───────── M5: readback(post.readback) — 게시물 지표를 스페이스 세션으로 읽어 24h 스냅샷 확정 ─────────
const metricsRow = await client.query(api.analytics.listMine, {});
const target = metricsRow.posts.find((p) => p.jobId === pieceJob);
assert(target && target.nextWindow === "24h", "게시 성공 → postMetrics 행(24h 대기)");
env.AUTOMONEY_READBACK_URL = fx("fake-post.html");
// 크론 대신 즉시 틱(24h 경과 시각으로) → 데스크톱 잡 생성
const tickRes = await client.mutation(api.analytics.tickNow, { now: target.postedAt + 24 * 3600_000 + 1 });
assert(tickRes.browser >= 1, `readback 틱 → 브라우저 잡 ${tickRes.browser}건`);
run = JSON.parse(await cli("run", "--max", String(tickRes.browser)));
assert(run.processed === tickRes.browser, "post.readback 잡 처리(픽스처 게시물 페이지)");
const after = (await client.query(api.analytics.listMine, {})).posts.find((p) => p.jobId === pieceJob);
assert(after.snapshots.length === 1 && after.snapshots[0].source === "BROWSER" && after.snapshots[0].likes === 12000, `24h 스냅샷 (좋아요 ${after.snapshots[0]?.likes}, 댓글 ${after.snapshots[0]?.comments})`);
assert(after.nextWindow === "72h", "다음 창 72h 예약");
delete env.AUTOMONEY_READBACK_URL;
mediaServer.close();
console.log("\nAGENT E2E OK (M3a + M3-2 + M4 + M5 readback)");
