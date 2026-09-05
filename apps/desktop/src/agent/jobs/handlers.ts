import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { okResult, type PublishPayload } from "@automoney/shared";
import { codexStatus, startCodexLogin } from "../codex";
import { createCodexPlanner, runAutopilot, scriptedPlanner, type Planner } from "../autopilot";
import { log } from "../logger";
import { getRecipe, type RecipeHelpers, type SessionCheck } from "../recipes";
import { appendHistory, createSpace, openSpace, readMeta, writeMeta } from "../spaces/manager";
import { JobError, type JobContext, type JobOutcome } from "./context";

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function helpers(ctx: JobContext, opts: { dryRun: boolean }): RecipeHelpers {
  return {
    async humanType(page, selector, text) {
      const target = selector ? page.locator(selector).first() : page.locator(":focus").first();
      // 문장 단위로 끊어 사람처럼 입력
      for (const chunk of text.match(/[^\n]{1,40}(\s|$)|\n/g) ?? [text]) {
        await target.pressSequentially(chunk, { delay: rand(35, 110) });
        if (Math.random() < 0.15) await sleep(rand(250, 700));
      }
    },
    checkpoint: (stage, progress) => ctx.checkpoint(stage, progress),
    async beforePublish() {
      await ctx.checkpoint("before_publish", 80);
      return !opts.dryRun;
    },
    async waitHuman(min = 400, max = 1400) {
      await sleep(rand(min, max));
    },
  };
}

async function downloadMedia(urls: string[]): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-media-"));
  const out: string[] = [];
  for (const [i, url] of urls.entries()) {
    const res = await fetch(url);
    if (!res.ok) throw new JobError("RECIPE_FAILED", `media download failed: ${url} (${res.status})`);
    const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png" : "jpg";
    const p = path.join(dir, `media-${i}.${ext}`);
    fs.writeFileSync(p, Buffer.from(await res.arrayBuffer()));
    out.push(p);
  }
  return out;
}

export async function handleSpaceCreate(ctx: JobContext): Promise<JobOutcome> {
  const p = ctx.job.payload as { spaceId: string; platform: string; name: string; handle?: string | null };
  await ctx.checkpoint("creating", 20);
  const meta = createSpace({ spaceId: p.spaceId, platform: p.platform, name: p.name, handle: p.handle ?? null });
  await ctx.checkpoint("created", 90);
  return { result: okResult("space.create", `스페이스 프로필 생성 (${p.platform})`, { fingerprint: meta.fingerprint }), spaceUpdate: { sessionState: "LOGIN_REQUIRED", fingerprint: meta.fingerprint } };
}

