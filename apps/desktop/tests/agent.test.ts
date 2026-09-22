import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-agent-"));
process.env.AUTOMONEY_USER_DATA = tmp;
process.env.AUTOMONEY_HEARTBEAT_MS = "50";

import { DEFAULT_CONVEX_SITE_URL, DEFAULT_SITE_URL, loadConfig, saveConfig, isPaired } from "../src/agent/config";
import { AgentApi, ApiError } from "../src/agent/api";
import { AgentLoop, CancelledError, type Handler } from "../src/agent/loop";
import { acquireLock } from "../src/agent/spaces/lock";
import { createSpace, listLocalSpaces, makeFingerprint, readMeta } from "../src/agent/spaces/manager";
import { spaceLockPath } from "../src/agent/paths";
import { okResult } from "@automoney/shared";
import { beforePublishGate, downloadMedia, handlePublish, requireMatchingPublishHandle, resolvePublishDryRun } from "../src/agent/jobs/handlers";
import { completionJournal } from "../src/agent/completion-journal";
import { redact } from "../src/agent/logger";
import { testExecutablePath } from "./browser";

const TOKEN = "A".repeat(43);

function fakeFetch(routes: Record<string, (init: RequestInit, url: string) => unknown>) {
  const calls: { url: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (!key) return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: url } }), { status: 404 });
    const out = routes[key]!(init, url);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ success: true, data: out }), { status: 200 });
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});
afterEach(() => vi.restoreAllMocks());

describe("config", () => {
  it("uses the live service endpoints by default", () => {
    expect(DEFAULT_CONVEX_SITE_URL).toBe("https://wry-ermine-412.convex.site");
    expect(DEFAULT_SITE_URL).toBe("https://automoney-eight.vercel.app");
    expect(loadConfig()).toMatchObject({ convexSiteUrl: DEFAULT_CONVEX_SITE_URL, siteUrl: DEFAULT_SITE_URL });
  });

  it("round-trips and reports pairing", () => {
    expect(isPaired(loadConfig())).toBe(false);
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    expect(isPaired(loadConfig())).toBe(true);
    expect(loadConfig().deviceToken).toBe(TOKEN);
  });
});

describe("api client", () => {
  it("sends bearer token and unwraps envelopes; maps errors", async () => {
    const { fetch, calls } = fakeFetch({
      "/agent/claim": () => null,
      "/heartbeat": () => ({ active: true, cancelRequested: false }),
      "/preflight": () => ({ ok: true, dryRun: false, publishIntentId: "r1", protocolVersion: 2, livePublishEnabled: true }),
      "/publish-attempt": () => ({ recorded: true }),
      "/publish-continuation": () => ({ authorized: true }),
      "/complete": () => new Response(JSON.stringify({ success: false, error: { code: "CONFLICT", message: "JOB_NOT_ACTIVE" } }), { status: 409 }),
    });
    const api = new AgentApi({ ...loadConfig(), deviceToken: TOKEN, deviceId: "d" }, fetch);
    expect(await api.claim({})).toBeNull();
    expect((calls[0]!.url as string).endsWith("/agent/claim")).toBe(true);
    const ref = { id: "j1", attemptNo: 1, leaseToken: "lease" };
    expect(await api.heartbeat(ref, "x")).toEqual({ active: true, cancelRequested: false });
    expect(await api.preflight(ref)).toMatchObject({ protocolVersion: 2, livePublishEnabled: true, publishIntentId: "r1" });
    expect(await api.markPublishAttempted(ref)).toEqual({ recorded: true });
    expect(await api.revalidatePublishContinuation(ref)).toEqual({ authorized: true });
    await expect(api.complete(ref, { completionId: "c1", status: "SUCCEEDED" })).rejects.toBeInstanceOf(ApiError);
    const unpaired = new AgentApi(loadConfig(), fetch);
    await expect(unpaired.claim({})).rejects.toMatchObject({ code: "UNPAIRED" });
  });
});

