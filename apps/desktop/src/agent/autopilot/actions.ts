import type { Page } from "playwright";
import { REF_ATTR } from "./snapshot";

export type Action =
  | { type: "click"; ref: string; reason?: string }
  | { type: "type"; ref: string; text: string; clear?: boolean; reason?: string }
  | { type: "press"; key: string; reason?: string }
  | { type: "navigate"; url: string; reason?: string }
  | { type: "scroll"; direction: "up" | "down"; reason?: string }
  | { type: "upload"; ref: string; reason?: string }
  | { type: "wait"; ms: number; reason?: string }
  | { type: "done"; summary: string; postUrl?: string | null }
  | { type: "fail"; reason: string };

/** 클릭 금지: 계정·결제·삭제 등 되돌릴 수 없는 동작 */
export const FORBIDDEN_NAME_PATTERNS = [/삭제|delete|remove account|계정 삭제/i, /탈퇴|deactivate|비활성화/i, /결제|payment|구독|subscribe|billing/i, /비밀번호|password|보안|security settings/i, /차단|block|신고|report/i, /로그아웃|log ?out|sign ?out/i];
/** 발행 계열: 게이트 통과 전 클릭 금지 */
export const PUBLISH_NAME_PATTERNS = [/^(게시|게시하기|공유|공유하기|발행|올리기|post|share|publish|tweet|send)$/i, /게시물 공유|share post|publish now/i];

export function parseAction(raw: string): Action | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const a = JSON.parse(m[0]) as Action;
    if (!a || typeof a !== "object" || typeof (a as { type?: unknown }).type !== "string") return null;
    return a;
  } catch {
    return null;
  }
}

export function isForbidden(name: string): boolean {
  return FORBIDDEN_NAME_PATTERNS.some((re) => re.test(name));
}
export function isPublishLike(name: string): boolean {
  return PUBLISH_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

export interface ExecContext {
  mediaPaths: string[];
  humanDelay?: [number, number];
}

const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

export async function executeAction(page: Page, action: Action, ctx: ExecContext): Promise<string> {
  const byRef = (ref: string) => page.locator(`[${REF_ATTR}="${ref}"]`).first();
  switch (action.type) {
    case "click": {
      const el = byRef(action.ref);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 10_000 });
      return `clicked ${action.ref}`;
    }
    case "type": {
      const el = byRef(action.ref);
      await el.click({ timeout: 10_000 });
      if (action.clear) {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.press("Backspace");
      }
      const [lo, hi] = ctx.humanDelay ?? [30, 100];
      await el.pressSequentially(action.text, { delay: rand(lo, hi) });
      return `typed ${action.text.length} chars into ${action.ref}`;
    }
    case "press":
      await page.keyboard.press(action.key);
      return `pressed ${action.key}`;
    case "navigate":
      await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return `navigated ${action.url}`;
    case "scroll":
      await page.mouse.wheel(0, action.direction === "down" ? 600 : -600);
      return `scrolled ${action.direction}`;
    case "upload": {
      if (ctx.mediaPaths.length === 0) return "no media to upload";
      await byRef(action.ref).setInputFiles(ctx.mediaPaths);
      return `uploaded ${ctx.mediaPaths.length} file(s)`;
    }
    case "wait":
      await page.waitForTimeout(Math.min(Math.max(action.ms, 100), 15_000));
      return `waited ${action.ms}ms`;
    case "done":
    case "fail":
      return action.type;
    default:
      return "noop";
  }
}
