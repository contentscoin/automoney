import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isForbidden, isPublishLike, parseAction, renderSnapshot, runAutopilot, scriptedPlanner, takeSnapshot } from "../src/agent/autopilot";
import type { Planner } from "../src/agent/autopilot";

const fixture = (name: string) => pathToFileURL(path.join(__dirname, "fixtures", name)).toString();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.AUTOMONEY_BROWSER_EXECUTABLE ?? "/opt/pw-browsers/chromium" });
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

describe("snapshot & action parsing", () => {
  it("assigns refs to interactive elements and renders compactly", async () => {
    await page.goto(fixture("fake-x-broken.html"));
    const snap = await takeSnapshot(page);
    expect(snap.elements.length).toBeGreaterThan(1);
    expect(snap.elements.every((e) => /^e\d+$/.test(e.ref))).toBe(true);
    const open = snap.elements.find((e) => /Compose new post|새 글 작성/.test(e.name));
    expect(open?.role).toBe("button");
    const text = renderSnapshot(snap);
    expect(text).toContain("ELEMENTS:");
    expect(text).toContain(`[${open!.ref}]`);
  });
  it("parses JSON actions from noisy output and classifies names", () => {
    expect(parseAction('sure, here you go:\n{"type":"click","ref":"e2"}')).toEqual({ type: "click", ref: "e2" });
    expect(parseAction("nope")).toBeNull();
    expect(isForbidden("계정 삭제")).toBe(true);
    expect(isForbidden("Post")).toBe(false);
    expect(isPublishLike("Post")).toBe(true);
    expect(isPublishLike("게시")).toBe(true);
    expect(isPublishLike("다음")).toBe(false);
  });
});

describe("autopilot loop", () => {
  it("recovers a post on a page where recipe selectors fail (scripted planner) and blocks forbidden controls", async () => {
    await page.goto(fixture("fake-x-broken.html"));
    const steps: string[] = [];
    // 악의적/실수 플래너: 먼저 금지 버튼을 누르려 시도 → 차단되어야 함, 이후 scripted 로 위임
    const naughty: Planner = {
      name: "naughty",
      async next(input) {
        const danger = input.snapshot.elements.find((e) => /계정 삭제/.test(e.name));
        if (danger && !input.history.some((h) => h.outcome.includes("blocked"))) return { type: "click", ref: danger.ref };
        return scriptedPlanner.next(input);
      },
    };
    const r = await runAutopilot(page, naughty, {
      goal: "post",
      platform: "X",
      text: "autopilot hello",
      mediaPaths: [],
      beforePublish: async () => true,
      onStep: (s, a, o) => {
        steps.push(`${s}:${a.type}:${o}`);
      },
    });
    if (!r.ok || !steps.some((s) => s.includes("blocked forbidden"))) console.log("STEPS", steps, r);
    expect(r.ok).toBe(true);
    expect(r.postUrl).toContain("/status/999");
    expect(steps.some((s) => s.includes("blocked forbidden"))).toBe(true);
    expect(await page.locator("h1").first().innerText()).not.toContain("ACCOUNT DELETED");
    expect(await page.locator("#ed").innerText()).toContain("autopilot hello");
  });

  it("stops at ready when publish is not allowed (dry-run gate)", async () => {
    await page.goto(fixture("fake-x-broken.html"));
    const r = await runAutopilot(page, scriptedPlanner, { goal: "post", platform: "X", text: "dry", mediaPaths: [], beforePublish: async () => false });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/ready/);
    expect(r.postUrl).toBeNull();
    expect(await page.locator("#posted a").count()).toBe(0);
  });

  it("fails cleanly when the planner gives up or exceeds max steps", async () => {
    await page.goto(fixture("fake-x-broken.html"));
    const quitter: Planner = { name: "q", async next() { return { type: "fail", reason: "cannot" }; } };
    expect((await runAutopilot(page, quitter, { goal: "g", platform: "X", text: "t", mediaPaths: [], beforePublish: async () => true })).reason).toBe("AUTOPILOT_FAILED");
    const spinner: Planner = { name: "s", async next() { return { type: "wait", ms: 100 }; } };
    expect((await runAutopilot(page, spinner, { goal: "g", platform: "X", text: "t", mediaPaths: [], maxSteps: 3, beforePublish: async () => true })).reason).toBe("AUTOPILOT_MAX_STEPS");
  });
});