describe("space lock & profiles", () => {
  it("creates isolated space dirs with stable fingerprints", () => {
    const m = createSpace({ spaceId: "sp_1", platform: "THREADS", name: "메인" });
    expect(readMeta("sp_1")?.fingerprint).toEqual(makeFingerprint("sp_1"));
    expect(makeFingerprint("sp_1")).toEqual(makeFingerprint("sp_1"));
    expect(listLocalSpaces().map((s) => s.spaceId)).toEqual(["sp_1"]);
    expect(createSpace({ spaceId: "sp_1", platform: "THREADS", name: "다른이름" }).name).toBe(m.name);
  });
  it("lock is exclusive, reclaims stale locks, and releases only by owner", () => {
    const p = spaceLockPath("sp_lock");
    const a = acquireLock(p, "test");
    expect(() => acquireLock(p, "test2")).toThrow(/SPACE_LOCKED/);
    a.release();
    fs.writeFileSync(p, JSON.stringify({ ownerId: "ghost", pid: 999999, acquiredAt: Date.now() }));
    const b = acquireLock(p, "reclaim");
    expect(fs.existsSync(p)).toBe(true);
    b.release();
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe("agent loop", () => {
  it("requires the stored and observed publish account handles to match", () => {
    expect(requireMatchingPublishHandle("@Owner", "owner")).toBe("owner");
    for (const [stored, observed] of [["owner", "other"], ["owner", null], [null, "owner"]] as const) {
      let thrown: unknown;
      try { requireMatchingPublishHandle(stored, observed); } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ code: "SPACE_ACCOUNT_MISMATCH" });
    }
  });

  it("rejects an observed account mismatch before opening the deterministic composer", async () => {
    const spaceId = "mismatched-publish-account";
    createSpace({ spaceId, platform: "X", name: "wrong account", handle: "stale_local_handle" });
    process.env.AUTOMONEY_X_URL = pathToFileURL(path.join(__dirname, "fixtures", "fake-x.html")).toString();
    const stages: string[] = [];
    try {
      await expect(handlePublish({
        cfg: { ...loadConfig(), headless: true, autopilot: false, executablePath: testExecutablePath() },
        api: {} as never,
        job: {
          id: "mismatched-publish-account-job",
          jobType: "post.publish",
          payload: { spaceId, platform: "X", text: "must not publish", mediaUrls: [], dryRun: true },
          spaceId,
          space: { _id: spaceId, platform: "X", name: "wrong account", handle: "expected_owner", pinned: false },
          leaseMs: 1_000,
          protocolVersion: 2,
          attemptNo: 1,
          leaseToken: "lease",
          leaseExpiresAt: Date.now() + 10_000,
        },
        async checkpoint(stage) { stages.push(stage); },
      })).rejects.toMatchObject({ code: "SPACE_ACCOUNT_MISMATCH" });
      expect(stages).toEqual(["preparing"]);
    } finally {
      delete process.env.AUTOMONEY_X_URL;
    }
  });

  it("does not enter autopilot recovery when a dry-run recipe fails", async () => {
    const spaceId = "dry-recipe-failure";
    createSpace({ spaceId, platform: "X", name: "dry", handle: "e2e_handle" });
    process.env.AUTOMONEY_X_URL = pathToFileURL(path.join(__dirname, "fixtures", "fake-x.html")).toString();
    process.env.AUTOMONEY_AUTOPILOT_PLANNER = "scripted";
    const stages: string[] = [];
    try {
      await expect(handlePublish({
        cfg: { ...loadConfig(), headless: true, autopilot: true, executablePath: testExecutablePath() },
        api: {} as never,
        job: {
          id: "dry-recipe-job",
          jobType: "post.publish",
          payload: { spaceId, platform: "X", text: "dry", mediaUrls: [], dryRun: true },
          spaceId,
          space: { _id: spaceId, platform: "X", name: "dry", handle: "e2e_handle", pinned: false },
          leaseMs: 1_000,
          protocolVersion: 2,
          attemptNo: 1,
          leaseToken: "lease",
          leaseExpiresAt: Date.now() + 10_000,
        },
        async checkpoint(stage) {
          stages.push(stage);
          if (stage === "compose") throw new Error("recipe selector changed");
        },
      })).rejects.toMatchObject({ code: "RECIPE_FAILED", message: expect.stringContaining("오토파일럿 복구를 실행하지 않았습니다") });
      expect(stages).not.toContain("autopilot");
    } finally {
      delete process.env.AUTOMONEY_X_URL;
      delete process.env.AUTOMONEY_AUTOPILOT_PLANNER;
    }
  });

  it("turns cancellation after the deterministic publish click into an uncertain result", async () => {
    const spaceId = "cancel-after-publish";
    createSpace({ spaceId, platform: "X", name: "live", handle: "e2e_handle" });
    process.env.AUTOMONEY_X_URL = pathToFileURL(path.join(__dirname, "fixtures", "fake-x.html")).toString();
    const api = {
      preflight: async () => ({ ok: true as const, dryRun: false, publishIntentId: "intent", protocolVersion: 2 as const, livePublishEnabled: true }),
      markPublishAttempted: async () => ({ recorded: true as const }),
    };
    try {
      await expect(handlePublish({
        cfg: { ...loadConfig(), headless: true, autopilot: false, executablePath: testExecutablePath() },
        api: api as never,
        job: {
          id: "cancel-after-publish-job",
          jobType: "post.publish",
          payload: { spaceId, platform: "X", text: "live", mediaUrls: [], dryRun: false },
          spaceId,
          space: { _id: spaceId, platform: "X", name: "live", handle: "e2e_handle", pinned: false },
          leaseMs: 1_000,
          protocolVersion: 2,
          attemptNo: 1,
          leaseToken: "lease",
          leaseExpiresAt: Date.now() + 10_000,
        },
        async checkpoint(stage) {
          if (stage === "posted") throw new CancelledError("cancelled after click");
        },
      })).rejects.toMatchObject({ code: "PUBLISH_RESULT_UNCERTAIN" });
    } finally {
      delete process.env.AUTOMONEY_X_URL;
    }
  });

  it("reserves a live publish only once at the final gate", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    const job = { id: "live-preflight", jobType: "post.publish", payload: { spaceId: "sp_a", platform: "X", text: "hi", mediaUrls: [], dryRun: false }, spaceId: "sp_a", space: null, leaseMs: 1000, protocolVersion: 2, attemptNo: 1, leaseToken: "lease", leaseExpiresAt: Date.now() + 1000 };
    let claimed = false;
    const { fetch, calls } = fakeFetch({
      "/agent/claim": () => claimed ? null : (claimed = true, job),
      "/heartbeat": () => ({ active: true, cancelRequested: false }),
      "/preflight": () => ({ ok: true, dryRun: false, publishIntentId: "r1", protocolVersion: 2, livePublishEnabled: true }),
      "/complete": () => ({ ok: true }),
    });
    const handler: Handler = async (ctx) => {
      expect(await beforePublishGate(ctx, false)).toBe(true);
      return { result: okResult("post.publish", "published") };
    };
    const loop = new AgentLoop({}, "0.1.1", fetch, { "post.publish": handler } as never);
    expect(await loop.pollOnce()).toBe(1);
    expect(calls.filter((call) => call.url.includes("/preflight"))).toHaveLength(1);
  });

  it("fails closed when the live-publish switch is denied by the final preflight", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    const job = { id: "kill-switch", jobType: "post.publish", payload: { spaceId: "sp_a", platform: "X", text: "hi", mediaUrls: [], dryRun: false }, spaceId: "sp_a", space: null, leaseMs: 1000, protocolVersion: 2, attemptNo: 1, leaseToken: "lease", leaseExpiresAt: Date.now() + 1000 };
    let claimed = false;
    let preflightCalls = 0;
    const { fetch, calls } = fakeFetch({
      "/agent/claim": () => claimed ? null : (claimed = true, job),
      "/heartbeat": () => ({ active: true, cancelRequested: false }),
      "/preflight": () => (preflightCalls++, new Response(JSON.stringify({ success: false, error: { code: "LIVE_PUBLISH_DISABLED", message: "disabled" } }), { status: 409 })),
      "/complete": () => ({ ok: true }),
    });
    const handler: Handler = async (ctx) => {
      await beforePublishGate(ctx, false);
      throw new Error("unreachable");
    };
    const loop = new AgentLoop({}, "0.1.1", fetch, { "post.publish": handler } as never);
    expect(await loop.pollOnce()).toBe(1);
    expect(calls.filter((call) => call.url.includes("/preflight"))).toHaveLength(1);
    expect(calls.find((call) => call.url.includes("/complete"))?.body).toMatchObject({ status: "FAILED", errorCode: "LIVE_PUBLISH_DISABLED" });
  });

  it("retains the initial dry-run marker without issuing a second preflight for a blocked submit", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    const job = { id: "dry-preflight", jobType: "post.publish", payload: { spaceId: "sp_a", platform: "X", text: "hi", mediaUrls: [], dryRun: true }, spaceId: "sp_a", space: null, leaseMs: 1000, protocolVersion: 2, attemptNo: 1, leaseToken: "lease", leaseExpiresAt: Date.now() + 1000 };
    let claimed = false;
    const { fetch, calls } = fakeFetch({
      "/agent/claim": () => claimed ? null : (claimed = true, job),
      "/heartbeat": () => ({ active: true, cancelRequested: false }),
      "/preflight": () => ({ ok: true, dryRun: true, publishIntentId: null, protocolVersion: 2, livePublishEnabled: true }),
      "/complete": () => ({ ok: true }),
    });
    const handler: Handler = async (ctx) => {
      expect(await beforePublishGate(ctx, true)).toBe(false);
      return { result: okResult("post.publish", "dry run") };
    };
    const loop = new AgentLoop({}, "0.1.1", fetch, { "post.publish": handler } as never);
    expect(await loop.pollOnce()).toBe(1);
    expect(calls.filter((call) => call.url.includes("/preflight"))).toHaveLength(1);
  });

  it("fails a live payload instead of committing it as success under the local dry-run override", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    const job = { id: "local-dry-run", jobType: "post.publish", payload: { spaceId: "sp_a", platform: "X", text: "hi", mediaUrls: [], dryRun: false }, spaceId: "sp_a", space: null, leaseMs: 1000, protocolVersion: 2, attemptNo: 1, leaseToken: "lease", leaseExpiresAt: Date.now() + 1000 };
    let claimed = false;
    const { fetch, calls } = fakeFetch({
      "/agent/claim": () => claimed ? null : (claimed = true, job),
      "/preflight": () => ({ ok: true, dryRun: false, publishIntentId: "r1", protocolVersion: 2, livePublishEnabled: true }),
      "/complete": () => ({ ok: true }),
    });
    const handler: Handler = async () => {
      resolvePublishDryRun(false, "1");
      throw new Error("unreachable");
    };
    const loop = new AgentLoop({}, "0.1.1", fetch, { "post.publish": handler } as never);
    expect(await loop.pollOnce()).toBe(1);
    expect(calls.filter((call) => call.url.includes("/preflight"))).toHaveLength(0);
    expect(calls.find((call) => call.url.includes("/complete"))?.body).toMatchObject({ status: "FAILED", errorCode: "LOCAL_DRY_RUN_OVERRIDE" });
    expect(resolvePublishDryRun(true, "1")).toBe(true);
  });

  it("claims, heartbeats, runs handler, completes; failures report error codes; cancel via heartbeat", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    const queue: unknown[] = [
      { id: "j1", jobType: "space.create", payload: { spaceId: "sp_a", platform: "X", name: "a" }, spaceId: "sp_a", space: null, leaseMs: 1000, protocolVersion: 2, attemptNo: 1, leaseToken: "l1", leaseExpiresAt: Date.now() + 1000 },
      { id: "j2", jobType: "post.publish", payload: { spaceId: "sp_a", platform: "X", text: "hi", mediaUrls: [] }, spaceId: "sp_a", space: null, leaseMs: 1000, protocolVersion: 2, attemptNo: 1, leaseToken: "l2", leaseExpiresAt: Date.now() + 1000 },
      { id: "j3", jobType: "space.verify", payload: { spaceId: "sp_a", platform: "X" }, spaceId: "sp_a", space: null, leaseMs: 1000, protocolVersion: 2, attemptNo: 1, leaseToken: "l3", leaseExpiresAt: Date.now() + 1000 },
    ];
    let cancelJ3 = false;
    const { fetch, calls } = fakeFetch({
      "/agent/claim": () => queue.shift() ?? null,
      "/heartbeat": (_i, url) => ({ active: true, cancelRequested: url.includes("/j3/") && cancelJ3 }),
      "/preflight": () => ({ ok: true, dryRun: false, publishIntentId: "r1", protocolVersion: 2, livePublishEnabled: true }),
      "/complete": () => ({ ok: true }),
    });
    const handlers: Record<string, Handler> = {
      "space.create": async (ctx) => {
        await ctx.checkpoint("creating", 50);
        return { result: okResult("space.create", "ok"), spaceUpdate: { sessionState: "LOGIN_REQUIRED" } };
      },
      "post.publish": async () => {
        throw Object.assign(new Error("boom"), { code: "SPACE_LOCKED" });
      },
      "space.verify": async (ctx) => {
        cancelJ3 = true;
        await ctx.checkpoint("verifying", 10);
        return { result: okResult("space.verify", "never") };
      },
    };
    const loop = new AgentLoop({}, "0.1.0", fetch, handlers as never);
    expect(await loop.pollOnce()).toBe(1);
    expect(await loop.pollOnce()).toBe(1);
    expect(await loop.pollOnce()).toBe(1);
    expect(await loop.pollOnce()).toBe(0);
    const completes = calls.filter((c) => c.url.includes("/complete")).map((c) => c.body as { status: string; errorCode?: string; spaceUpdate?: unknown });
    expect(completes.map((c) => c.status)).toEqual(["SUCCEEDED", "FAILED", "FAILED"]);
    expect(completes[0]!.spaceUpdate).toEqual({ sessionState: "LOGIN_REQUIRED" });
    expect(completes[1]!.errorCode).toBe("SPACE_LOCKED");
    expect(completes[2]!.errorCode).toBe("JOB_CANCELLED");
    expect(loop.status.processed).toBe(3);
  });

  it("unpairs itself when the token is rejected", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    const { fetch } = fakeFetch({ "/agent/claim": () => new Response(JSON.stringify({ success: false, error: { code: "UNAUTHENTICATED", message: "bad" } }), { status: 401 }) });
    const loop = new AgentLoop({}, "0.1.0", fetch);
    expect(await loop.pollOnce()).toBe(0);
    expect(isPaired(loadConfig())).toBe(false);
    expect(loop.status.online).toBe(false);
  });
});

