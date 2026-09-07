import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testExecutablePath } from "./browser";
import { getRecipe, SUPPORTED_PLATFORMS, type RecipeHelpers } from "../src/agent/recipes";

const fixture = (name: string) => pathToFileURL(path.join(__dirname, "fixtures", name)).toString();
let browser: Browser;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-media-"));
const img = path.join(tmp, "a.jpg");
const vid = path.join(tmp, "a.mp4");
fs.writeFileSync(img, "fake-jpg");
fs.writeFileSync(vid, "fake-mp4");

const helpers = (allowPublish: boolean): RecipeHelpers => ({
  async humanType(page, selector, text) {
    const t = selector ? page.locator(selector).first() : page.locator(":focus").first();
    await t.pressSequentially(text, { delay: 1 });
  },
  async checkpoint() {},
  async beforePublish() {
    return allowPublish;
  },
  async waitHuman() {},
});

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: testExecutablePath() });
});
afterAll(async () => {
  await browser?.close();
});

describe("platform recipes on fixture pages", () => {
  it("registers five platforms", () => {
    expect(SUPPORTED_PLATFORMS.sort()).toEqual(["INSTAGRAM", "NAVER_BLOG", "THREADS", "TIKTOK", "X"]);
  });

  const cases: { platform: string; env: string; file: string; media: string[]; expectUrl: RegExp; handle: string }[] = [
    { platform: "INSTAGRAM", env: "AUTOMONEY_INSTAGRAM_URL", file: "fake-instagram.html", media: [img], expectUrl: /\/p\/ABC123/, handle: "e2e_insta" },
    { platform: "TIKTOK", env: "AUTOMONEY_TIKTOK_URL", file: "fake-tiktok.html", media: [vid], expectUrl: /\/video\/7000000000000000001/, handle: "e2e_tok" },
    { platform: "NAVER_BLOG", env: "AUTOMONEY_NAVER_URL", file: "fake-naver.html", media: [], expectUrl: /\/e2e_blogger\/223000000001/, handle: "e2e_blogger" },
  ];

  for (const c of cases) {
    it(`${c.platform}: verifies session, dry-run stops before publish, real run captures URL`, async () => {
      process.env[c.env] = fixture(c.file); // 레시피 URL 은 getter 로 호출 시점에 읽힌다
      const recipe = getRecipe(c.platform);
      const page = await browser.newPage();
      const check = await recipe!.checkSession(page);
      expect(check.state).toBe("HEALTHY");
      expect(check.handle).toBe(c.handle);
      const dry = await recipe!.publish(page, { text: "제목 줄\n본문 내용입니다 #automoney", mediaPaths: c.media }, helpers(false));
      expect(dry.postUrl).toBeNull();
      const real = await recipe!.publish(page, { text: "제목 줄\n본문 내용입니다 #automoney", mediaPaths: c.media }, helpers(true));
      expect(real.postUrl).toMatch(c.expectUrl);
      await page.close();
    });
  }

  it("instagram/tiktok reject missing media", async () => {
    const page = await browser.newPage();
    await expect(getRecipe("INSTAGRAM")!.publish(page, { text: "x", mediaPaths: [] }, helpers(true))).rejects.toMatchObject({ code: "RECIPE_UNSUPPORTED" });
    await expect(getRecipe("TIKTOK")!.publish(page, { text: "x", mediaPaths: [] }, helpers(true))).rejects.toMatchObject({ code: "RECIPE_UNSUPPORTED" });
    await page.close();
  });
});
