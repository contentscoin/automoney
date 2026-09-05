import type { Page } from "playwright";
import { executeAction, isForbidden, isPublishLike, type Action } from "./actions";
import type { Planner, PlannerInput } from "./planner";
import { takeSnapshot } from "./snapshot";

export interface AutopilotOptions {
  goal: string;
  platform: string;
  text: string;
  mediaPaths: string[];
  maxSteps?: number;
  maxMs?: number;
  /** 발행 직전 게이트: false 면 발행 버튼을 누르지 않고 ready 로 종료 */
  beforePublish: () => Promise<boolean>;
  onStep?: (step: number, action: Action, outcome: string) => Promise<void> | void;
}

export interface AutopilotResult {
  ok: boolean;
  summary: string;
  postUrl: string | null;
  steps: number;
  reason?: string;
}

/** 스냅샷 → 플래너 → 액션 루프. 금지 액션·발행 게이트를 강제한다. */
export async function runAutopilot(page: Page, planner: Planner, opts: AutopilotOptions): Promise<AutopilotResult> {
  const maxSteps = opts.maxSteps ?? 15;
  const deadline = Date.now() + (opts.maxMs ?? 4 * 60_000);
  const history: PlannerInput["history"] = [];
  let publishAllowed = false;
  let publishChecked = false;
  for (let step = 1; step <= maxSteps; step++) {
    if (Date.now() > deadline) return { ok: false, summary: "timeout", postUrl: null, steps: step - 1, reason: "AUTOPILOT_TIMEOUT" };
    const snapshot = await takeSnapshot(page);
    const action = await planner.next({ goal: opts.goal, platform: opts.platform, text: opts.text, hasMedia: opts.mediaPaths.length > 0, snapshot, history, publishAllowed });
    let outcome: string;
    if (action.type === "done") {
      if (action.summary === "ready" && !publishChecked) {
        publishChecked = true;
        publishAllowed = await opts.beforePublish();
        if (!publishAllowed) return { ok: true, summary: "ready (not published)", postUrl: null, steps: step };
        history.push({ step, action, outcome: "publish allowed, continue" });
        await opts.onStep?.(step, action, "publish allowed");
        continue;
      }
      await opts.onStep?.(step, action, "done");
      return { ok: true, summary: action.summary, postUrl: action.postUrl ?? null, steps: step };
    }
    if (action.type === "fail") {
      await opts.onStep?.(step, action, "fail");
      return { ok: false, summary: action.reason, postUrl: null, steps: step, reason: "AUTOPILOT_FAILED" };
    }
    if (action.type === "click" || action.type === "type" || action.type === "upload") {
      const el = snapshot.elements.find((e) => e.ref === action.ref);
      if (!el) {
        outcome = `unknown ref ${action.ref}`;
        history.push({ step, action, outcome });
        continue;
      }
      if (action.type === "click" && isForbidden(el.name)) {
        outcome = `blocked forbidden control "${el.name}"`;
        history.push({ step, action, outcome });
        await opts.onStep?.(step, action, outcome);
        continue;
      }
      if (action.type === "click" && isPublishLike(el.name)) {
        if (!publishChecked) {
          publishChecked = true;
          publishAllowed = await opts.beforePublish();
        }
        if (!publishAllowed) return { ok: true, summary: "ready (not published)", postUrl: null, steps: step };
      }
    }
    try {
      outcome = await executeAction(page, action, { mediaPaths: opts.mediaPaths });
    } catch (e) {
      outcome = `error: ${(e as Error).message.split("\n")[0]}`;
    }
    history.push({ step, action, outcome });
    await opts.onStep?.(step, action, outcome);
    await page.waitForTimeout(400);
  }
  return { ok: false, summary: "max steps reached", postUrl: null, steps: maxSteps, reason: "AUTOPILOT_MAX_STEPS" };
}
