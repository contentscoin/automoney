import type { Page } from "playwright";
import { RESTRICTION_HINTS, type PlatformRecipe, type SessionCheck } from "./types";

/** TikTok 웹 업로드 레시피. 영상 파일 필수. */
export const tiktokRecipe: PlatformRecipe = {
  platform: "TIKTOK",
  get loginUrl() {
    return process.env.AUTOMONEY_TIKTOK_URL ?? "https://www.tiktok.com/login";
  },
  get homeUrl() {
    return process.env.AUTOMONEY_TIKTOK_URL ?? "https://www.tiktok.com/tiktokstudio/upload";
  },

  async checkSession(page: Page): Promise<SessionCheck> {
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = (await page.textContent("body").catch(() => "")) ?? "";
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    const upload = page.locator('[data-automoney="compose"], input[type="file"][accept*="video"], [data-e2e="upload-btn"], button:has-text("동영상 선택"), button:has-text("Select video")').first();
    if (await upload.count().then((c) => c > 0) && (await upload.first().isVisible({ timeout: 8_000 }).catch(() => false) || (await upload.first().count()) > 0)) {
      const handle = await page.locator('[data-automoney="handle"], a[data-e2e="nav-profile"]').first().getAttribute("href").catch(() => null);
      return { state: "HEALTHY", handle: handle ? handle.replace(/^\/@?/, "") : null };
    }
    if (await page.locator('[data-automoney="login"], a[href*="/login"], input[name="username"]').first().isVisible({ timeout: 3_000 }).catch(() => false)) return { state: "LOGIN_REQUIRED" };
    return { state: "LOGIN_REQUIRED", detail: "upload input not found" };
  },

  async publish(page, input, h) {
    if (input.mediaPaths.length !== 1) throw Object.assign(new Error("TikTok requires exactly one video file"), { code: "RECIPE_UNSUPPORTED" });
    await h.checkpoint("open", 10);
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.mediaPaths[0]!);
    await h.checkpoint("uploading", 30);
    const caption = page.locator('[data-automoney="editor"], div[contenteditable="true"][data-e2e="caption-input"], div.public-DraftEditor-content, div[contenteditable="true"]').first();
    await caption.waitFor({ state: "visible", timeout: 120_000 });
    await h.waitHuman();
    await caption.click();
    await page.keyboard.press("Control+A").catch(() => {});
    await h.humanType(page, "", input.text);
    await h.checkpoint("ready", 70);
    if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
    const post = page.locator('[data-automoney="post"], button[data-e2e="post_video_button"], button:has-text("게시"), button:has-text("Post")').first();
    await post.waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-automoney="post"], button[data-e2e="post_video_button"]') as HTMLButtonElement | null;
      return b ? !b.disabled : true;
    }, undefined, { timeout: 180_000 }).catch(() => {});
    await post.click();
    await h.checkpoint("posted", 90);
    await h.waitHuman(2000, 4000);
    const link = await page.locator('[data-automoney="post-link"], a[href*="/video/"]').first().getAttribute("href").catch(() => null);
    return { postUrl: link ? new URL(link, "https://www.tiktok.com").toString() : null, detail: link ? undefined : "posted (url not captured; check TikTok Studio)" };
  },
};
