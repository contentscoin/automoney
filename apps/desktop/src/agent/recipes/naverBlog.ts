import type { Page } from "playwright";
import { RESTRICTION_HINTS, type PlatformRecipe, type SessionCheck } from "./types";

/** 작성 화면의 임의 링크가 아니라 로그인 사용자의 '내 블로그' 링크만 허용한다. */
const selfBlogSelector = [
  '[data-automoney="handle"]',
  'nav a[href*="blog.naver.com"][rel~="me"]',
  'nav a[href^="/"][rel~="me"]',
  'a[href*="blog.naver.com"][aria-label="내 블로그"]',
  'a[href*="blog.naver.com"][title="내 블로그"]',
  'a[href*="blog.naver.com"][data-testid*="myblog" i]',
].join(", ");

function blogIdFromUrl(raw: string | null, base: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    if (!/(^|\.)blog\.naver\.com$/i.test(url.hostname)) return null;
    const queryId = url.searchParams.get("blogId");
    if (queryId && /^[A-Za-z0-9_-]+$/.test(queryId)) return queryId;
    const match = url.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function blogIdFromWriterUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/(^|\.)blog\.naver\.com$/i.test(url.hostname)) return null;
    if (!/^\/(?:GoBlogWrite|PostWriteForm)\.naver$/i.test(url.pathname)) return null;
    const queryId = url.searchParams.get("blogId");
    return queryId && /^[A-Za-z0-9_-]+$/.test(queryId) ? queryId : null;
  } catch {
    return null;
  }
}

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

  async checkSession(page: Page, options = {}): Promise<SessionCheck> {
    if (options.navigate !== false) await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = await page.locator("body").innerText().catch(() => "");
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    if (/nidlogin|로그인/.test(page.url()) && (await page.locator('#id, input[name="id"], [data-automoney="login"]').first().isVisible({ timeout: 3_000 }).catch(() => false))) return { state: "LOGIN_REQUIRED" };
    const editor = page.locator('[data-automoney="editor"], .se-component-content [contenteditable="true"], .se-text-paragraph[contenteditable="true"], [role="textbox"][contenteditable="true"]').first();
    if (await editor.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const profileLink = page.locator(selfBlogSelector).first();
      const href = (await profileLink.count()) > 0 ? await profileLink.getAttribute("href").catch(() => null) : null;
      const handle = blogIdFromUrl(href, "https://blog.naver.com") ?? blogIdFromWriterUrl(page.url());
      return handle
        ? { state: "HEALTHY", handle }
        : { state: "LOGIN_REQUIRED", handle: null, detail: "IDENTITY_UNVERIFIED: Naver Blog editor is available but the signed-in blog ID could not be verified" };
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
    const publishBtn = page.locator('[data-automoney="post"], button.publish_btn__m9KHH, button:has-text("발행")').first();
    const confirm = page.locator('[data-automoney="post-confirm"], .layer_publish button:has-text("발행"), button[data-testid="seOnePublishBtn"]').first();
    // UI 변경으로 첫 버튼이 단일 단계 실게시 버튼이 되어도 표시 없는
    // 게시가 생기지 않도록, 첫 실제 클릭부터 irreversible attempt로 본다.
    if ((await confirm.count()) === 0) throw new Error("Naver final publish confirmation control was not found");
    const publishNode = await publishBtn.elementHandle();
    const confirmNode = await confirm.elementHandle();
    if (!publishNode || !confirmNode) throw new Error("Naver publish controls were detached");
    try {
      // Keep exact element handles across the gate. Broad selectors must never
      // resolve the same single-step submit button twice after the first click.
      const sameControl = await publishNode.evaluate((node, other) => node === other, confirmNode);
      await publishNode.click({ trial: true, timeout: 20_000 });
      if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
      await publishNode.click({ timeout: 3_000 });
      if (!sameControl) {
        await confirmNode.click({ trial: true, timeout: 10_000 });
        await h.revalidatePublishContinuation();
        await confirmNode.click({ timeout: 3_000 });
      }
    } finally {
      await publishNode.dispose();
      await confirmNode.dispose();
    }
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
