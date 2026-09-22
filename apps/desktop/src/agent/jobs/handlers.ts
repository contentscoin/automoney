import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { lookup } from "node:dns/promises";
import {
  buildGenerationPrompt,
  buildRepairPrompt,
  DEFAULT_CONTENT_STANDARD,
  evaluatePiece,
  isAutoApprovable,
  okResult,
  parseGeneratedPieces,
  passesContentStandard,
  templateGenerate,
  type Channel,
  type ContentGeneratePayload,
  type ContentRepairFailure,
  type GeneratedPiece,
  type GenerationInput,
  type PublishPayload,
  type QualityReport,
  type ReadbackPayload,
} from "@automoney/shared";
import { codexGenerateText, type CodexRunMetadata } from "../codexText";
import { codexStatus, startCodexLogin } from "../codex";
import { capturePublishReceiptBaseline, createCodexPlanner, normalizePublishHandle, runAutopilot, scriptedPlanner, verifyPublishReceipt, type Planner, type PublishReceiptBaseline } from "../autopilot";
import { log } from "../logger";
import { getRecipe, type RecipeHelpers, type SessionCheck } from "../recipes";
import { readPostMetrics } from "../recipes/readback";
import { appendHistory, createSpace, openSpace, readMeta, writeMeta } from "../spaces/manager";
import { JobError, type JobContext, type JobOutcome } from "./context";

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function beforePublishGate(ctx: JobContext, dryRun: boolean): Promise<boolean> {
  await ctx.checkpoint("before_publish", 80);
  if (dryRun) return false;
  const preflight = await ctx.api.preflight(ctx.job);
  if (preflight.dryRun || !preflight.livePublishEnabled || !preflight.publishIntentId) {
    throw new JobError("INTERNAL", "실게시 직전 서버 사전검증 결과가 유효하지 않습니다.");
  }
  return true;
}

export function resolvePublishDryRun(payloadDryRun: boolean | undefined, localOverride = process.env.AUTOMONEY_DRY_RUN): boolean {
  if (localOverride === "1" && payloadDryRun !== true) {
    throw new JobError(
      "LOCAL_DRY_RUN_OVERRIDE",
      "로컬 dry-run 안전 모드가 실게시 작업을 차단했습니다. 서버에서 테스트 실행으로 다시 등록하세요.",
    );
  }
  return payloadDryRun === true;
}

export function requireMatchingPublishHandle(storedHandle: string | null | undefined, sessionHandle: string | null | undefined): string {
  const expected = normalizePublishHandle(storedHandle);
  const observed = normalizePublishHandle(sessionHandle);
  if (!expected || !observed || expected !== observed) {
    throw new JobError("SPACE_ACCOUNT_MISMATCH", "선택한 게시 계정과 현재 브라우저에 로그인된 계정을 일치시킬 수 없습니다. 연결 관리에서 계정을 다시 확인하세요.");
  }
  return expected;
}

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
    beforePublish: () => beforePublishGate(ctx, opts.dryRun),
    async revalidatePublishContinuation() {
      await ctx.api.revalidatePublishContinuation(ctx.job);
    },
    async waitHuman(min = 400, max = 1400) {
      await sleep(rand(min, max));
    },
  };
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  return false;
}

async function assertPublicMediaUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new JobError("MEDIA_URL_BLOCKED", "invalid media URL"); }
  const allowPrivateFixtures = process.env.AUTOMONEY_ALLOW_PRIVATE_MEDIA === "1" && process.env.NODE_ENV !== "production";
  if (url.protocol !== "https:" && !(allowPrivateFixtures && url.protocol === "http:")) throw new JobError("MEDIA_URL_BLOCKED", "media URL must use https");
  if (allowPrivateFixtures) return url;
  if (url.username || url.password || url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new JobError("MEDIA_URL_BLOCKED", "local media URL is not allowed");
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) throw new JobError("MEDIA_URL_BLOCKED", "private or unresolved media host is not allowed");
  return url;
}

