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
await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
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
