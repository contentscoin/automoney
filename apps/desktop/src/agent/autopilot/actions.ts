import type { Page, Route } from "playwright";
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

const ACTION_REF = /^e[1-9]\d{0,3}$/;
const SAFE_PRESS_KEYS = new Set(["Escape", "Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
const PLATFORM_HOSTS: Record<string, string[]> = {
  X: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
  THREADS: ["threads.net", "www.threads.net"],
  INSTAGRAM: ["instagram.com", "www.instagram.com"],
  TIKTOK: ["tiktok.com", "www.tiktok.com"],
  NAVER_BLOG: ["blog.naver.com", "m.blog.naver.com", "nid.naver.com"],
};

/** 클릭 금지: 계정·결제·삭제 등 되돌릴 수 없는 동작 */
export const FORBIDDEN_NAME_PATTERNS = [/삭제|delete|remove account|계정 삭제/i, /탈퇴|deactivate|비활성화/i, /결제|payment|구독|subscribe|billing/i, /비밀번호|password|보안|security settings/i, /차단|block|신고|report/i, /로그아웃|log ?out|sign ?out/i];
/** 발행 계열: 게이트 통과 전 클릭 금지 */
export const PUBLISH_NAME_PATTERNS = [/^(게시|게시하기|공유|공유하기|발행|올리기|post|share|publish|tweet|send)$/i, /게시물 공유|share post|publish now/i];
/** 초안 변경 전에만 허용하는 명시적 작성창 열기 계열. 그 밖의 click은 submit 위험으로 차단한다. */
export const PREPARATION_NAME_PATTERNS = [/^(새 글 작성|글쓰기|작성|만들기|compose|compose new post|create|create post|new post|new thread)$/i];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const validReason = (value: unknown) => value === undefined || (typeof value === "string" && value.length <= 300);

/** Runtime validation is mandatory because planner output is untrusted model/page data. */
export function validateAction(value: unknown): Action | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "click":
      return onlyKeys(value, ["type", "ref", "reason"]) && typeof value.ref === "string" && ACTION_REF.test(value.ref) && validReason(value.reason)
        ? value as Action : null;
    case "type":
      return onlyKeys(value, ["type", "ref", "text", "clear", "reason"])
        && typeof value.ref === "string" && ACTION_REF.test(value.ref)
        && typeof value.text === "string" && value.text.length <= 50_000
        && (value.clear === undefined || typeof value.clear === "boolean") && validReason(value.reason)
        ? value as Action : null;
    case "upload":
      return onlyKeys(value, ["type", "ref", "reason"]) && typeof value.ref === "string" && ACTION_REF.test(value.ref) && validReason(value.reason)
        ? value as Action : null;
    case "press":
      return onlyKeys(value, ["type", "key", "reason"]) && typeof value.key === "string" && isAllowedPressKey(value.key) && validReason(value.reason)
        ? value as Action : null;
    case "navigate":
      return onlyKeys(value, ["type", "url", "reason"]) && typeof value.url === "string" && value.url.length > 0 && value.url.length <= 2_048 && !/[\u0000-\u001f]/.test(value.url) && validReason(value.reason)
        ? value as Action : null;
    case "scroll":
      return onlyKeys(value, ["type", "direction", "reason"]) && (value.direction === "up" || value.direction === "down") && validReason(value.reason)
        ? value as Action : null;
    case "wait":
      return onlyKeys(value, ["type", "ms", "reason"]) && typeof value.ms === "number" && Number.isInteger(value.ms) && value.ms >= 100 && value.ms <= 15_000 && validReason(value.reason)
        ? value as Action : null;
    case "done":
      return onlyKeys(value, ["type", "summary", "postUrl"]) && typeof value.summary === "string" && value.summary.length > 0 && value.summary.length <= 300
        && (value.postUrl === undefined || value.postUrl === null || (typeof value.postUrl === "string" && value.postUrl.length <= 2_048))
        ? value as Action : null;
    case "fail":
      return onlyKeys(value, ["type", "reason"]) && typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 500
        ? value as Action : null;
    default:
      return null;
  }
}

export function parseAction(raw: string): Action | null {
  if (raw.length > 64 * 1024) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return validateAction(JSON.parse(m[0]));
  } catch {
    return null;
  }
}

