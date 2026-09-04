import type { Page } from "playwright";
import { RESTRICTION_HINTS, type PlatformRecipe, type SessionCheck } from "./types";

/** X (x.com) 웹 레시피 */
export const xRecipe: PlatformRecipe = {
  platform: "X",
  loginUrl: process.env.AUTOMONEY_X_URL ?? "https://x.com/i/flow/login",
  homeUrl: process.env.AUTOMONEY_X_URL ?? "https://x.com/home",

  async checkSession(page: Page): Promise<SessionCheck> {
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = (await page.textContent("body").catch(() => "")) ?? "";
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    const compose = page.locator('[data-automoney="compose"], a[data-testid="SideNav_NewTweet_Button"], [data-testid="tweetTextarea_0"]').first();
    if (await compose.isVisible({ timeout: 8_000 }).catch(() => false)) {
      const handle = await page.locator('[data-automoney="handle"], a[data-testid="AppTabBar_Profile_Link"]').first().getAttribute("href").catch(() => null);
      return { state: "HEALTHY", handle: handle ? handle.replace(/^\//, "") : null };
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
    if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
    const post = page.locator('[data-automoney="post"], [data-testid="tweetButtonInline"], [data-testid="tweetButton"]').first();
    await post.click();
    await h.checkpoint("posted", 90);
    await h.waitHuman(1500, 3000);
    const link = await page.locator('[data-automoney="post-link"], a[href*="/status/"]').first().getAttribute("href").catch(() => null);
    return { postUrl: link ? new URL(link, "https://x.com").toString() : null };
  },
};
