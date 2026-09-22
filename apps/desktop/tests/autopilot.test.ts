import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testExecutablePath } from "./browser";
import { capturePublishReceiptBaseline, executeAction, isForbidden, isPublishLike, parseAction, renderSnapshot, resolveAllowedNavigationUrl, runAutopilot, scriptedPlanner, takeSnapshot, verifyPublishReceipt } from "../src/agent/autopilot";
import type { Action, Planner } from "../src/agent/autopilot";

const fixture = (name: string) => pathToFileURL(path.join(__dirname, "fixtures", name)).toString();
let browser: Browser;
let page: Page;

const listen = async (server: Server) => await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const close = async (server: Server) => await new Promise<void>((resolve) => server.close(() => resolve()));

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: testExecutablePath() });
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
    expect(parseAction('{"type":"press","key":"Control+Enter"}')).toBeNull();
    expect(parseAction('{"type":"press","key":"Meta+Enter"}')).toBeNull();
    expect(parseAction('{"type":"press","key":"Alt+Enter"}')).toBeNull();
    expect(parseAction('{"type":"press","key":"Enter"}')).toBeNull();
    expect(parseAction('{"type":"press","key":"Space"}')).toBeNull();
    expect(parseAction('{"type":"click","ref":"e2","unexpected":true}')).toBeNull();
    expect(parseAction('{"type":"wait","ms":999999}')).toBeNull();
    expect(isForbidden("계정 삭제")).toBe(true);
    expect(isForbidden("Post")).toBe(false);
    expect(isPublishLike("Post")).toBe(true);
    expect(isPublishLike("게시")).toBe(true);
    expect(isPublishLike("다음")).toBe(false);
    expect(resolveAllowedNavigationUrl("/compose", "X", "https://x.com/home")).toBe("https://x.com/compose");
    expect(resolveAllowedNavigationUrl("https://www.x.com/compose", "X", "https://x.com/home")).toBe("https://www.x.com/compose");
    expect(resolveAllowedNavigationUrl("https://help.x.com/topic", "X", "https://x.com/home")).toBeNull();
    expect(resolveAllowedNavigationUrl("https://x.com.evil.example/steal", "X", "https://x.com/home")).toBeNull();
    expect(resolveAllowedNavigationUrl("javascript:alert(1)", "X", "https://x.com/home")).toBeNull();
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
      expectedHandle: "@e2e_handle",
      beforePublish: async () => true,
      onStep: (s, a, o) => {
        steps.push(`${s}:${a.type}:${o}`);
      },
    });
    if (!r.ok || !steps.some((s) => s.includes("blocked forbidden"))) console.log("STEPS", steps, r);
    expect(r.ok).toBe(true);
    expect(r.publishAttempted).toBe(true);
    expect(r.postUrl).toContain("/status/999");
    expect(steps.some((s) => s.includes("blocked forbidden"))).toBe(true);
    expect(await page.locator("h1").first().innerText()).not.toContain("ACCOUNT DELETED");
    expect(await page.locator("#ed").innerText()).toContain("autopilot hello");
  });

  it("stops at ready when publish is not allowed (dry-run gate)", async () => {
    await page.goto(fixture("fake-x-broken.html"));
    const r = await runAutopilot(page, scriptedPlanner, { goal: "post", platform: "X", text: "dry", mediaPaths: [], dryRun: true, expectedHandle: "e2e_handle", beforePublish: async () => false });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/ready/);
    expect(r.postUrl).toBeNull();
    expect(r.publishAttempted).toBe(false);
    expect(await page.locator("#posted a").count()).toBe(0);
  });

  it("fails cleanly when the planner gives up or exceeds max steps", async () => {
    await page.goto(fixture("fake-x-broken.html"));
    const quitter: Planner = { name: "q", async next() { return { type: "fail", reason: "cannot" }; } };
    expect((await runAutopilot(page, quitter, { goal: "g", platform: "X", text: "t", mediaPaths: [], beforePublish: async () => true })).reason).toBe("AUTOPILOT_FAILED");
    const spinner: Planner = { name: "s", async next() { return { type: "wait", ms: 100 }; } };
    expect((await runAutopilot(page, spinner, { goal: "g", platform: "X", text: "t", mediaPaths: [], maxSteps: 3, beforePublish: async () => true })).reason).toBe("AUTOPILOT_MAX_STEPS");
  });

  it("rejects keyboard-submit shortcuts before they can bypass a dry-run gate", async () => {
    await page.setContent('<div role="textbox" contenteditable="true" id="ed"></div><div id="posted"></div><script>document.addEventListener("keydown",(e)=>{if((e.ctrlKey||e.metaKey||e.altKey)&&e.key==="Enter")document.querySelector("#posted").textContent="POSTED"})</script>');
    let calls = 0;
    let gateCalls = 0;
    const shortcut: Planner = {
      name: "shortcut",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((el) => el.editable)!.ref, text: "dry" };
        return { type: "press", key: "Control+Enter" } as unknown as Action;
      },
    };
    const result = await runAutopilot(page, shortcut, { goal: "post", platform: "X", text: "dry", mediaPaths: [], beforePublish: async () => { gateCalls++; return false; } });
    expect(result.reason).toBe("AUTOPILOT_INVALID_ACTION");
    expect(gateCalls).toBe(0);
    expect(await page.locator("#posted").textContent()).toBe("");
  });

  it("never treats a submit input as an editable field or activates it through type", async () => {
    await page.setContent('<form><input id="submit" type="submit" value="dry" onclick="document.querySelector(\'#posted\').textContent=\'POSTED\'"></form><div id="posted"></div>');
    const snapshot = await takeSnapshot(page);
    const submit = snapshot.elements.find((element) => element.submitControl)!;
    expect(submit).toMatchObject({ submitControl: true });
    expect(submit.editable).not.toBe(true);
    let gateCalls = 0;
    const typeSubmit: Planner = {
      name: "type-submit",
      async next() { return { type: "type", ref: submit.ref, text: "dry" }; },
    };

    const result = await runAutopilot(page, typeSubmit, {
      goal: "post",
      platform: "X",
      text: "dry",
      mediaPaths: [],
      dryRun: true,
      maxSteps: 1,
      beforePublish: async () => { gateCalls++; return false; },
    });

    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_MAX_STEPS", publishAttempted: false });
    expect(gateCalls).toBe(0);
    expect(await page.locator("#posted").textContent()).toBe("");
  });

  it.each([
    ["dry", true],
    ["live", false],
  ])("does not keyboard-submit a text form while handling multiline copy (%s)", async (_label, dryRun) => {
    await page.setContent('<form onsubmit="event.preventDefault();document.querySelector(\'#posted\').textContent=String(Number(document.querySelector(\'#posted\').textContent)+1)"><input type="text" aria-label="caption"></form><div id="posted">0</div>');
    let gateCalls = 0;
    const multiline = "hello\nworld";
    const typeInput: Planner = {
      name: "type-form-input",
      async next(input) { return { type: "type", ref: input.snapshot.elements.find((element) => element.editable)!.ref, text: multiline }; },
    };

    const result = await runAutopilot(page, typeInput, {
      goal: "post",
      platform: "X",
      text: multiline,
      mediaPaths: [],
      dryRun,
      maxSteps: 1,
      beforePublish: async () => { gateCalls++; return true; },
    });

    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_MAX_STEPS", publishAttempted: false });
    expect(gateCalls).toBe(0);
    expect(await page.locator("#posted").textContent()).toBe("0");
  });

  it("fills multiline contenteditable copy without dispatching Enter key handlers", async () => {
    await page.setContent('<div role="textbox" contenteditable="true" onkeydown="if(event.key===\'Enter\')document.querySelector(\'#posted\').textContent=\'POSTED\'"></div><div id="posted"></div>');
    let calls = 0;
    const copy = "hello\nworld";
    const typeEditor: Planner = {
      name: "type-contenteditable",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((element) => element.editable)!.ref, text: copy };
        return { type: "fail", reason: "done" };
      },
    };

    const result = await runAutopilot(page, typeEditor, {
      goal: "post",
      platform: "X",
      text: copy,
      mediaPaths: [],
      maxSteps: 2,
      beforePublish: async () => true,
    });

    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_FAILED", publishAttempted: false });
    expect(await page.locator("#posted").textContent()).toBe("");
    expect(await page.locator('[contenteditable="true"]').innerText()).toContain("hello");
  });

  it("gates an unrecognized click after editing so dry-run cannot submit through it", async () => {
    await page.setContent('<div role="textbox" contenteditable="true" id="ed"></div><button id="continue" onclick="document.querySelector(\'#posted\').textContent=\'POSTED\'">Continue</button><div id="posted"></div>');
    let calls = 0;
    let gateCalls = 0;
    const ambiguousSubmit: Planner = {
      name: "ambiguous-submit",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((el) => el.editable)!.ref, text: "dry" };
        return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Continue")!.ref };
      },
    };
    const result = await runAutopilot(page, ambiguousSubmit, { goal: "post", platform: "X", text: "dry", mediaPaths: [], dryRun: true, expectedHandle: "owner", beforePublish: async () => { gateCalls++; return false; } });
    expect(result).toMatchObject({ ok: true, summary: "ready (not published)", postUrl: null });
    expect(gateCalls).toBe(0);
    expect(await page.locator("#posted").textContent()).toBe("");
  });

  it("blocks the first unknown click in dry-run before it can submit", async () => {
    await page.setContent('<button type="button" id="continue" onclick="document.querySelector(\'#posted\').textContent=\'POSTED\'">Continue</button><div id="posted"></div>');
    let gateCalls = 0;
    const firstClick: Planner = {
      name: "first-unknown-click",
      async next(input) {
        return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Continue")!.ref };
      },
    };
    const result = await runAutopilot(page, firstClick, { goal: "post", platform: "X", text: "dry", mediaPaths: [], dryRun: true, expectedHandle: "owner", beforePublish: async () => { gateCalls++; return false; } });
    expect(result).toMatchObject({ ok: true, summary: "ready (not published)", publishAttempted: false });
    expect(gateCalls).toBe(0);
    expect(await page.locator("#posted").textContent()).toBe("");
  });

  it("blocks the first unknown click in live mode instead of treating it as harmless navigation", async () => {
    await page.setContent('<button type="button" id="continue" onclick="document.querySelector(\'#posted\').textContent=\'POSTED\'">Continue</button><div id="posted"></div>');
    let gateCalls = 0;
    const firstClick: Planner = {
      name: "first-unknown-live-click",
      async next(input) {
        return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Continue")!.ref };
      },
    };
    const result = await runAutopilot(page, firstClick, { goal: "post", platform: "X", text: "live", mediaPaths: [], maxSteps: 2, expectedHandle: "owner", beforePublish: async () => { gateCalls++; return true; } });
    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_MAX_STEPS", publishAttempted: false });
    expect(gateCalls).toBe(0);
    expect(await page.locator("#posted").textContent()).toBe("");
  });

  it("blocks an unrecognized click after a live draft mutation instead of losing uncertainty", async () => {
    await page.setContent('<div role="textbox" contenteditable="true"></div><button type="button" id="continue" onclick="document.querySelector(\'#posted\').textContent=\'POSTED\'">Continue</button><div id="posted"></div>');
    let calls = 0;
    let gateCalls = 0;
    const ambiguousLive: Planner = {
      name: "ambiguous-live",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((el) => el.editable)!.ref, text: "live" };
        return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Continue")!.ref };
      },
    };
    const result = await runAutopilot(page, ambiguousLive, { goal: "post", platform: "X", text: "live", mediaPaths: [], maxSteps: 3, expectedHandle: "owner", beforePublish: async () => { gateCalls++; return true; } });
    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_MAX_STEPS", publishAttempted: false });
    expect(gateCalls).toBe(0);
    expect(await page.locator("#posted").textContent()).toBe("");
  });

  it("does not trust done or a model-supplied URL without a new browser receipt", async () => {
    await page.setContent('<main>nothing was published</main>');
    const liar: Planner = { name: "liar", async next() { return { type: "done", summary: "posted", postUrl: "https://x.com/example/status/123" }; } };
    const result = await runAutopilot(page, liar, { goal: "post", platform: "X", text: "hello", mediaPaths: [], maxSteps: 2, beforePublish: async () => true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("AUTOPILOT_UNVERIFIED_RECEIPT");
    expect(result.postUrl).toBeNull();
  });

  it("does not accept a pre-existing post link as a fresh publish receipt", async () => {
    await page.setContent('<div role="textbox" contenteditable="true" id="ed"></div><button>Post</button><a href="https://x.com/example/status/123">old post</a>');
    let calls = 0;
    const staleReceipt: Planner = {
      name: "stale-receipt",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((el) => el.editable)!.ref, text: "hello" };
        if (calls === 2) return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Post")!.ref };
        return { type: "done", summary: "posted", postUrl: "https://x.com/example/status/123" };
      },
    };
    const result = await runAutopilot(page, staleReceipt, { goal: "post", platform: "X", text: "hello", mediaPaths: [], maxSteps: 4, expectedHandle: "example", beforePublish: async () => true });
    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_UNVERIFIED_RECEIPT", postUrl: null, publishAttempted: true });
  });

  it("authorizes exactly once immediately before submit after planner-ready", async () => {
    await page.setContent('<div role="textbox" contenteditable="true"></div><button id="post" onclick="this.insertAdjacentHTML(\'afterend\', \'<a href=&quot;https://x.com/owner/status/321&quot;>post</a>\')">Post</button>');
    let calls = 0;
    let gateCalls = 0;
    const delayedSubmit: Planner = {
      name: "delayed-submit",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((el) => el.editable)!.ref, text: "hello" };
        if (calls === 2) return { type: "done", summary: "ready" };
        if (calls === 3) return { type: "wait", ms: 100 };
        if (calls === 4) return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Post")!.ref };
        return { type: "done", summary: "posted" };
      },
    };
    const result = await runAutopilot(page, delayedSubmit, { goal: "post", platform: "X", text: "hello", mediaPaths: [], maxSteps: 6, expectedHandle: "owner", beforePublish: async () => { gateCalls++; return true; } });
    expect(result).toMatchObject({ ok: true, postUrl: "https://x.com/owner/status/321", publishAttempted: true });
    expect(gateCalls).toBe(1);
  });

  it("does not reserve a publish intent when planner-ready later fails before submit", async () => {
    await page.setContent('<div role="textbox" contenteditable="true"></div><button>Post</button>');
    let calls = 0;
    let gateCalls = 0;
    const readyThenFail: Planner = {
      name: "ready-then-fail",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((el) => el.editable)!.ref, text: "hello" };
        if (calls === 2) return { type: "done", summary: "ready" };
        return { type: "fail", reason: "planner stopped before submit" };
      },
    };
    const result = await runAutopilot(page, readyThenFail, {
      goal: "post",
      platform: "X",
      text: "hello",
      mediaPaths: [],
      beforePublish: async () => { gateCalls++; return true; },
    });
    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_FAILED", publishAttempted: false });
    expect(gateCalls).toBe(0);
  });

  it("rejects a fresh canonical receipt that belongs to another account", async () => {
    await page.setContent('<div role="textbox" contenteditable="true"></div><button id="post" onclick="this.insertAdjacentHTML(\'afterend\', \'<a href=&quot;https://x.com/other/status/999&quot;>post</a>\')">Post</button>');
    let calls = 0;
    const otherAccount: Planner = {
      name: "other-account",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((el) => el.editable)!.ref, text: "hello" };
        if (calls === 2) return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Post")!.ref };
        return { type: "done", summary: "posted" };
      },
    };
    const result = await runAutopilot(page, otherAccount, { goal: "post", platform: "X", text: "hello", mediaPaths: [], maxSteps: 4, expectedHandle: "owner", beforePublish: async () => true });
    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_UNVERIFIED_RECEIPT", postUrl: null, publishAttempted: true });
  });

  it("rejects a newly observed receipt outside the short verification window", async () => {
    await page.setContent("<main></main>");
    const baseline = await capturePublishReceiptBaseline(page, "X", "owner");
    baseline.capturedAt -= 2 * 60_000 + 1;
    await page.locator("main").evaluate((main) => { main.innerHTML = '<a href="https://x.com/owner/status/456">post</a>'; });
    await expect(verifyPublishReceipt(page, "X", baseline)).resolves.toMatchObject({ verified: false, reason: "publish receipt verification window expired" });
  });

  it("fails closed when an approved submit click rejects before Playwright confirms completion", async () => {
    await page.setContent('<button id="post">Post</button>');
    let attemptSignals = 0;
    const clickFailure: Planner = {
      name: "click-failure",
      async next(input) {
        const post = input.snapshot.elements.find((el) => el.name === "Post")!;
        return { type: "click", ref: post.ref };
      },
    };
    const result = await runAutopilot(page, clickFailure, {
      goal: "post",
      platform: "X",
      text: "hello",
      mediaPaths: [],
      maxSteps: 1,
      // The actionability trial succeeds first; invalidate the element while
      // the adjacent server gate runs so only the real click can fail.
      beforePublish: async () => {
        await page.locator("#post").evaluate((element) => element.remove());
        return true;
      },
      onPublishAttempted: () => { attemptSignals++; },
    });
    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_MAX_STEPS", publishAttempted: true });
    expect(attemptSignals).toBe(1);
  });

  it("never dispatches a second submit after the first irreversible publish attempt", async () => {
    await page.setContent('<button id="post" onclick="document.querySelector(\'#count\').textContent=String(Number(document.querySelector(\'#count\').textContent)+1)">Post</button><span id="count">0</span>');
    let plannerCalls = 0;
    let gateCalls = 0;
    const repeatedSubmit: Planner = {
      name: "repeated-submit",
      async next(input) {
        plannerCalls++;
        return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Post")!.ref };
      },
    };

    const result = await runAutopilot(page, repeatedSubmit, {
      goal: "post",
      platform: "X",
      text: "hello",
      mediaPaths: [],
      maxSteps: 3,
      beforePublish: async () => { gateCalls++; return true; },
    });

    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_PUBLISH_LATCHED", publishAttempted: true });
    expect(plannerCalls).toBe(2);
    expect(gateCalls).toBe(1);
    expect(await page.locator("#count").textContent()).toBe("1");
  });

  it("blocks a later action that could manufacture a submit receipt", async () => {
    await page.setContent('<div role="textbox" contenteditable="true"></div><button>Post</button><button id="later" onclick="this.insertAdjacentHTML(\'afterend\', \'<a href=&quot;https://x.com/example/status/999&quot;>post</a>\')">Show result</button>');
    let calls = 0;
    const forgedReceipt: Planner = {
      name: "forged-receipt",
      async next(input) {
        calls++;
        if (calls === 1) return { type: "type", ref: input.snapshot.elements.find((el) => el.editable)!.ref, text: "hello" };
        if (calls === 2) return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Post")!.ref };
        if (calls === 3) return { type: "click", ref: input.snapshot.elements.find((el) => el.name === "Show result")!.ref };
        return { type: "done", summary: "posted" };
      },
    };
    const result = await runAutopilot(page, forgedReceipt, { goal: "post", platform: "X", text: "hello", mediaPaths: [], maxSteps: 5, expectedHandle: "example", beforePublish: async () => true });
    expect(result).toMatchObject({ ok: false, reason: "AUTOPILOT_PUBLISH_LATCHED", postUrl: null, publishAttempted: true });
  });

  it("blocks navigation outside the selected platform", async () => {
    await page.setContent("<main>stay here</main>");
    const outcomes: string[] = [];
    const navigator: Planner = { name: "navigator", async next() { return { type: "navigate", url: "https://evil.example/steal" }; } };
    const result = await runAutopilot(page, navigator, { goal: "post", platform: "X", text: "hello", mediaPaths: [], maxSteps: 1, beforePublish: async () => true, onStep: (_step, _action, outcome) => outcomes.push(outcome) });
    expect(result.reason).toBe("AUTOPILOT_NAVIGATION_BLOCKED");
    expect(outcomes).toContain("blocked navigation outside X");
    expect(page.url()).not.toContain("evil.example");
  });

  it("aborts a disallowed redirect before the destination route can load", async () => {
    let destinationRequests = 0;
    const destination = createServer((_request, response) => {
      destinationRequests++;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>must not load</h1>");
    });
    await listen(destination);
    const destinationUrl = `http://127.0.0.1:${(destination.address() as AddressInfo).port}/loaded`;
    const redirect = createServer((_request, response) => {
      response.writeHead(302, { location: destinationUrl });
      response.end();
    });
    await listen(redirect);
    const allowedOrigin = `http://127.0.0.1:${(redirect.address() as AddressInfo).port}`;
    const redirectUrl = `${allowedOrigin}/redirect`;
    try {
      await expect(executeAction(page, { type: "navigate", url: redirectUrl }, {
        mediaPaths: [],
        canNavigate: (url) => new URL(url).origin === allowedOrigin,
      })).rejects.toThrow(/blocked navigation redirect/);
      expect(destinationRequests).toBe(0);
      expect(page.url()).not.toBe(destinationUrl);
    } finally {
      await close(redirect);
      await close(destination);
    }
  });
});