export async function downloadMedia(urls: string[], fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-media-"));
  const out: string[] = [];
  for (const [i, raw] of urls.entries()) {
    let url = await assertPublicMediaUrl(raw);
    let res: Response | null = null;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try { res = await fetchImpl(url, { redirect: "manual", signal: controller.signal }); } finally { clearTimeout(timer); }
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get("location");
      if (!location || redirects === 3) throw new JobError("MEDIA_REDIRECT", "media redirect limit exceeded");
      url = await assertPublicMediaUrl(new URL(location, url).toString());
    }
    if (!res?.ok) throw new JobError("MEDIA_DOWNLOAD_FAILED", `media download failed (${res?.status ?? 0})`);
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.toLowerCase();
    if (!/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/.test(mime)) throw new JobError("MEDIA_TYPE_UNSUPPORTED", `unsupported media type: ${mime || "unknown"}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > 20 * 1024 * 1024) throw new JobError("MEDIA_TOO_LARGE", "media exceeds 20MB");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new JobError("MEDIA_TOO_LARGE", "media exceeds 20MB");
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : mime === "video/mp4" ? "mp4" : mime === "video/webm" ? "webm" : "jpg";
    const p = path.join(dir, `media-${i}.${ext}`);
    fs.writeFileSync(p, bytes);
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
    let last: SessionCheck = await recipe.checkSession(space.page, { navigate: false }).catch((): SessionCheck => ({ state: "LOGIN_REQUIRED" }));
    while (last.state !== "HEALTHY" && Date.now() < deadline) {
      await ctx.checkpoint("waiting_login", 50);
      await sleep(5000);
      last = await recipe.checkSession(space.page, { navigate: false }).catch(() => last);
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
  const dryRun = resolvePublishDryRun(p.dryRun);
  const recipe = getRecipe(p.platform);
  if (!recipe) throw new JobError("RECIPE_UNSUPPORTED", `${p.platform} 은 아직 브라우저 레시피가 없습니다.`);
  const text = p.linkUrl ? `${p.text.trim()}\n${p.linkUrl}` : p.text.trim();
  await ctx.checkpoint("preparing", 5);
  const mediaPaths = p.mediaUrls.length ? await downloadMedia(p.mediaUrls) : [];
  const space = await openSpace(ctx.cfg, p.spaceId, { visible: false, purpose: "publish", waitLockMs: 30_000 });
  try {
    const session = await recipe.checkSession(space.page);
    if (session.state === "RESTRICTED") throw new JobError("SPACE_ACCOUNT_RESTRICTED", "계정 제한 안내가 감지되었습니다.", { sessionState: "RESTRICTED" });
    if (session.state !== "HEALTHY") throw new JobError("SPACE_SESSION_EXPIRED", "세션이 만료되었습니다. 스페이스에서 다시 로그인하세요.", { sessionState: "EXPIRED" });
    const expectedHandle = requireMatchingPublishHandle(ctx.job.space?.handle, session.handle);
    let outcome: { postUrl: string | null; detail?: string };
    let recoveredBy: string | null = null;
    let publishStarted = false;
    let recipeReceiptBaseline: PublishReceiptBaseline | null = null;
    const recipeHelpers = helpers(ctx, { dryRun });
    try {
      outcome = await recipe.publish(space.page, { text, mediaPaths }, {
        ...recipeHelpers,
        beforePublish: async () => {
          if (!dryRun) {
            recipeReceiptBaseline = await capturePublishReceiptBaseline(space.page, p.platform, expectedHandle);
          }
          const allowed = await recipeHelpers.beforePublish();
          if (allowed) {
            await ctx.api.markPublishAttempted(ctx.job);
          }
          publishStarted = allowed;
          return allowed;
        },
      });
      if (!dryRun) {
        if (!recipeReceiptBaseline) throw new JobError("PUBLISH_RESULT_UNCERTAIN", "게시 직전 기준 화면을 확인하지 못했습니다. SNS에서 게시 여부를 직접 확인하세요.");
        const receipt = await verifyPublishReceipt(space.page, p.platform, recipeReceiptBaseline);
        if (!receipt.verified || !receipt.postUrl) {
          throw new JobError("PUBLISH_RESULT_UNCERTAIN", "게시 버튼 실행 후 새 게시물 URL을 확인하지 못했습니다. SNS에서 게시 여부를 직접 확인하세요.");
        }
        outcome = { ...outcome, postUrl: receipt.postUrl, detail: `${outcome.detail ? `${outcome.detail}; ` : ""}verified ${receipt.source}` };
      }
    } catch (recipeError) {
      if (publishStarted) {
        throw new JobError(
          "PUBLISH_RESULT_UNCERTAIN",
          "게시 버튼 실행 후 결과를 확인하지 못했습니다. 자동 재게시하지 않으니 SNS에서 게시 여부를 직접 확인하세요.",
        );
      }
      if ((recipeError as { code?: string }).code === "JOB_CANCELLED" || (recipeError as Error).name === "CancelledError") throw recipeError;
      if (dryRun) {
        throw new JobError(
          "RECIPE_FAILED",
          `테스트 실행 레시피 실패: ${(recipeError as Error).message.split("\n")[0]}. dry-run에서는 오토파일럿 복구를 실행하지 않았습니다.`,
        );
      }
      const planner = pickPlanner(ctx);
      if (!planner) throw new JobError("RECIPE_FAILED", `레시피 실패: ${(recipeError as Error).message.split("\n")[0]}`);
      log("warn", "recipe failed — trying autopilot", { spaceId: p.spaceId, planner: planner.name, error: String(recipeError).slice(0, 200) });
      await ctx.checkpoint("autopilot", 40);
      await space.page.goto(recipe.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      let autopilotPublishAttempted = false;
      let ap: Awaited<ReturnType<typeof runAutopilot>>;
      try {
        ap = await runAutopilot(space.page, planner, {
          goal: `Publish a new post on ${p.platform} with the given text${mediaPaths.length ? " and attached media" : ""}, then report the post URL.`,
          platform: p.platform,
          text,
          mediaPaths,
          dryRun,
          expectedHandle,
          maxSteps: Number(process.env.AUTOMONEY_AUTOPILOT_MAX_STEPS ?? 15),
          beforePublish: () => recipeHelpers.beforePublish(),
          onPublishAttempted: async () => {
            await ctx.api.markPublishAttempted(ctx.job);
            autopilotPublishAttempted = true;
          },
          onStep: async (step, action, out) => {
            appendHistory(p.spaceId, { action: "autopilot.step", step, type: action.type, outcome: out });
            await ctx.checkpoint(`autopilot:${step}`, Math.min(40 + step * 3, 85));
          },
        });
      } catch (autopilotError) {
        if (autopilotPublishAttempted) {
          throw new JobError(
            "PUBLISH_RESULT_UNCERTAIN",
            "게시 버튼 실행 후 결과를 확인하지 못했습니다. 자동 재게시하지 않으니 SNS에서 게시 여부를 직접 확인하세요.",
          );
        }
        throw autopilotError;
      }
      if (!ap.ok) {
        if (ap.publishAttempted) {
          throw new JobError(
            "PUBLISH_RESULT_UNCERTAIN",
            "게시 버튼 실행 후 결과를 확인하지 못했습니다. 자동 재게시하지 않으니 SNS에서 게시 여부를 직접 확인하세요.",
          );
        }
        throw new JobError("RECIPE_FAILED", `레시피 실패 후 오토파일럿도 실패: ${ap.summary}`);
      }
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

export type ContentProvider = "codex" | "template";
type ContentResultProvider = ContentProvider | "mixed";

type EvaluatedCandidate = { piece: GeneratedPiece; report: QualityReport };

/**
 * 콘텐츠 생성: 클라우드 LLM 없이 유저 PC 의 Codex 가 생성(ADR-0005).
 * V2 계약 잡은 실패한 채널만 최대 3회 교정하고, 끝까지 미달인 결과와
 * 템플릿 폴백은 provenance를 보존한 검토용 초안으로 서버에 전달한다.
 */
export async function handleContentGenerate(ctx: JobContext, deps: { generate?: (prompt: string) => Promise<{ ok: true; text: string; metadata?: CodexRunMetadata } | { ok: false; reason: string }> } = {}): Promise<JobOutcome> {
  const p = ctx.job.payload as unknown as ContentGeneratePayload;
  const preferred = ((process.env.AUTOMONEY_CONTENT_PROVIDER ?? "codex").toLowerCase() === "template" ? "template" : "codex") as ContentProvider;
  const channels = [...new Set(p.channels)];
  const duplicateRequestedChannels = [...new Set(p.channels.filter((channel, index) => p.channels.indexOf(channel) !== index))];
  const input: GenerationInput = {
    channels,
    atoms: p.atoms,
    products: p.products,
    magazineTitle: p.magazineTitle ?? null,
    brand: p.brand,
    playbook: p.playbook,
    avoid: p.avoid,
    runId: p.runId,
    brief: p.brief,
    standard: p.standard,
  };
  await ctx.checkpoint("preparing", 10);
  let pieces: GeneratedPiece[] = [];
  let fallbackReason: string | null = null;
  const warnings: string[] = duplicateRequestedChannels.length > 0
    ? [`중복 요청 채널 제거: ${duplicateRequestedChannels.join(", ")}`]
    : [];
  const accepted = new Map<Channel, GeneratedPiece>();
  const bestCandidate = new Map<Channel, EvaluatedCandidate>();
  let repairFailures: ContentRepairFailure[] = [];
  let attempts = 0;
  let codexMetadata: CodexRunMetadata | null = null;

  if (preferred === "codex") {
    const maxAttempts = p.standard
      ? Math.max(1, Math.min(DEFAULT_CONTENT_STANDARD.maxAttempts, Math.round(p.standard.maxAttempts || 1)))
      : 1;
    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      const pendingChannels = channels.filter((channel) => !accepted.has(channel));
      if (pendingChannels.length === 0) break;
      attempts = attemptNo;
      await ctx.checkpoint(attemptNo === 1 ? "codex_generating" : `codex_repairing_${attemptNo}`, Math.min(25 + attemptNo * 20, 80));
      const promptInput = { ...input, channels: pendingChannels };
      const prompt = attemptNo === 1
        ? buildGenerationPrompt(promptInput)
        : buildRepairPrompt(promptInput, repairFailures);
      const result = await (deps.generate ?? codexGenerateText)(prompt);
      if (!result.ok) {
        fallbackReason = result.reason;
        const nonRetryable = /(?:login|logged\s*in|install|not\s*found|로그인|설치|인증)/i.test(result.reason);
        if (!nonRetryable && attemptNo < maxAttempts) {
          repairFailures = pendingChannels.map((channel) => ({ channel }));
          warnings.push(`Codex 일시 오류로 재시도(${attemptNo}/${maxAttempts}): ${result.reason}`);
          continue;
        }
        warnings.push(`Codex 생성 중단: ${result.reason}`);
        break;
      }
      if (result.metadata) codexMetadata = result.metadata;

      const parsed = parseGeneratedPieces(result.text, pendingChannels);
      if (parsed.length === 0) {
        fallbackReason = `unparseable codex output: ${result.text.slice(0, 120)}`;
        repairFailures = pendingChannels.map((channel) => ({ channel }));
        if (attemptNo < maxAttempts) {
          warnings.push(`Codex ${attemptNo}회차 결과를 파싱하지 못해 교정 재생성`);
          continue;
        }
        break;
      }

      const byChannel = new Map<Channel, GeneratedPiece>();
      const duplicateGeneratedChannels = new Set<Channel>();
      for (const rawPiece of parsed) {
        if (byChannel.has(rawPiece.channel)) duplicateGeneratedChannels.add(rawPiece.channel);
        else byChannel.set(rawPiece.channel, { ...rawPiece, generatedBy: "codex", attemptNo });
      }
      if (duplicateGeneratedChannels.size > 0) {
        const prefix = attemptNo === 1 ? "Codex 중복 결과 제거" : `Codex ${attemptNo}회차 중복 결과 제거`;
        warnings.push(`${prefix}: ${[...duplicateGeneratedChannels].join(", ")}`);
      }

      const nextFailures: ContentRepairFailure[] = [];
      for (const channel of pendingChannels) {
        const piece = byChannel.get(channel);
        if (!piece) {
          nextFailures.push({ channel });
          continue;
        }
        if (!p.standard) {
          accepted.set(channel, piece);
          continue;
        }
        const report = evaluatePiece(piece, {
          linkExpected: true,
          products: input.products,
          brief: input.brief,
          standard: p.standard,
        });
        const previous = bestCandidate.get(channel);
        if (!previous || report.score > previous.report.score) bestCandidate.set(channel, { piece, report });
        if (passesContentStandard(report, "codex", p.standard)) accepted.set(channel, piece);
        else nextFailures.push({ channel, piece, report });
      }
      repairFailures = nextFailures;
      if (repairFailures.length > 0 && attemptNo < maxAttempts) {
        warnings.push(`품질 계약 미달 채널 교정 재생성(${attemptNo}/${maxAttempts}): ${repairFailures.map((failure) => failure.channel).join(", ")}`);
      }
    }
    if (channels.every((channel) => accepted.has(channel))) fallbackReason = null;
    if (fallbackReason) log("warn", "content.generate: codex unavailable or invalid", { reason: fallbackReason, attempts });
  }

  const unresolvedChannels = channels.filter((channel) => !accepted.has(channel) && !bestCandidate.has(channel));
  const templateByChannel = new Map<Channel, GeneratedPiece>();
  if (preferred === "template" || unresolvedChannels.length > 0) {
    await ctx.checkpoint("template_generating", 60);
    const requested = preferred === "template" ? channels : unresolvedChannels;
    for (const piece of templateGenerate({ ...input, channels: requested })) {
      templateByChannel.set(piece.channel, {
        ...piece,
        generatedBy: "template",
        attemptNo: Math.max(attempts, 1),
      });
    }
    if (preferred !== "template" && unresolvedChannels.length > 0) {
      warnings.push(`Codex 결과 누락으로 템플릿 보완: ${unresolvedChannels.join(", ")}`);
    }
  }

  pieces = channels.flatMap((channel) => {
    const piece = accepted.get(channel)
      ?? bestCandidate.get(channel)?.piece
      ?? templateByChannel.get(channel);
    return piece ? [piece] : [];
  });

  const providers = new Set(pieces.map((piece) => piece.generatedBy ?? "template"));
  const generatedBy: ContentResultProvider = providers.size > 1
    ? "mixed"
    : providers.has("codex") ? "codex" : "template";
  const quality = pieces.map((piece) => {
    const report = evaluatePiece(piece, {
      linkExpected: true,
      products: input.products,
      brief: input.brief,
      standard: p.standard,
    });
    const provider = piece.generatedBy ?? generatedBy;
    return {
      channel: piece.channel,
      provider,
      attemptNo: piece.attemptNo ?? 1,
      score: report.score,
      passed: p.standard
        ? passesContentStandard(report, provider, p.standard)
        : isAutoApprovable(report),
      violations: report.violations,
    };
  });
  const failedQualityChannels = quality.filter((item) => !item.passed).map((item) => item.channel);
  if (failedQualityChannels.length > 0) {
    warnings.push(`자동 승인 불가 — 검토 필요: ${failedQualityChannels.join(", ")}`);
  }
  if (warnings.length > 0) log("warn", "content.generate: normalized channel results", { warnings });
  await ctx.checkpoint("done", 95);
  return {
    result: okResult("content.generate", `${pieces.length}개 조각 생성 (${generatedBy})`, {
      pieces,
      generatedBy,
      engine: generatedBy === "template" ? "template" : "codex-cli",
      model: generatedBy === "template" ? null : codexMetadata?.model ?? null,
      cliVersion: generatedBy === "template" ? null : codexMetadata?.cliVersion ?? null,
      fallbackReason,
      warnings,
      attempts,
      quality,
      runId: p.runId ?? null,
      versions: p.standard ? {
        standardId: p.standard.id,
        standardVersion: p.standard.version,
        workflowVersion: p.standard.workflowVersion,
        promptVersion: p.standard.promptVersion,
        qualityVersion: p.standard.qualityVersion,
      } : null,
    }),
  };
}

/** 게시물 지표 readback(분석 루프): 스페이스 세션으로 게시물 페이지를 열어 좋아요·댓글·조회 등을 읽는다 */
export async function handleReadback(ctx: JobContext): Promise<JobOutcome> {
  const p = ctx.job.payload as unknown as ReadbackPayload;
  const recipe = getRecipe(p.platform);
  if (!recipe) throw new JobError("RECIPE_UNSUPPORTED", `${p.platform} 은 아직 브라우저 레시피가 없습니다.`);
  const url = process.env.AUTOMONEY_READBACK_URL ?? p.postUrl; // 테스트·E2E 픽스처 오버라이드
  const space = await openSpace(ctx.cfg, p.spaceId, { visible: false, purpose: "readback", waitLockMs: 30_000 });
  try {
    await ctx.checkpoint("opening_post", 30);
    await space.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = (await space.page.textContent("body").catch(() => "")) ?? "";
    if (/log in|로그인/i.test(body) && !(await space.page.locator('[data-automoney="likes"]').count())) {
      const session = await recipe.checkSession(space.page);
      if (session.state !== "HEALTHY") throw new JobError("SPACE_SESSION_EXPIRED", "세션이 만료되어 지표를 읽을 수 없습니다.", { sessionState: "EXPIRED" });
      await space.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    await ctx.checkpoint("reading", 60);
    const metrics = await readPostMetrics(space.page, p.platform);
    if (Object.keys(metrics).length === 0) throw new JobError("READBACK_FAILED", "지표 요소를 찾지 못했습니다.");
    appendHistory(p.spaceId, { action: "post.readback", window: p.window, metrics });
    return { result: okResult("post.readback", `지표 수집 (${p.window})`, { metrics, window: p.window, metricsId: p.metricsId }) };
  } finally {
    await space.close();
  }
}

/** meta.token_refresh 는 클라우드 전용 잡 — 데스크톱이 받으면 계약 위반 */
export async function handleCloudOnly(ctx: JobContext): Promise<JobOutcome> {
  throw new JobError("INTERNAL", `${ctx.job.jobType} 은 클라우드에서만 실행됩니다.`);
}
