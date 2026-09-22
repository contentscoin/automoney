import type { Page } from "playwright";
import { RESTRICTION_HINTS, type PlatformRecipe, type SessionCheck } from "./types";

const composeSelector = [
  '[data-automoney="compose"]',
  '[role="button"][aria-label*="새 게시물"]',
  '[role="button"][aria-label*="new post" i]',
  '[role="button"]:has-text("새로운 스레드")',
  '[role="button"]:has(svg[aria-label="만들기"])',
  '[role="button"]:has(svg[aria-label="Create"])',
  '[role="button"][aria-label*="새 스레드"]',
  '[role="button"][aria-label*="New thread"]',
  'a[href="/compose"]',
  '[aria-label="Create"]',
].join(", ");

async function dismissOptionalFediverseNotice(page: Page) {
  const notice = page
    .getByRole("dialog")
    .filter({ hasText: /페디버스로 계속 공유하시겠어요|continue sharing to the fediverse/i })
    .last();
  if (!(await notice.isVisible({ timeout: 1_500 }).catch(() => false))) return;
  await notice.getByRole("button", { name: /^(취소|Cancel)$/i }).last().click();
}

/** Threads (threads.net) 웹 레시피. 셀렉터는 접근성 이름 기반으로 유지해 UI 변경에 견디게 한다. */
export const threadsRecipe: PlatformRecipe = {
  platform: "THREADS",
  get loginUrl() {
    return process.env.AUTOMONEY_THREADS_URL ?? "https://www.threads.net/login";
  },
  get homeUrl() {
    return process.env.AUTOMONEY_THREADS_URL ?? "https://www.threads.net/";
  },

  async checkSession(page: Page, options = {}): Promise<SessionCheck> {
    if (options.navigate !== false) await page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = await page.locator("body").innerText().catch(() => "");
    if (RESTRICTION_HINTS.some((re) => re.test(body))) return { state: "RESTRICTED", detail: "restriction hint on page" };
    const hasSession = (await page.context().cookies()).some(
      (cookie) => cookie.name === "sessionid" && /(^|\.)threads\.(com|net)$/.test(cookie.domain) && cookie.value.length > 0,
    );
    if (hasSession) return { state: "HEALTHY", detail: "threads session cookie present" };
    const compose = page.locator(composeSelector).first();
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
    const compose = page.locator(composeSelector).first();
    await compose.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
      throw new Error("Threads 작성 버튼을 찾지 못했습니다. Threads 홈 화면 UI가 변경되었는지 확인해 주세요.");
    });
    await h.waitHuman();
    await compose.click();
    await h.checkpoint("compose", 30);
    const editor = page.locator('[data-automoney="editor"], div[role="textbox"][contenteditable="true"], textarea').first();
    await editor.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
      throw new Error("Threads 작성창은 열렸지만 본문 입력란을 찾지 못했습니다.");
    });
    // 페디버스 공유 여부는 사용자의 계정 설정이므로 변경하지 않고 안내만 닫는다.
    await dismissOptionalFediverseNotice(page);
    await editor.click();
    await h.humanType(page, "", input.text);
    for (const p of input.mediaPaths) {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(p);
      await h.waitHuman(800, 1600);
    }
    await h.checkpoint("ready", 70);
    if (!(await h.beforePublish())) return { postUrl: null, detail: "dry-run: not published" };
    const post = page
      .locator('[data-automoney="post"], [role="button"]')
      .filter({ hasText: /^(게시|Post)$/ })
      .last();
    await post.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
      throw new Error("Threads 게시 버튼을 찾지 못했습니다.");
    });
    await post.click();
    await h.checkpoint("posted", 90);
    await h.waitHuman(1500, 3000);
    const link = await page.locator('[data-automoney="post-link"], a[href*="/post/"]').first().getAttribute("href").catch(() => null);
    return { postUrl: link ? new URL(link, this.homeUrl).toString() : null };
  },
};