export function isAllowedPressKey(key: string): boolean {
  return SAFE_PRESS_KEYS.has(key);
}

/** Resolve a relative URL, then constrain it to the selected social platform. */
export function resolveAllowedNavigationUrl(raw: string, platform: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:") return null;
    const hosts = PLATFORM_HOSTS[platform.toUpperCase()] ?? [];
    const host = url.hostname.toLowerCase();
    return hosts.includes(host) ? url.toString() : null;
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
export function isPreparationLike(name: string): boolean {
  return PREPARATION_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

export interface ExecContext {
  mediaPaths: string[];
  canNavigate?: (url: string) => boolean;
  /** 이미 trial click으로 actionability를 확인한 최종 게시 클릭. */
  preparedClick?: boolean;
  clickTimeout?: number;
}

/**
 * 최종 게시 허가 전에 대상이 실제로 보이고 활성화되어 클릭 가능한지 확인한다.
 * trial click은 입력 이벤트를 dispatch하지 않으므로 외부 게시를 만들지 않는다.
 */
export async function prepareClickAction(page: Page, ref: string, timeout = 10_000): Promise<void> {
  const el = page.locator(`[${REF_ATTR}="${ref}"]`).first();
  await el.scrollIntoViewIfNeeded({ timeout });
  await el.click({ trial: true, timeout });
}

export async function executeAction(page: Page, action: Action, ctx: ExecContext): Promise<string> {
  const byRef = (ref: string) => page.locator(`[${REF_ATTR}="${ref}"]`).first();
  switch (action.type) {
    case "click": {
      const el = byRef(action.ref);
      if (!ctx.preparedClick) await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: ctx.clickTimeout ?? 10_000 });
      return `clicked ${action.ref}`;
    }
    case "type": {
      const el = byRef(action.ref);
      // Focusing cannot activate submit/image inputs; the loop additionally
      // restricts typing to semantic text-entry controls from the snapshot.
      await el.focus({ timeout: 10_000 });
      // `pressSequentially` emits Enter key events for multiline copy and can
      // submit a surrounding form without passing the publish gate. `fill`
      // emits input/change semantics but no keyboard submit shortcut.
      await el.fill(action.text, { timeout: 10_000 });
      return `typed ${action.text.length} chars into ${action.ref}`;
    }
    case "press":
      if (!isAllowedPressKey(action.key)) throw new Error(`blocked unsafe key: ${action.key}`);
      await page.keyboard.press(action.key);
      return `pressed ${action.key}`;
    case "navigate":
      if (!ctx.canNavigate?.(action.url)) throw new Error(`blocked navigation: ${action.url}`);
      let blockedRedirect: string | null = null;
      const guardNavigation = async (route: Route) => {
        const request = route.request();
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
          await route.fallback();
          return;
        }
        let nextUrl = request.url();
        for (let redirects = 0; redirects <= 5; redirects++) {
          if (!ctx.canNavigate?.(nextUrl)) {
            blockedRedirect = nextUrl;
            await route.abort("blockedbyclient");
            return;
          }
          const response = await route.fetch({ url: nextUrl, maxRedirects: 0, timeout: 45_000 });
          const location = response.headers()["location"];
          if (response.status() < 300 || response.status() >= 400 || !location) {
            await route.fulfill({ response });
            await response.dispose();
            return;
          }
          if (redirects === 5) {
            await response.dispose();
            blockedRedirect = nextUrl;
            await route.abort("blockedbyclient");
            return;
          }
          try {
            nextUrl = new URL(location, nextUrl).toString();
          } catch {
            await response.dispose();
            blockedRedirect = location;
            await route.abort("blockedbyclient");
            return;
          }
          await response.dispose();
        }
      };
      await page.route("**/*", guardNavigation);
      try {
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch (error) {
        if (blockedRedirect) throw new Error(`blocked navigation redirect: ${blockedRedirect}`);
        throw error;
      } finally {
        await page.unroute("**/*", guardNavigation).catch(() => {});
      }
      if (!ctx.canNavigate(page.url())) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
        throw new Error(`blocked navigation redirect: ${page.url()}`);
      }
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
