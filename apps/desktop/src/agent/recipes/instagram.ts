import type { Page } from "playwright";
import { RESTRICTION_HINTS, type PlatformRecipe, type SessionCheck } from "./types";

/** Only selectors that explicitly identify the signed-in user's own profile. */
const selfProfileSelectors = [
  '[data-automoney="handle"]',
  'nav a[href^="/"][rel~="me"]',
  'nav a[href^="/"][aria-label="Profile" i]',
  'nav a[href^="/"][aria-label="프로필"]',
];

const RESERVED_PROFILE_PATHS = new Set(["accounts", "direct", "explore", "p", "reel", "reels", "stories"]);

function profileHandle(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://www.instagram.com");
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/([^/?#]+)\/?$/);
    const handle = match?.[1]?.toLowerCase() ?? null;
    return handle && !RESERVED_PROFILE_PATHS.has(handle) ? handle : null;
  } catch {
    return null;
  }
}

async function signedInProfileHandle(page: Page): Promise<string | null> {
  // Locator unions use DOM order, not selector order. Evaluate only exact
  // self-profile markers one at a time so an earlier suggested account cannot
  // shadow rel=me or the app-owned test hook.
  for (const selector of selfProfileSelectors) {
    const links = page.locator(selector);
    const count = await links.count();
    for (let index = 0; index < count; index++) {
      const handle = profileHandle(await links.nth(index).getAttribute("href").catch(() => null));
      if (handle) return handle;
    }
  }
  return null;
}

/** Instagram 웹 피드 게시 레시피. 이미지/영상 필수. */
export const instagramRecipe: PlatformRecipe = {
  platform: "INSTAGRAM",
  get loginUrl() {
    return process.env.AUTOMONEY_INSTAGRAM_URL ?? "https://www.instagram.com/accounts/login/";
  },
  get homeUrl() {
    return process.env.AUTOMONEY_INSTAGRAM_URL ?? "https://www.instagram.com/";
  },

  async checkSession(page: Page, options = {}): Promise<SessionCheck> {
    if (options.navigate !== false) await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = await page.locator("body").innerText().catch(() => "");
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    const create = page.locator('[data-automoney="compose"], a[href="#"]:has(svg[aria-label="새로운 게시물"]), svg[aria-label="New post"], svg[aria-label="만들기"], svg[aria-label="Create"]').first();
    if (await create.isVisible({ timeout: 8_000 }).catch(() => false)) {
      const handle = await signedInProfileHandle(page);
      return handle
        ? { state: "HEALTHY", handle }
        : { state: "LOGIN_REQUIRED", handle: null, detail: "IDENTITY_UNVERIFIED: Instagram composer is available but the signed-in profile handle could not be verified" };
    }
    if (await page.locator('input[name="username"], [data-automoney="login"]').first().isVisible({ timeout: 3_000 }).catch(() => false)) return { state: "LOGIN_REQUIRED" };
    return { state: "LOGIN_REQUIRED", detail: "create button not found" };
  },

  async publish(page, input, h) {
    if (input.mediaPaths.length === 0) throw Object.assign(new Error("Instagram requires at least one media file"), { code: "RECIPE_UNSUPPORTED" });
    await h.checkpoint("open", 10);
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const create = page.locator('[data-automoney="compose"], svg[aria-label="새로운 게시물"], svg[aria-label="New post"], svg[aria-label="만들기"], svg[aria-label="Create"]').first();
    await create.waitFor({ state: "visible", timeout: 20_000 });
    await h.waitHuman();
    await create.click();
    await h.checkpoint("select_media", 25);
    const postItem = page.locator('[data-automoney="compose-post"], [role="menuitem"]:has-text("게시물"), [role="menuitem"]:has-text("Post")').first();
    if (await postItem.isVisible({ timeout: 3_000 }).catch(() => false)) await postItem.click();
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(input.mediaPaths);
    await h.waitHuman(1000, 2000);
    // 자르기 → 필터 → 캡션: "다음" 두 번
    for (let i = 0; i < 2; i++) {
      const next = page.locator('[data-automoney="next"], [role="button"]:has-text("다음"), [role="button"]:has-text("Next")').first();
      if (await next.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await next.click();
        await h.waitHuman(600, 1200);
      }
    }
    await h.checkpoint("caption", 55);
    const caption = page.locator('[data-automoney="editor"], div[role="textbox"][aria-label*="문구"], div[role="textbox"][aria-label*="caption"], textarea[aria-label*="caption"]').first();
    await caption.waitFor({ state: "visible", timeout: 20_000 });
    await caption.click();
    await h.humanType(page, "", input.text);
    await h.checkpoint("ready", 70);
    const share = page.locator('[data-automoney="post"], [role="button"]:has-text("공유하기"), [role="button"]:has-text("Share")').last();
    await share.click({ trial: true, timeout: 20_000 });
    if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
    await share.click({ timeout: 3_000 });
    await h.checkpoint("posted", 90);
    await page.locator('[data-automoney="post-link"], :text("게시물이 공유되었습니다"), :text("Your post has been shared")').first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
    const link = await page.locator('[data-automoney="post-link"], a[href*="/p/"]').first().getAttribute("href").catch(() => null);
    return { postUrl: link ? new URL(link, "https://www.instagram.com").toString() : null, detail: link ? undefined : "shared (url not captured)" };
  },
};
