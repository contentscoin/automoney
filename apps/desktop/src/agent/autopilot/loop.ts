import type { Page } from "playwright";
import { executeAction, isForbidden, isPreparationLike, isPublishLike, prepareClickAction, resolveAllowedNavigationUrl, validateAction, type Action } from "./actions";
import type { Planner, PlannerInput } from "./planner";
import { capturePublishReceiptBaseline, verifyPublishReceipt, type PublishReceiptBaseline } from "./receipt";
import { takeSnapshot } from "./snapshot";

export interface AutopilotOptions {
  goal: string;
  platform: string;
  text: string;
  mediaPaths: string[];
  /** 테스트 실행에서는 모델이 제안한 모든 click 을 실행 전에 차단한다. */
  dryRun?: boolean;
  /** 게시 결과 URL이 귀속되어야 하는 선택 SNS 계정. */
  expectedHandle?: string | null;
  maxSteps?: number;
  maxMs?: number;
  /** 발행 직전 게이트: false 면 발행 버튼을 누르지 않고 ready 로 종료 */
  beforePublish: () => Promise<boolean>;
  /** 승인된 submit click 을 dispatch하기 직전에 알린다. 이후 click 실패도 결과 불확실로 취급한다. */
  onPublishAttempted?: () => Promise<void> | void;
  onStep?: (step: number, action: Action, outcome: string) => Promise<void> | void;
}

export interface AutopilotResult {
  ok: boolean;
  summary: string;
  postUrl: string | null;
  steps: number;
  /** 승인된 submit click dispatch를 시도해 외부 게시 결과가 불확실할 수 있는지 */
  publishAttempted: boolean;
  reason?: string;
}

