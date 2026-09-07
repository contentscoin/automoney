import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testExecutablePath } from "./browser";
import { parseCount, readPostMetrics } from "../src/agent/recipes/readback";
import { HANDLERS } from "../src/agent/loop";

const fixture = (name: string) => pathToFileURL(path.join(__dirname, "fixtures", name)).toString();
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: testExecutablePath() });
});
afterAll(async () => {
  await browser?.close();
});

describe("post.readback", () => {
  it("parses korean/english count formats", () => {
    expect(parseCount("1.2만")).toBe(12000);
    expect(parseCount("3,456")).toBe(3456);
    expect(parseCount("12K")).toBe(12000);
    expect(parseCount("1.5M")).toBe(1500000);
    expect(parseCount("좋아요 245개")).toBe(245);
    expect(parseCount("")).toBeUndefined();
  });

  it("reads metrics from fixture hooks for every platform", async () => {
    const page = await browser.newPage();
    await page.goto(fixture("fake-post.html"));
    for (const platform of ["X", "THREADS", "INSTAGRAM", "TIKTOK", "NAVER_BLOG"]) {
      const m = await readPostMetrics(page, platform);
      expect(m).toEqual({ likes: 12000, comments: 34, shares: 5, views: 45678 });
    }
    await page.close();
  });

  it("registers handlers for every job type including cloud-only refresh", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(["codex.login", "content.generate", "meta.token_refresh", "post.publish", "post.readback", "space.create", "space.login", "space.verify"]);
  });
});
