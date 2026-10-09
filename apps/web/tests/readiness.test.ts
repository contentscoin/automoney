import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT, seedProduct, signup } from "./helpers";

describe("runtime readiness", () => {
  it("exposes capabilities without secrets and keeps account readiness tenant scoped", async () => {
    const t = makeT();
    const user = await signup(t, "readiness@test.com");
    const other = await signup(t, "other-ready@test.com");
    process.env.LIVE_PUBLISH_ENABLED = "false";
    const publicFlags = await t.query(api.readiness.getPublic, {});
    expect(publicFlags).toEqual({ livePublishEnabled: false, partnerMode: "mock", publicSiteConfigured: true, metaConfigured: true, minimumDesktopVersion: "0.1.16" });
    expect(Object.keys(publicFlags).some((key) => /secret|token|email|url/i.test(key))).toBe(false);
    await expect(t.query(api.readiness.getMine, {})).rejects.toThrow(/로그인/);
    const empty = await user.as.query(api.readiness.getMine, {});
    expect(empty).toMatchObject({ device: null, aiReady: false, spaces: [], links: { liveCount: 0, demoCount: 0 } });
    expect(empty.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["DEVICE_REQUIRED", "LIVE_PUBLISH_DISABLED"]));
    const { code } = await user.as.mutation(api.devices.createPairCode, {});
    const paired = await t.mutation(api.devices.pair, { code, deviceName: "워크 PC", platform: "win32", appVersion: "0.1.16" });
    const { spaceId } = await user.as.mutation(api.spaces.create, { platform: "X", name: "readiness" });
    await t.run(async (ctx) => {
      await ctx.db.patch(paired.deviceId, { snapshot: { codexInstalled: true, codexLoggedIn: true, internalSecret: "should-not-be-returned" } });
      await ctx.db.patch(spaceId, { sessionState: "HEALTHY", handle: "readiness_user" });
    });
    const productId = await seedProduct(t);
    await user.as.action(api.links.issue, { productId });
    const ready = await user.as.query(api.readiness.getMine, { refreshKey: 1 });
    expect(ready).toMatchObject({ aiReady: true, device: { online: true, compatible: true }, links: { demoCount: 1, liveCount: 0 } });
    expect(ready.spaces[0]).toMatchObject({ id: spaceId, readyForTest: true, readyForLive: false });
    expect(JSON.stringify(ready)).not.toContain("should-not-be-returned");
    expect(await other.as.query(api.readiness.getMine, {})).toMatchObject({ device: null, spaces: [], links: { demoCount: 0, liveCount: 0 } });
    await t.run((ctx) => ctx.db.patch(user.userId, { status: "PENDING" }));
    const pending = await user.as.query(api.readiness.getMine, {});
    expect(pending.aiReady).toBe(false);
    expect(pending.issues.some((issue) => issue.code === "ACCOUNT_PENDING")).toBe(true);
    expect(pending.spaces[0]).toMatchObject({ readyForTest: false, readyForLive: false });
    await t.run((ctx) => ctx.db.patch(user.userId, { status: "ACTIVE" }));
    await t.run((ctx) => ctx.db.patch(paired.deviceId, { lastSeenAt: Date.now() - 120_000 }));
    const offline = await user.as.query(api.readiness.getMine, { refreshKey: 2 });
    expect(offline.aiReady).toBe(false);
    expect(offline.spaces[0]).toMatchObject({ readyForTest: false, readyForLive: false });
    expect(offline.spaces[0]!.issues.map((issue) => issue.code)).toContain("DEVICE_OFFLINE");
  });

  it("separates mock and graph capabilities without returning provider credentials", async () => {
    const t = makeT();
    const user = await signup(t, "meta-readiness@test.com");
    const before = { id: process.env.META_APP_ID, secret: process.env.META_APP_SECRET };
    delete process.env.META_ALLOW_MOCK_LIVE_TESTS;
    process.env.META_APP_ID = "readiness-app";
    process.env.META_APP_SECRET = "private-readiness-secret";
    try {
      const mock = await t.query(api.readiness.getPublic, {});
      expect(mock.metaConfigured).toBe(false);
      const { code } = await user.as.mutation(api.devices.createPairCode, {});
      await t.mutation(api.devices.pair, { code, deviceName: "PC", platform: "win32", appVersion: "0.1.16" });
      const { spaceId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "Meta API" });
      const accountId = await t.run(async (ctx) => {
        const accountId = await ctx.db.insert("snsAccounts", { userId: user.userId, platform: "THREADS", providerUserId: "private-provider-id", username: "meta_ready", tokenEnc: "private-token-encrypted", tokenExpiresAt: Date.now() + 3600_000, scopes: [], status: "ACTIVE", mode: "mock", spaceId, createdAt: Date.now() });
        await ctx.db.patch(spaceId, { authMode: "META_API", snsAccountId: accountId, sessionState: "HEALTHY", handle: "meta_ready" });
        return accountId;
      });
      expect((await user.as.query(api.readiness.getMine, {})).spaces[0]).toMatchObject({ readyForTest: true, readyForLive: false });
      process.env.META_MODE = "graph";
      expect((await t.query(api.readiness.getPublic, {})).metaConfigured).toBe(true);
      expect((await user.as.query(api.readiness.getMine, {})).spaces[0]!.readyForLive).toBe(false);
      await t.run((ctx) => ctx.db.patch(accountId, { mode: "graph" }));
      const live = await user.as.query(api.readiness.getMine, {});
      expect(live.spaces[0]).toMatchObject({ readyForTest: true, readyForLive: true });
      expect(JSON.stringify(live)).not.toMatch(/private-provider-id|private-token-encrypted|private-readiness-secret|readiness-app/);
      await t.run((ctx) => ctx.db.patch(accountId, { tokenExpiresAt: Date.now() - 1 }));
      const expired = await user.as.query(api.readiness.getMine, {});
      expect(expired.spaces[0]).toMatchObject({ readyForTest: false, readyForLive: false });
      expect(expired.spaces[0]!.issues.some((issue) => issue.code === "META_RECONNECT_REQUIRED")).toBe(true);
    } finally {
      if (before.id === undefined) delete process.env.META_APP_ID; else process.env.META_APP_ID = before.id;
      if (before.secret === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = before.secret;
      process.env.META_MODE = "mock";
      process.env.META_ALLOW_MOCK_LIVE_TESTS = "true";
    }
  });
});
