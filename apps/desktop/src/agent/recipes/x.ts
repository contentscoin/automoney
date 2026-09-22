import type { Page } from "playwright";
import { RESTRICTION_HINTS, type PlatformRecipe, type SessionCheck } from "./types";

/** X (x.com) 웹 레시피 */
export const xRecipe: PlatformRecipe = {
  platform: "X",
  get loginUrl() {
    return process.env.AUTOMONEY_X_URL ?? "https://x.com/i/flow/login";
  },
  get homeUrl() {
    return process.env.AUTOMONEY_X_URL ?? "https://x.com/home";
  },

  async checkSession(page: Page, options = {}): Promise<SessionCheck> {
    if (options.navigate !== false) await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = await page.locator("body").innerText().catch(() => "");
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    const compose = page.locator('[data-automoney="compose"], a[data-testid="SideNav_NewTweet_Button"], [data-testid="tweetTextarea_0"]').first();
    if (await compose.isVisible({ timeout: 8_000 }).catch(() => false)) {
      const profileLink = page.locator('[data-automoney="handle"], a[data-testid="AppTabBar_Profile_Link"]').first();
      const handle = (await profileLink.count()) > 0 ? await profileLink.getAttribute("href").catch(() => null) : null;
      const profile = handle?.match(/^\/?@?([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/)?.[1] ?? null;
      return profile
        ? { state: "HEALTHY", handle: profile }
        : { state: "LOGIN_REQUIRED", handle: null, detail: "IDENTITY_UNVERIFIED: X composer is available but the signed-in profile handle could not be verified" };
    }
    if (await page.locator('input[autocomplete="username"], [data-automoney="login"]').first().isVisible({ timeout: 3_000 }).catch(() => false)) return { state: "LOGIN_REQUIRED" };
    return { state: "LOGIN_REQUIRED", detail: "compose not found" };
  },

  async publish(page, input, h) {
    await h.checkpoint("open", 10);
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const box = page.locator('[data-automoney="editor"], [data-testid="tweetTextarea_0"]').first();
    await box.waitFor({ state: "visible", timeout: 20_000 });
    await h.waitHuman();
    await box.click();
    await h.checkpoint("compose", 30);
    await h.humanType(page, "", input.text);
    for (const p of input.mediaPaths) {
      await page.locator('input[data-testid="fileInput"], input[type="file"]').first().setInputFiles(p);
      await h.waitHuman(800, 1600);
    }
    await h.checkpoint("ready", 70);
    const post = page.locator('[data-automoney="post"], [data-testid="tweetButtonInline"], [data-testid="tweetButton"]').first();
    await post.click({ trial: true, timeout: 20_000 });
    if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
    await post.click({ timeout: 3_000 });
    await h.checkpoint("posted", 90);
    await h.waitHuman(1500, 3000);
    const link = await page.locator('[data-automoney="post-link"], a[href*="/status/"]').first().getAttribute("href").catch(() => null);
    return { postUrl: link ? new URL(link, "https://x.com").toString() : null };
  },
};
