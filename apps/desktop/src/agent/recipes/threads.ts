import type { Page } from "playwright";
import { RESTRICTION_HINTS, type PlatformRecipe, type SessionCheck } from "./types";

/** Threads (threads.net) 웹 레시피. 셀렉터는 접근성 이름 기반으로 유지해 UI 변경에 견디게 한다. */
export const threadsRecipe: PlatformRecipe = {
  platform: "THREADS",
  get loginUrl() {
    return process.env.AUTOMONEY_THREADS_URL ?? "https://www.threads.net/login";
  },
  get homeUrl() {
    return process.env.AUTOMONEY_THREADS_URL ?? "https://www.threads.net/";
  },

  async checkSession(page: Page): Promise<SessionCheck> {
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = (await page.textContent("body").catch(() => "")) ?? "";
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    const compose = page.locator('[data-automoney="compose"], [role="button"][aria-label*="새 스레드"], [role="button"][aria-label*="New thread"], a[href="/compose"], [aria-label="Create"]').first();
    if (await compose.isVisible({ timeout: 8_000 }).catch(() => false)) {
      const handle = await page.locator('[data-automoney="handle"], a[href^="/@"]').first().getAttribute("href").catch(() => null);
      return { state: "HEALTHY", handle: handle ? handle.replace(/^\/@/, "").split("/")[0] ?? null : null };
    }
    const loginForm = page.locator('input[name="username"], input[autocomplete="username"], [data-automoney="login"]').first();
    if (await loginForm.isVisible({ timeout: 3_000 }).catch(() => false)) return { state: "LOGIN_REQUIRED" };
    return { state: "LOGIN_REQUIRED", detail: "compose button not found" };
  },

  async publish(page, input, h) {
    await h.checkpoint("open", 10);
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const compose = page.locator('[data-automoney="compose"], [role="button"][aria-label*="새 스레드"], [role="button"][aria-label*="New thread"], a[href="/compose"], [aria-label="Create"]').first();
    await compose.waitFor({ state: "visible", timeout: 20_000 });
    await h.waitHuman();
    await compose.click();
    await h.checkpoint("compose", 30);
    const editor = page.locator('[data-automoney="editor"], div[role="textbox"][contenteditable="true"], textarea').first();
    await editor.waitFor({ state: "visible", timeout: 20_000 });
    await editor.click();
    await h.humanType(page, "", input.text);
    for (const p of input.mediaPaths) {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(p);
      await h.waitHuman(800, 1600);
    }
    await h.checkpoint("ready", 70);
    if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
    const post = page.locator('[data-automoney="post"], [role="button"]:has-text("게시"), [role="button"]:has-text("Post")').last();
    await post.click();
    await h.checkpoint("posted", 90);
    await h.waitHuman(1500, 3000);
    const link = await page.locator('[data-automoney="post-link"], a[href*="/post/"]').first().getAttribute("href").catch(() => null);
    return { postUrl: link ? new URL(link, this.homeUrl).toString() : null };
  },
};
