import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-agent-"));
process.env.AUTOMONEY_USER_DATA = tmp;
process.env.AUTOMONEY_HEARTBEAT_MS = "50";

import { loadConfig, saveConfig, isPaired } from "../src/agent/config";
import { AgentApi, ApiError } from "../src/agent/api";
import { AgentLoop, type Handler } from "../src/agent/loop";
import { acquireLock } from "../src/agent/spaces/lock";
import { createSpace, listLocalSpaces, makeFingerprint, readMeta } from "../src/agent/spaces/manager";
import { spaceLockPath } from "../src/agent/paths";
import { okResult } from "@automoney/shared";

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
      "/complete": () => new Response(JSON.stringify({ success: false, error: { code: "CONFLICT", message: "JOB_NOT_ACTIVE" } }), { status: 409 }),
    });
    const api = new AgentApi({ ...loadConfig(), deviceToken: TOKEN, deviceId: "d" }, fetch);
    expect(await api.claim({})).toBeNull();
    expect((calls[0]!.url as string).endsWith("/agent/claim")).toBe(true);
    expect(await api.heartbeat("j1", "x")).toEqual({ active: true, cancelRequested: false });
    await expect(api.complete("j1", { status: "SUCCEEDED" })).rejects.toBeInstanceOf(ApiError);
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
  it("claims, heartbeats, runs handler, completes; failures report error codes; cancel via heartbeat", async () => {
    saveConfig({ ...loadConfig(), deviceId: "d1", deviceToken: TOKEN });
    const queue: unknown[] = [
      { id: "j1", jobType: "space.create", payload: { spaceId: "sp_a", platform: "X", name: "a" }, spaceId: "sp_a", space: null, leaseMs: 1000 },
      { id: "j2", jobType: "post.publish", payload: { spaceId: "sp_a", platform: "X", text: "hi", mediaUrls: [] }, spaceId: "sp_a", space: null, leaseMs: 1000 },
      { id: "j3", jobType: "space.verify", payload: { spaceId: "sp_a", platform: "X" }, spaceId: "sp_a", space: null, leaseMs: 1000 },
    ];
    let cancelJ3 = false;
    const { fetch, calls } = fakeFetch({
      "/agent/claim": () => queue.shift() ?? null,
      "/heartbeat": (_i, url) => ({ active: true, cancelRequested: url.includes("/j3/") && cancelJ3 }),
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
