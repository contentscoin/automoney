/**
 * 에이전트 E2E (로컬 Convex + 데스크톱 CLI):
 *  가입 → 페어 코드 → cli pair → 스페이스 생성 → cli run(space.create) → 세션 검증(픽스처 X 페이지) → 드라이런 게시 → 클라우드 상태 확인
 *  사전: apps/web 에서 `npx convex dev` 실행 중, `pnpm --filter @automoney/desktop build` 완료
 */
import { execFileSync } from "node:child_process";
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
const fixture = pathToFileURL(path.join(here, "..", "tests", "fixtures", "fake-x.html")).toString();

const env = {
  ...process.env,
  AUTOMONEY_USER_DATA: userData,
  AUTOMONEY_CONVEX_SITE_URL: CONVEX_SITE_URL,
  AUTOMONEY_X_URL: fixture,
  AUTOMONEY_BROWSER_EXECUTABLE: process.env.AUTOMONEY_BROWSER_EXECUTABLE ?? "/opt/pw-browsers/chromium",
  AUTOMONEY_HEADLESS: "1",
  AUTOMONEY_ONCE_TIMEOUT_MS: "90000",
};
const cli = (...args) => {
  const out = execFileSync("node", [path.join(here, "..", "dist", "cli.js"), ...args], { env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "inherit"] });
  return out.trim().split("\n").filter(Boolean).at(-1);
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
const paired = JSON.parse(cli("pair", pair.code));
assert(paired.paired === true, `CLI 페어링 (${paired.deviceId})`);
const devices = await client.query(api.devices.listMine, {});
assert(devices[0]?.status === "ACTIVE", "디바이스 ACTIVE");

const { spaceId } = await client.mutation(api.spaces.create, { platform: "X", name: "e2e-x" });
let run = JSON.parse(cli("run", "--max", "1"));
assert(run.processed === 1, "space.create 잡 처리");
let spaces = await client.query(api.spaces.listMine, {});
assert(spaces[0]?.sessionState === "LOGIN_REQUIRED", `스페이스 상태 LOGIN_REQUIRED (${spaces[0]?.sessionState})`);
assert(fs.existsSync(path.join(userData, "spaces", spaceId, "meta.json")), "로컬 프로필 디렉터리 생성");

await client.mutation(api.spaces.requestVerify, { spaceId });
run = JSON.parse(cli("run", "--max", "1"));
assert(run.processed === 1, "space.verify 잡 처리(픽스처 페이지)");
spaces = await client.query(api.spaces.listMine, {});
assert(spaces[0]?.sessionState === "HEALTHY", `세션 검증 → HEALTHY (${spaces[0]?.sessionState})`);
assert(spaces[0]?.handle === "e2e_handle", `핸들 동기화 (${spaces[0]?.handle})`);

const jobId = await client.mutation(api.jobs.enqueuePublish, { spaceId, text: "E2E 드라이런 게시 #automoney", mediaUrls: [], requireApproval: true, dryRun: true });
let jobs = await client.query(api.jobs.listMine, {});
assert(jobs[0]?.status === "NEEDS_APPROVAL", "발행 잡 승인 대기");
await client.mutation(api.jobs.approve, { jobId });
run = JSON.parse(cli("run", "--max", "1"));
assert(run.processed === 1, "post.publish(드라이런) 잡 처리");
jobs = await client.query(api.jobs.listMine, {});
const pub = jobs.find((j) => j._id === jobId);
assert(pub?.status === "SUCCEEDED", `발행 잡 SUCCEEDED (${pub?.status} ${pub?.errorCode ?? ""} ${pub?.errorMessage ?? ""})`);
assert(pub?.result?.data?.dryRun === true, "드라이런 결과 봉투");

// 실제 게시 경로(픽스처 페이지에서 Post 클릭 → post-link 생성)
const jobId2 = await client.mutation(api.jobs.enqueuePublish, { spaceId, text: "E2E 실제 게시 (픽스처)", mediaUrls: [], requireApproval: false });
run = JSON.parse(cli("run", "--max", "1"));
jobs = await client.query(api.jobs.listMine, {});
const pub2 = jobs.find((j) => j._id === jobId2);
assert(pub2?.status === "SUCCEEDED" && String(pub2?.result?.data?.postUrl ?? "").includes("/status/1234567890"), `게시 URL 수집 (${pub2?.result?.data?.postUrl})`);

const history = fs.readFileSync(path.join(userData, "spaces", spaceId, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert(history.map((h) => h.action).join(",") === "space.create,space.verify,post.publish,post.publish", `스페이스 이력 4건 (${history.map((h) => h.action).join(",")})`);
console.log("\nAGENT E2E OK");