describe("media fetch policy", () => {
  it("blocks local URLs by default and validates MIME in fixture mode", async () => {
    delete process.env.AUTOMONEY_ALLOW_PRIVATE_MEDIA;
    await expect(downloadMedia(["http://127.0.0.1/private.jpg"])).rejects.toMatchObject({ code: "MEDIA_URL_BLOCKED" });
    process.env.AUTOMONEY_ALLOW_PRIVATE_MEDIA = "1";
    try {
      const fake = vi.fn(async () => new Response("html", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
      await expect(downloadMedia(["http://127.0.0.1/file"], fake)).rejects.toMatchObject({ code: "MEDIA_TYPE_UNSUPPORTED" });
    } finally {
      delete process.env.AUTOMONEY_ALLOW_PRIVATE_MEDIA;
    }
  });

  it("journals a successful result when delivery is lost and resends without executing twice", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    const job = { id: "lost-success", jobType: "space.verify", payload: {}, spaceId: null, space: null, leaseMs: 1000, protocolVersion: 2, attemptNo: 1, leaseToken: "lease", leaseExpiresAt: Date.now() + 1000 };
    let claimed = false;
    let completionCalls = 0;
    let executions = 0;
    const { fetch, calls } = fakeFetch({
      "/agent/claim": () => claimed ? null : (claimed = true, job),
      "/heartbeat": () => ({ active: true, cancelRequested: false }),
      "/complete": () => ++completionCalls === 1 ? new Response(JSON.stringify({ success: false, error: { code: "TEMP", message: "lost" } }), { status: 503 }) : ({ ok: true, duplicate: true }),
    });
    const handler: Handler = async () => { executions++; return { result: okResult("space.verify", "verified") }; };
    const loop = new AgentLoop({}, "0.1.1", fetch, { "space.verify": handler } as never);
    expect(await loop.pollOnce()).toBe(1);
    expect(completionJournal.list()).toHaveLength(1);
    expect(await loop.pollOnce()).toBe(0);
    expect(executions).toBe(1);
    expect(completionCalls).toBe(2);
    expect(completionJournal.list()).toHaveLength(0);
    const completionBodies = calls.filter((call) => call.url.includes("/complete")).map((call) => call.body as { attemptNo?: number; leaseToken?: string });
    expect(completionBodies).toHaveLength(2);
    expect(completionBodies[1]).toMatchObject({ attemptNo: 1, leaseToken: "lease" });
  });

  it("quarantines a stale completion and continues flushing later entries", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    completionJournal.put({ jobId: "stale", attemptNo: 1, leaseToken: "old-lease", completionId: "c-stale", status: "SUCCEEDED", result: okResult("space.verify", "old") });
    completionJournal.put({ jobId: "fresh", attemptNo: 2, leaseToken: "fresh-lease", completionId: "c-fresh", status: "SUCCEEDED", result: okResult("space.verify", "new") });
    const { fetch, calls } = fakeFetch({
      "/complete": (_init, url) => url.includes("/stale/")
        ? new Response(JSON.stringify({ success: false, error: { code: "CONFLICT", message: "STALE_ATTEMPT" } }), { status: 409 })
        : ({ ok: true }),
      "/agent/claim": () => null,
    });
    const loop = new AgentLoop({}, "0.1.1", fetch);
    expect(await loop.pollOnce()).toBe(0);
    expect(completionJournal.list()).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes("/complete"))).toHaveLength(2);
    expect(completionJournal.quarantined()).toEqual([
      expect.objectContaining({ completionId: "c-stale", quarantineReason: expect.stringContaining("STALE_ATTEMPT"), leaseTokenPresent: true }),
    ]);
    expect(completionJournal.quarantined()[0]).not.toHaveProperty("leaseToken");
  });
  it("redacts tokens and KYC plaintext from logs", () => {
    const text = redact(JSON.stringify({ deviceToken: "A".repeat(43), accessToken: "secret-access-token-value", residentNo: "950505-2123456", accountNo: "12345678901234" }));
    expect(text).not.toContain("950505-2123456");
    expect(text).not.toContain("secret-access-token-value");
    expect(text).not.toContain("12345678901234");
  });
});
