import type { Page } from "playwright";
import { RESTRICTION_HINTS, type PlatformRecipe, type SessionCheck } from "./types";

/**
 * 네이버 블로그 스마트에디터 ONE 레시피. 첫 줄 = 제목, 나머지 = 본문.
 * 에디터는 iframe 없이 동작하지만 셀렉터가 자주 바뀌므로 data-automoney 훅과 role 기반 후보를 함께 둔다.
 */
export const naverBlogRecipe: PlatformRecipe = {
  platform: "NAVER_BLOG",
  get loginUrl() {
    return process.env.AUTOMONEY_NAVER_URL ?? "https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fblog.naver.com%2F";
  },
  get homeUrl() {
    return process.env.AUTOMONEY_NAVER_URL ?? "https://blog.naver.com/GoBlogWrite.naver";
  },

  async checkSession(page: Page): Promise<SessionCheck> {
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = (await page.textContent("body").catch(() => "")) ?? "";
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    if (/nidlogin|로그인/.test(page.url()) && (await page.locator('#id, input[name="id"], [data-automoney="login"]').first().isVisible({ timeout: 3_000 }).catch(() => false))) return { state: "LOGIN_REQUIRED" };
    const editor = page.locator('[data-automoney="editor"], .se-component-content, .se-text-paragraph, [contenteditable="true"]').first();
    if (await editor.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const handle = await page.locator('[data-automoney="handle"]').first().getAttribute("href").catch(() => null);
      const m = /blog\.naver\.com\/([A-Za-z0-9_-]+)/.exec(page.url());
      return { state: "HEALTHY", handle: handle ? handle.replace(/^\//, "") : (m?.[1] ?? null) };
    }
    return { state: "LOGIN_REQUIRED", detail: "editor not found" };
  },

  async publish(page, input, h) {
    await h.checkpoint("open", 10);
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // 이전 작성 글 복구 팝업 닫기
    const cancel = page.locator('[data-automoney="dismiss"], button:has-text("취소"), .se-popup-button-cancel').first();
    if (await cancel.isVisible({ timeout: 3_000 }).catch(() => false)) await cancel.click().catch(() => {});
    const [titleLine, ...rest] = input.text.split("\n");
    const title = (titleLine ?? "").trim().slice(0, 100);
    const body = rest.join("\n").trim() || title;
    await h.checkpoint("title", 25);
    const titleBox = page.locator('[data-automoney="title"], .se-title-text [contenteditable="true"], .se-documentTitle [contenteditable="true"], [placeholder="제목"]').first();
    await titleBox.waitFor({ state: "visible", timeout: 20_000 });
    await titleBox.click();
    await h.humanType(page, "", title);
    await h.checkpoint("body", 40);
    const bodyBox = page.locator('[data-automoney="editor"], .se-component.se-text [contenteditable="true"], .se-text-paragraph').first();
    await bodyBox.waitFor({ state: "visible", timeout: 20_000 });
    await bodyBox.click();
    await h.humanType(page, "", body);
    for (const p of input.mediaPaths) {
      const fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count()) > 0) {
        await fileInput.setInputFiles(p);
        await h.waitHuman(1200, 2500);
      }
    }
    await h.checkpoint("ready", 70);
    if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
    const publishBtn = page.locator('[data-automoney="post"], button.publish_btn__m9KHH, button:has-text("발행")').first();
    await publishBtn.click();
    await h.waitHuman(600, 1200);
    const confirm = page.locator('[data-automoney="post-confirm"], .layer_publish button:has-text("발행"), button[data-testid="seOnePublishBtn"]').first();
    if (await confirm.isVisible({ timeout: 5_000 }).catch(() => false)) await confirm.click();
    await h.checkpoint("posted", 90);
    // 게시 완료 신호: post-link 등장 또는 URL 변경 중 먼저 오는 것
    await Promise.race([
      page.locator('[data-automoney="post-link"]').first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
      page.waitForURL(/blog\.naver\.com\/[^/]+\/\d+|PostView|logNo=|\/posted/, { timeout: 60_000 }).catch(() => {}),
    ]);
    const link = await page.locator('[data-automoney="post-link"]').first().getAttribute("href").catch(() => null);
    const url = link ? new URL(link, "https://blog.naver.com").toString() : /logNo=\d+|\/\d{9,}/.test(page.url()) ? page.url() : null;
    return { postUrl: url, detail: url ? undefined : "published (url not captured)" };
  },
};
