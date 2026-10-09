/**
 * Actual React-page UI smoke with mocked Convex/Next boundaries; no auth bypass,
 * production routes, external writes, or dependency installation.
 * node apps/web/scripts/ui-smoke.mjs [--serve]
 * Artifacts: repository dist/ui-smoke (gitignored). --serve keeps loopback open.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const repoRoot = resolve(webRoot, "../..");
const outputDir = join(repoRoot, "dist/ui-smoke");
const esbuild = await import(pathToFileURL(join(repoRoot, "node_modules/.pnpm/esbuild@0.27.0/node_modules/esbuild/lib/main.js")).href);
const { chromium } = await import(pathToFileURL(join(repoRoot, "apps/desktop/node_modules/playwright/index.mjs")).href);
await mkdir(outputDir, { recursive: true });
const fixtureModule = join(scriptDir, "ui-smoke/fixtures.jsx");
const nextModule = join(scriptDir, "ui-smoke/next-mock.jsx");
await esbuild.build({
  entryPoints: [join(scriptDir, "ui-smoke/client.jsx")], bundle: true, platform: "browser", format: "esm", jsx: "automatic",
  outfile: join(outputDir, "app.js"), sourcemap: true, tsconfig: join(webRoot, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "ui-fixtures-only", setup(build) {
    build.onResolve({ filter: /^(convex\/react|@\/convex\/_generated\/api)$/ }, () => ({ path: fixtureModule }));
    build.onResolve({ filter: /^next\/(navigation|link)$/ }, () => ({ path: nextModule }));
    build.onResolve({ filter: /^next\/image$/ }, () => ({ path: "image-mock", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `export { Image as default } from ${JSON.stringify(nextModule)};`, loader: "js", resolveDir: webRoot }));
  } }],
});
const chunksDir = join(webRoot, ".next/static/chunks");
const cssFiles = (await readdir(chunksDir)).filter((name) => name.endsWith(".css"));
assert(cssFiles.length, "Run the web production build first to supply actual application CSS.");
await writeFile(join(outputDir, "app.css"), (await Promise.all(cssFiles.map((name) => readFile(join(chunksDir, name), "utf8")))).join("\n"));
const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Automoney mocked UI smoke</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
await writeFile(join(outputDir, "index.html"), html);
const mime = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".html": "text/html" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1:4179").pathname;
    const asset = ["/app.js", "/app.css", "/report.json"].includes(pathname) ? pathname.slice(1) : pathname.endsWith(".png") && /^\/[a-z0-9-]+\.png$/.test(pathname) ? pathname.slice(1) : "index.html";
    const type = mime[asset.slice(asset.lastIndexOf("."))] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": `${type}${type.startsWith("text/") ? "; charset=utf-8" : ""}`, "cache-control": "no-store" });
    response.end(await readFile(join(outputDir, asset)));
  } catch { response.writeHead(404); response.end("Not found"); }
});
await new Promise((ready, reject) => { server.once("error", reject); server.listen(4179, "127.0.0.1", ready); });
console.log("Mocked React UI harness: http://127.0.0.1:4179/super/content");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === "media.fixture.invalid" && /^\/frozen(?:-\d+)?\.png$/.test(url.pathname)) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/1ioAAAAASUVORK5CYII=", "base64") });
  return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];
const record = (name, detail = true) => checks.push({ name, passed: true, detail });
async function navigate(path, title) {
  await page.goto(`http://127.0.0.1:4179${path}`);
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
}
async function layout(name, width) {
  await page.setViewportSize({ width, height: 1000 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== "fixed").slice(0, 12).map((element) => ({ tag: element.tagName, class: element.className, text: element.textContent.slice(0, 70) })) }));
  await page.screenshot({ path: join(outputDir, `${name}-${width}.png`), fullPage: true });
  checks.push({ name: `${name}: no page overflow at ${width}px`, passed: dimensions.content <= dimensions.viewport + 1, detail: dimensions });
}
let failed = null;
try {
  for (const [name, path, title] of [
    ["supply", "/super/content", "콘텐츠 공급실"], ["publish", "/dashboard/publish?piece=piece-approved", "게시하기"],
    ["schedules", "/dashboard/schedules?piece=piece-approved", "예약 발행"], ["links", "/dashboard/links", "내 마케팅 링크"],
  ]) {
    await navigate(path, title);
    await layout(name, 320); await layout(name, 1440);
  }
  await navigate("/super/content", "콘텐츠 공급실");
  await page.getByRole("checkbox", { name: "묶음에 선택", exact: true }).check();
  assert(await page.getByRole("button", { name: "선택 자료 1개로 묶음 만들기" }).isEnabled());
  record("supply: ready material selection enables collection creation");
  await page.getByRole("button", { name: "자료 수정", exact: true }).click();
  await page.getByLabel("자료 제목 수정", { exact: true }).fill("수정한 운영 자료");
  await page.evaluate(() => window.__uiSmoke.failNext("adminContent:updateMaterial"));
  await page.getByRole("button", { name: "수정 저장", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "테스트 오류" }).waitFor();
  assert.equal(await page.getByLabel("자료 제목 수정", { exact: true }).inputValue(), "수정한 운영 자료");
  record("supply: failed save explains recovery and retains input");
  await page.getByRole("button", { name: "수정 저장", exact: true }).click();
  await page.getByRole("heading", { name: "수정한 운영 자료", exact: true }).waitFor();
  await page.getByRole("button", { name: "초안·검토 열기", exact: true }).click();
  await page.getByRole("button", { name: "묶음 정보·자료 수정", exact: true }).click();
  await page.getByLabel("묶음 제목 수정", { exact: true }).fill("수정한 콘텐츠 묶음");
  await page.getByRole("button", { name: "묶음 수정 저장", exact: true }).click();
  await page.getByRole("heading", { name: "수정한 콘텐츠 묶음", exact: true }).first().waitFor();
  await page.getByText("PC·Codex 연결과 선택 근거를 확인한 뒤 새 AI 생성을 요청하세요. 실패 기록은 유지됩니다.", { exact: true }).waitFor();
  record("supply: material/collection edits and failed-generation recovery render");
  await layout("supply-detail", 320); await layout("supply-detail", 1440);
  await navigate("/dashboard/publish?piece=piece-approved", "게시하기");
  assert(await page.locator("#publish-dry-run").isChecked());
  assert(await page.locator("#publish-text").evaluate((element) => element.readOnly));
  assert(await page.locator("#publish-media").evaluate((element) => element.readOnly));
  await page.locator("#publish-space").selectOption("space-threads");
  assert(await page.getByRole("button", { name: "테스트 게시 검토 등록", exact: true }).isEnabled());
  await page.locator("#publish-dry-run").uncheck();
  await page.getByText("실제 게시 기능이 아직 활성화되지 않았습니다", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "실제 게시 검토 등록", exact: true }).isDisabled());
  record("publish: dry-run default, approved copy read-only, LIVE-off blocks live submission");
  await layout("publish-live-off", 320);
  await navigate("/dashboard/links", "내 마케팅 링크");
  assert(await page.getByRole("button", { name: "실제 링크로 전환", exact: true }).count() >= 1);
  await page.getByRole("button", { name: "실제 링크로 전환", exact: true }).first().click();
  await page.getByText("링크를 복사했습니다.", { exact: true }).waitFor();
  assert(await page.getByText("실제", { exact: true }).isVisible());
  assert.equal(await page.evaluate(() => window.__uiSmoke.state().links.filter((link) => link.origin === "MOCK")[0].status), "DISABLED");
  record("links: explicit real-link conversion label and preserved disabled demo history");
  await navigate("/dashboard/schedules?piece=piece-approved", "예약 발행");
  await page.getByText("실제 게시 준비 중", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "예약 등록", exact: true }).isDisabled());
  assert(await page.getByRole("button", { name: "예약 재개", exact: true }).isDisabled());
  assert(await page.locator("#schedule-text").evaluate((element) => element.readOnly));
  record("schedules: LIVE-off prevents registration/resume and approved copy is read-only");
  await navigate("/fixtures/media", "미디어 검수 테스트");
  assert.equal(await page.getByRole("img").count(), 0, "Remote unfrozen media must not masquerade as approval preview");
  assert(await page.getByRole("button", { name: "콘텐츠 승인", exact: true }).isDisabled());
  await page.getByRole("button", { name: "미디어 고정하기", exact: true }).click();
  await page.getByText("파일 사용권과 공개 저장·배포 동의를 확인하세요.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiSmoke.calls.filter((call) => call.name === "media:requestFreeze").length), 0);
  await page.getByLabel("이 파일을 사용할 권한이 있으며", { exact: false }).check();
  await page.getByLabel("사용권 근거 (필수, 3~1000자)", { exact: true }).fill("운영사가 직접 촬영한 이미지");
  await page.evaluate(() => window.__uiSmoke.failNext("media:requestFreeze"));
  await page.getByRole("button", { name: "미디어 고정하기", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "테스트 오류" }).waitFor();
  assert.equal(await page.getByLabel("사용권 근거 (필수, 3~1000자)", { exact: true }).inputValue(), "운영사가 직접 촬영한 이미지");
  await page.getByRole("button", { name: "미디어 고정 다시 시도", exact: true }).click();
  await page.getByText("미디어 저장 중 · 0/1개 완료. 완료되면 미리보기가 표시됩니다.", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "미디어 고정 중…", exact: true }).isDisabled());
  assert(await page.getByRole("button", { name: "콘텐츠 수정", exact: true }).isDisabled());
  await layout("media-freeze-running", 320);
  record("media: rights consent is required; failed request retains evidence; retry shows progress and blocks duplicates");
  assert.equal(await page.getByRole("button", { name: "미디어 고정 중…", exact: true }).evaluate((button) => button.disabled), true);
  await page.evaluate(() => window.__uiSmoke.completeFreeze());
  await page.waitForFunction(() => document.querySelector('input[id$="-review-productFacts"]')?.disabled === false && document.querySelector("img")?.naturalWidth > 0);
  assert(await page.getByRole("button", { name: "콘텐츠 승인", exact: true }).isDisabled());
  for (const label of ["상품 사실·가격 확인", "광고 표기 확인", "미디어 사용권·채널 적합성 확인", "최종 문구 확인"]) await page.getByRole("checkbox", { name: label, exact: false }).check();
  assert(await page.getByRole("button", { name: "콘텐츠 승인", exact: true }).isEnabled());
  await layout("media-review-ready", 320); await layout("media-review-ready", 1440);
  await page.setViewportSize({ width: 640, height: 800 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const zoomOverflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert(zoomOverflow.content <= zoomOverflow.width + 1);
  await page.screenshot({ path: join(outputDir, "media-review-200-percent.png"), fullPage: true });
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  const finalReview = page.getByRole("checkbox", { name: "최종 문구 확인", exact: false });
  await finalReview.focus();
  await page.keyboard.press("Space");
  assert(await page.getByRole("button", { name: "콘텐츠 승인", exact: true }).isDisabled());
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  const focusedCopy = await page.evaluate(() => ({ text: document.activeElement?.textContent, outline: getComputedStyle(document.activeElement).outlineWidth, style: getComputedStyle(document.activeElement).outlineStyle }));
  assert.match(focusedCopy.text, /콘텐츠 복사/);
  assert.equal(focusedCopy.style, "solid");
  assert(parseFloat(focusedCopy.outline) >= 2);
  await page.keyboard.press("Tab");
  assert.equal(await page.getByRole("button", { name: "콘텐츠 승인", exact: true }).evaluate((button) => button === document.activeElement), true);
  record("media: 200% CSS zoom reflows; keyboard Space toggles review, Tab reaches actions with visible focus");
  await page.getByRole("button", { name: "콘텐츠 승인", exact: true }).click();
  await page.getByRole("link", { name: "이 콘텐츠로 게시", exact: true }).waitFor();
  record("media: immutable file preview loads, all four checks gate approval, reviewed piece becomes publishable");
  await page.evaluate(() => window.__uiSmoke.patchMedia({ mediaApprovalReady: false }));
  assert.equal(await page.getByRole("link", { name: "이 콘텐츠로 게시", exact: true }).count(), 0);
  await page.getByText(/‘콘텐츠 수정’을 열고 내용을 그대로 저장한 뒤/).waitFor();
  record("media: legacy approval without immutable review evidence cannot offer publishing");
  await page.getByRole("button", { name: "콘텐츠 수정", exact: true }).click();
  await page.getByRole("button", { name: "수정 내용 저장", exact: true }).click();
  await page.getByRole("checkbox", { name: "상품 사실·가격 확인", exact: false }).waitFor();
  await page.waitForFunction(() => document.querySelector("img")?.naturalWidth > 0);
  assert.equal(await page.getByRole("checkbox", { name: "상품 사실·가격 확인", exact: false }).isChecked(), false);
  assert(await page.getByRole("checkbox", { name: "상품 사실·가격 확인", exact: false }).isEnabled());
  record("media: same-content save reopens review, resets checks and reloads a usable preview");
  await page.evaluate(() => {
    const urls = Array.from({ length: 5 }, (_, index) => `https://media.fixture.invalid/frozen-${index}.png`);
    window.__uiSmoke.patchMedia({ mediaUrls: urls, mediaIntegrity: { ready: true, manifest: urls.map((url) => ({ url, sha256: "a".repeat(64), sizeBytes: 68, mimeType: "image/png" })) } });
  });
  assert(await page.getByRole("checkbox", { name: "상품 사실·가격 확인", exact: false }).isDisabled());
  await page.getByRole("button", { name: "+1 · 전체 미디어 보기", exact: true }).click();
  await page.waitForFunction(() => document.images.length === 5 && [...document.images].every((image) => image.naturalWidth > 0));
  assert(await page.getByRole("checkbox", { name: "상품 사실·가격 확인", exact: false }).isEnabled());
  record("media: hidden fifth file must load before review controls become available");
  await page.evaluate(() => {
    const url = "https://media.fixture.invalid/unavailable.mp4";
    window.__uiSmoke.patchMedia({ mediaUrls: [url], mediaIntegrity: { ready: true, manifest: [{ url, sha256: "b".repeat(64), sizeBytes: 1024, mimeType: "video/mp4" }] } });
  });
  await page.getByRole("button", { name: "미리보기 다시 불러오기", exact: true }).waitFor();
  assert.equal(await page.locator("video").evaluate((video) => video.controls && !video.autoplay && video.preload === "metadata"), true);
  assert(await page.getByRole("button", { name: "콘텐츠 승인", exact: true }).isDisabled());
  record("media: unreadable video shows retry and blocks approval; native controls do not autoplay (playback not tested)");
  await navigate("/dashboard/publish", "게시하기");
  await page.evaluate(() => window.__uiSmoke.setLive());
  await page.locator("#publish-space").selectOption("space-threads");
  await page.locator("#publish-text").fill("고정 전 주소 테스트");
  await page.locator("#publish-media").fill("https://media.fixture.invalid/source.png");
  assert(await page.getByRole("button", { name: "테스트 게시 검토 등록", exact: true }).isEnabled());
  await page.locator("#publish-dry-run").uncheck();
  assert(await page.getByRole("button", { name: "실제 게시 검토 등록", exact: true }).isDisabled());
  await page.getByRole("button", { name: "테스트 실행으로 전환", exact: true }).click();
  assert(await page.getByRole("button", { name: "테스트 게시 검토 등록", exact: true }).isEnabled());
  record("publish: direct remote media is blocked only for LIVE; dry-run remains available");
  await navigate("/dashboard/publish?piece=piece-media", "게시하기");
  await page.evaluate(() => { window.__uiSmoke.setLive(false); window.__uiSmoke.patchMedia({ status: "APPROVED" }); });
  await page.locator("#publish-space").selectOption("space-threads");
  await page.locator("#publish-dry-run").uncheck();
  assert(await page.getByRole("button", { name: "실제 게시 검토 등록", exact: true }).isDisabled());
  await page.evaluate(() => { window.__uiSmoke.completeFreeze(); window.__uiSmoke.patchMedia({ mediaApprovalReady: true }); });
  await page.getByText("이미지·영상의 실제 게시에는 연결된 PC 앱 0.1.18 이상이 필요합니다. 연결 관리에서 업데이트를 확인하세요.", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "실제 게시 검토 등록", exact: true }).isDisabled());
  await page.evaluate(() => window.__uiSmoke.setLive(true));
  assert(await page.getByRole("button", { name: "실제 게시 검토 등록", exact: true }).isEnabled());
  record("publish: unready snapshot and old selected PC block LIVE even when global publishing is on");
  await navigate("/dashboard/schedules", "예약 발행");
  await page.evaluate(() => window.__uiSmoke.setLive());
  await page.locator("#schedule-space").selectOption("space-threads");
  await page.locator("#schedule-text").fill("주소만 있는 예약 테스트");
  await page.locator("#schedule-media").fill("https://media.fixture.invalid/source.png");
  await page.getByRole("button", { name: "예약 등록", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__uiSmoke.calls.filter((call) => call.name === "schedules:create").length), 0);
  assert.equal(await page.locator("#schedule-issues").evaluate((element) => element === document.activeElement), true);
  await layout("schedule-media-gate", 320);
  record("schedules: remote media without an immutable piece never creates a LIVE schedule and focuses recovery guidance");
  assert.deepEqual(errors, [], "No uncaught React/browser errors");
  record("no uncaught React/browser errors");
  assert(checks.every((check) => check.passed), `Layout failures: ${checks.filter((check) => !check.passed).map((check) => check.name).join(", ")}`);
} catch (error) {
  failed = error;
  await page.screenshot({ path: join(outputDir, "failure.png"), fullPage: true });
  checks.push({ name: "smoke failure", passed: false, error: error.message });
} finally {
  const report = { mocked: true, description: "Actual React pages with mocked Convex/Next boundaries. No production authentication, data or external publishing tested.", checkedAt: new Date().toISOString(), checks, browserErrors: errors, passed: !failed };
  await writeFile(join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed: !failed, checks: checks.length, report: join(outputDir, "report.json"), error: failed?.message ?? null }));
}
if (process.argv.includes("--serve")) {
  console.log("Loopback fixture server remains available; stop the Node process to close it.");
} else {
  await new Promise((done) => server.close(done));
  if (failed) process.exitCode = 1;
}