/** 스냅샷 → 플래너 → 액션 루프. 금지 액션·발행 게이트를 강제한다. */
export async function runAutopilot(page: Page, planner: Planner, opts: AutopilotOptions): Promise<AutopilotResult> {
  const maxSteps = opts.maxSteps ?? 15;
  const deadline = Date.now() + (opts.maxMs ?? 4 * 60_000);
  const history: PlannerInput["history"] = [];
  let publishAllowed = false;
  let publishActionExecuted = false;
  let publishAttempted = false;
  let receiptBaseline: PublishReceiptBaseline | null = null;
  let sawUnverifiedDone = false;
  for (let step = 1; step <= maxSteps; step++) {
    if (Date.now() > deadline) return { ok: false, summary: "timeout", postUrl: null, steps: step - 1, publishAttempted, reason: "AUTOPILOT_TIMEOUT" };
    const snapshot = await takeSnapshot(page);
    const proposed = await planner.next({ goal: opts.goal, platform: opts.platform, text: opts.text, hasMedia: opts.mediaPaths.length > 0, snapshot, history, publishAllowed });
    const action = validateAction(proposed);
    if (!action) {
      await opts.onStep?.(step, { type: "fail", reason: "invalid planner action" }, "blocked invalid planner action");
      return { ok: false, summary: "invalid planner action", postUrl: null, steps: step, publishAttempted, reason: "AUTOPILOT_INVALID_ACTION" };
    }
    let outcome: string;
    if (action.type === "done") {
      if (action.summary === "ready") {
        if (opts.dryRun) return { ok: true, summary: "ready (not published)", postUrl: null, steps: step, publishAttempted };
        // "ready" is only a local planner milestone. Do not reserve an external
        // publish intent until a recognized submit is actually about to click.
        publishAllowed = true;
        history.push({ step, action, outcome: "ready acknowledged, continue" });
        await opts.onStep?.(step, action, "ready acknowledged");
        continue;
      }
      if (!publishAllowed || !publishActionExecuted || !receiptBaseline) {
        outcome = "blocked done without approved publish action";
        sawUnverifiedDone = true;
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        continue;
      }
      const receipt = await verifyPublishReceipt(page, opts.platform, receiptBaseline);
      if (!receipt.verified) {
        outcome = `unverified publish receipt: ${receipt.reason ?? "missing"}`;
        sawUnverifiedDone = true;
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        await page.waitForTimeout(400);
        continue;
      }
      await opts.onStep?.(step, action, `done (${receipt.source})`);
      return { ok: true, summary: action.summary, postUrl: receipt.postUrl, steps: step, publishAttempted };
    }
    if (action.type === "fail") {
      await opts.onStep?.(step, action, "fail");
      return { ok: false, summary: action.reason, postUrl: null, steps: step, publishAttempted, reason: "AUTOPILOT_FAILED" };
    }
    if (publishAttempted && action.type !== "wait" && action.type !== "scroll") {
      outcome = `blocked ${action.type} after irreversible publish attempt`;
      history.push({ step, action, outcome });
      await opts.onStep?.(step, action, outcome);
      return { ok: false, summary: outcome, postUrl: null, steps: step, publishAttempted, reason: "AUTOPILOT_PUBLISH_LATCHED" };
    }
    let approvedPublishClick = false;
    let actionToExecute = action;
    if (action.type === "navigate") {
      const allowed = resolveAllowedNavigationUrl(action.url, opts.platform, snapshot.url);
      if (!allowed) {
        outcome = `blocked navigation outside ${opts.platform}`;
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        return { ok: false, summary: outcome, postUrl: null, steps: step, publishAttempted, reason: "AUTOPILOT_NAVIGATION_BLOCKED" };
      }
      actionToExecute = { ...action, url: allowed };
    }
    if (action.type === "click" || action.type === "type" || action.type === "upload") {
      const el = snapshot.elements.find((e) => e.ref === action.ref);
      if (!el) {
        outcome = `unknown ref ${action.ref}`;
        history.push({ step, action, outcome });
        continue;
      }
      if (el.disabled) {
        outcome = `blocked disabled control ${action.ref}`;
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        continue;
      }
      if (action.type === "type" && (!el.editable || el.fileInput || el.submitControl || (/\r|\n/.test(action.text) && !el.multiline) || action.text !== opts.text || history.some((item) => item.action.type === "type" && item.outcome.startsWith("typed ")))) {
        outcome = "blocked non-editor, altered text, or duplicate typing";
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        continue;
      }
      if (action.type === "upload" && (!el.fileInput || opts.mediaPaths.length === 0 || history.some((item) => item.action.type === "upload" && item.outcome.startsWith("uploaded ")))) {
        outcome = "blocked invalid or duplicate upload";
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        continue;
      }
      if (action.type === "click" && isForbidden(el.name)) {
        outcome = `blocked forbidden control "${el.name}"`;
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        continue;
      }
      const draftChanged = history.some((item) => (item.action.type === "type" && item.outcome.startsWith("typed ")) || (item.action.type === "upload" && item.outcome.startsWith("uploaded ")));
      const recognizedSubmit = action.type === "click" && (isPublishLike(el.name) || !!el.submitControl);
      const recognizedPreparation = action.type === "click" && isPreparationLike(el.name);
      if (action.type === "click" && opts.dryRun) {
        outcome = `blocked click in dry-run (${action.ref})`;
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        return { ok: true, summary: "ready (not published)", postUrl: null, steps: step, publishAttempted };
      }
      if (action.type === "click" && !recognizedSubmit && (draftChanged || !recognizedPreparation)) {
        outcome = `blocked unrecognized click (${action.ref})`;
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        continue;
      }
      if (recognizedSubmit) {
        // Finish all potentially long Playwright actionability waits before the
        // server authorizes and records an irreversible publishing attempt.
        await prepareClickAction(page, action.ref, 20_000);
        const candidateBaseline = await capturePublishReceiptBaseline(page, opts.platform, opts.expectedHandle ?? null);
        // The server authorization must be adjacent to every submit click.
        publishAllowed = await opts.beforePublish();
        if (!publishAllowed) {
          receiptBaseline = null;
          return { ok: true, summary: "ready (not published)", postUrl: null, steps: step, publishAttempted };
        }
        receiptBaseline = candidateBaseline;
        approvedPublishClick = true;
      }
    }
    // A receipt is attributable only to the recognized submit click immediately
    // preceding passive waits/scrolls. Later mutation or navigation invalidates it.
    if (["click", "type", "upload", "navigate"].includes(action.type)) {
      publishActionExecuted = false;
      if (!approvedPublishClick) receiptBaseline = null;
    }
    if (approvedPublishClick) {
      // A provider-side submit can happen even when Playwright later rejects
      // while waiting for navigation or because the DOM detached. Cross the
      // irreversible boundary before calling click so the reservation can
      // never be released and retried as a duplicate.
      publishActionExecuted = true;
      publishAttempted = true;
      await opts.onPublishAttempted?.();
    }
    try {
      outcome = await executeAction(page, actionToExecute, {
        mediaPaths: opts.mediaPaths,
        canNavigate: (url) => resolveAllowedNavigationUrl(url, opts.platform, snapshot.url) === url,
        preparedClick: approvedPublishClick,
        clickTimeout: approvedPublishClick ? 3_000 : undefined,
      });
    } catch (e) {
      outcome = `error: ${(e as Error).message.split("\n")[0]}`;
      if (outcome.includes("blocked navigation")) {
        await opts.onStep?.(step, actionToExecute, outcome);
        return { ok: false, summary: outcome, postUrl: null, steps: step, publishAttempted, reason: "AUTOPILOT_NAVIGATION_BLOCKED" };
      }
    }
    history.push({ step, action: actionToExecute, outcome });
    await opts.onStep?.(step, actionToExecute, outcome);
    await page.waitForTimeout(400);
  }
  return sawUnverifiedDone
    ? { ok: false, summary: "publish result was not verified", postUrl: null, steps: maxSteps, publishAttempted, reason: "AUTOPILOT_UNVERIFIED_RECEIPT" }
    : { ok: false, summary: "max steps reached", postUrl: null, steps: maxSteps, publishAttempted, reason: "AUTOPILOT_MAX_STEPS" };
}
