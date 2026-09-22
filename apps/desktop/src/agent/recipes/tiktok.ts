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

  async checkSession(page: Page, options = {}): Promise<SessionCheck> {
    if (options.navigate !== false) await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = await page.locator("body").innerText().catch(() => "");
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    const upload = page.locator('[data-automoney="compose"], input[type="file"][accept*="video"], [data-e2e="upload-btn"], button:has-text("동영상 선택"), button:has-text("Select video")').first();
    if (await upload.count().then((c) => c > 0) && (await upload.first().isVisible({ timeout: 8_000 }).catch(() => false) || (await upload.first().count()) > 0)) {
      const profileLink = page.locator('[data-automoney="handle"], a[data-e2e="nav-profile"]').first();
      const handle = (await profileLink.count()) > 0 ? await profileLink.getAttribute("href").catch(() => null) : null;
      const profile = handle?.match(/^\/?@([^/?#]+)\/?(?:[?#].*)?$/)?.[1] ?? null;
      return profile
        ? { state: "HEALTHY", handle: profile }
        : { state: "LOGIN_REQUIRED", handle: null, detail: "IDENTITY_UNVERIFIED: TikTok upload is available but the signed-in profile handle could not be verified" };
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
    const post = page.locator('[data-automoney="post"], button[data-e2e="post_video_button"], button:has-text("게시"), button:has-text("Post")').first();
    // 업로드/트랜스코딩으로 버튼 활성화가 오래 걸릴 수 있다. 이 대기는
    // 서버의 실게시 의도를 점유하기 전에 끝내고, 허가 후에는 즉시 클릭한다.
    await post.click({ trial: true, timeout: 180_000 });
    if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
    await post.click({ timeout: 3_000 });
    await h.checkpoint("posted", 90);
    await h.waitHuman(2000, 4000);
    const link = await page.locator('[data-automoney="post-link"], a[href*="/video/"]').first().getAttribute("href").catch(() => null);
    return { postUrl: link ? new URL(link, "https://www.tiktok.com").toString() : null, detail: link ? undefined : "posted (url not captured; check TikTok Studio)" };
  },
};