/** 사용자 로그인: 창을 보이게 열고 세션이 HEALTHY 가 될 때까지 대기(최대 10분). */
export async function handleSpaceLogin(ctx: JobContext): Promise<JobOutcome> {
  const p = ctx.job.payload as { spaceId: string; platform: string };
  const recipe = getRecipe(p.platform);
  if (!recipe) throw new JobError("RECIPE_UNSUPPORTED", `${p.platform} 은 아직 브라우저 레시피가 없습니다.`);
  if (!readMeta(p.spaceId)) createSpace({ spaceId: p.spaceId, platform: p.platform, name: p.spaceId });
  const space = await openSpace(ctx.cfg, p.spaceId, { visible: true, purpose: "login" });
  try {
    ctx.onUserAttention?.(`[${p.platform}] 로그인 창이 열렸습니다. 로그인 후 창을 그대로 두세요.`);
    await space.page.goto(recipe.loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    const deadline = Date.now() + Number(process.env.AUTOMONEY_LOGIN_WAIT_MS ?? 10 * 60_000);
    let last: SessionCheck = await recipe.checkSession(space.page).catch((): SessionCheck => ({ state: "LOGIN_REQUIRED" }));
    while (last.state !== "HEALTHY" && Date.now() < deadline) {
      await ctx.checkpoint("waiting_login", 50);
      await sleep(5000);
      last = await recipe.checkSession(space.page).catch(() => last);
      if (last.state === "RESTRICTED") break;
    }
    appendHistory(p.spaceId, { action: "space.login", state: last.state, handle: last.handle ?? null });
    if (last.state === "HEALTHY") {
      const meta = readMeta(p.spaceId)!;
      writeMeta({ ...meta, lastLoginAt: Date.now(), handle: last.handle ?? meta.handle });
      return { result: okResult("space.login", "로그인 완료", { handle: last.handle ?? null }), spaceUpdate: { sessionState: "HEALTHY", ...(last.handle ? { handle: last.handle } : {}) } };
    }
    if (last.state === "RESTRICTED") throw new JobError("SPACE_ACCOUNT_RESTRICTED", "계정 제한 안내가 감지되었습니다.", { sessionState: "RESTRICTED" });
    throw new JobError("SPACE_SESSION_EXPIRED", "로그인이 완료되지 않았습니다(시간 초과).", { sessionState: "LOGIN_REQUIRED" });
  } finally {
    await space.close();
  }
}

export async function handleSpaceVerify(ctx: JobContext): Promise<JobOutcome> {
  const p = ctx.job.payload as { spaceId: string; platform: string };
  const recipe = getRecipe(p.platform);
  if (!recipe) throw new JobError("RECIPE_UNSUPPORTED", `${p.platform} 은 아직 브라우저 레시피가 없습니다.`);
  const space = await openSpace(ctx.cfg, p.spaceId, { visible: false, purpose: "verify" });
  try {
    await ctx.checkpoint("verifying", 40);
    const check = await recipe.checkSession(space.page);
    appendHistory(p.spaceId, { action: "space.verify", state: check.state });
    const state = check.state === "HEALTHY" ? "HEALTHY" : check.state === "RESTRICTED" ? "RESTRICTED" : "EXPIRED";
    return { result: okResult("space.verify", `세션 상태: ${state}`, { detail: check.detail ?? null, handle: check.handle ?? null }), spaceUpdate: { sessionState: state, ...(check.handle ? { handle: check.handle } : {}) } };
  } finally {
    await space.close();
  }
}

export async function handlePublish(ctx: JobContext): Promise<JobOutcome> {
  const p = ctx.job.payload as unknown as PublishPayload;
  const recipe = getRecipe(p.platform);
  if (!recipe) throw new JobError("RECIPE_UNSUPPORTED", `${p.platform} 은 아직 브라우저 레시피가 없습니다.`);
  const text = p.linkUrl ? `${p.text.trim()}\n${p.linkUrl}` : p.text.trim();
  const dryRun = Boolean(p.dryRun) || process.env.AUTOMONEY_DRY_RUN === "1";
  await ctx.checkpoint("preparing", 5);
  const mediaPaths = p.mediaUrls.length ? await downloadMedia(p.mediaUrls) : [];
  const space = await openSpace(ctx.cfg, p.spaceId, { visible: false, purpose: "publish", waitLockMs: 30_000 });
  try {
    const session = await recipe.checkSession(space.page);
    if (session.state === "RESTRICTED") throw new JobError("SPACE_ACCOUNT_RESTRICTED", "계정 제한 안내가 감지되었습니다.", { sessionState: "RESTRICTED" });
    if (session.state !== "HEALTHY") throw new JobError("SPACE_SESSION_EXPIRED", "세션이 만료되었습니다. 스페이스에서 다시 로그인하세요.", { sessionState: "EXPIRED" });
    let outcome: { postUrl: string | null; detail?: string };
    let recoveredBy: string | null = null;
    try {
      outcome = await recipe.publish(space.page, { text, mediaPaths }, helpers(ctx, { dryRun }));
    } catch (recipeError) {
      if ((recipeError as { code?: string }).code === "JOB_CANCELLED" || (recipeError as Error).name === "CancelledError") throw recipeError;
      const planner = pickPlanner(ctx);
      if (!planner) throw new JobError("RECIPE_FAILED", `레시피 실패: ${(recipeError as Error).message.split("\n")[0]}`);
      log("warn", "recipe failed — trying autopilot", { spaceId: p.spaceId, planner: planner.name, error: String(recipeError).slice(0, 200) });
      await ctx.checkpoint("autopilot", 40);
      await space.page.goto(recipe.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      const ap = await runAutopilot(space.page, planner, {
        goal: `Publish a new post on ${p.platform} with the given text${mediaPaths.length ? " and attached media" : ""}, then report the post URL.`,
        platform: p.platform,
        text,
        mediaPaths,
        maxSteps: Number(process.env.AUTOMONEY_AUTOPILOT_MAX_STEPS ?? 15),
        beforePublish: async () => {
          await ctx.checkpoint("before_publish", 80);
          return !dryRun;
        },
        onStep: async (step, action, out) => {
          appendHistory(p.spaceId, { action: "autopilot.step", step, type: action.type, outcome: out });
          await ctx.checkpoint(`autopilot:${step}`, Math.min(40 + step * 3, 85));
        },
      });
      if (!ap.ok) throw new JobError("RECIPE_FAILED", `레시피 실패 후 오토파일럿도 실패: ${ap.summary}`);
      outcome = { postUrl: ap.postUrl, detail: `autopilot(${planner.name}) ${ap.summary} in ${ap.steps} steps` };
      recoveredBy = planner.name;
    }
    appendHistory(p.spaceId, { action: "post.publish", dryRun, postUrl: outcome.postUrl, chars: text.length, recoveredBy });
    log("info", "published", { spaceId: p.spaceId, dryRun, postUrl: outcome.postUrl, recoveredBy });
    return {
      result: okResult("post.publish", dryRun ? "테스트 실행(게시 안 함)" : "게시 완료", { postUrl: outcome.postUrl, dryRun, detail: outcome.detail ?? null, recoveredBy }),
      spaceUpdate: { sessionState: "HEALTHY", ...(session.handle ? { handle: session.handle } : {}) },
    };
  } finally {
    await space.close();
    for (const m of mediaPaths) fs.rmSync(m, { force: true });
  }
}

/** 오토파일럿 플래너 선택: 테스트용 scripted, 아니면 설정 on + Codex 로그인 시 codex */
function pickPlanner(ctx: JobContext): Planner | null {
  const forced = process.env.AUTOMONEY_AUTOPILOT_PLANNER;
  if (forced === "scripted") return scriptedPlanner;
  if (forced === "off") return null;
  if (!ctx.cfg.autopilot && forced !== "codex") return null;
  const st = codexStatus();
  if (!st.loggedIn) {
    log("warn", "autopilot requested but codex not logged in", st);
    return null;
  }
  return createCodexPlanner();
}

export async function handleCodexLogin(ctx: JobContext): Promise<JobOutcome> {
  const before = codexStatus();
  if (before.loggedIn) return { result: okResult("codex.login", "이미 로그인됨", before) };
  if (!before.installed) throw new JobError("CODEX_LOGIN_REQUIRED", "codex CLI 가 설치되어 있지 않습니다. https://developers.openai.com/codex 에서 설치하세요.");
  const started = startCodexLogin();
  ctx.onUserAttention?.("Codex 로그인 브라우저가 열렸습니다. ChatGPT 계정으로 로그인하세요.");
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await ctx.checkpoint("waiting_codex_login", 50);
    await sleep(5000);
    if (codexStatus().loggedIn) return { result: okResult("codex.login", "Codex 로그인 완료", { started: started.detail }) };
  }
  throw new JobError("CODEX_LOGIN_REQUIRED", "Codex 로그인이 완료되지 않았습니다.");
}
