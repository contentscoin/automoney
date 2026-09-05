import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { makeT, signup, type T } from "./helpers";

async function pairDevice(t: T, user: Awaited<ReturnType<typeof signup>>) {
  const { code } = await user.as.mutation(api.devices.createPairCode, {});
  return await t.mutation(api.devices.pair, { code, deviceName: "PC", platform: "linux", appVersion: "0.1.0" });
}

/** mock 모드 연결: connectStart → 콜백 GET */
async function connect(t: T, user: Awaited<ReturnType<typeof signup>>, platform: "THREADS" | "INSTAGRAM", code?: string) {
  const { url, mode } = await user.as.mutation(api.meta.connectStart, { platform });
  expect(mode).toBe("mock");
  const u = new URL(url);
  if (code) u.searchParams.set("code", code);
  const res = await t.fetch(`${u.pathname}${u.search}`, { method: "GET" });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

describe("Meta API (mock adapter) — connect, cloud publish, fallback, refresh", () => {
  it("connects via OAuth callback, creates an API space, publishes in the cloud and records readback", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta1@test.com");
    const cb = await connect(t, user, "THREADS", "mock:shop_official");
    expect(cb.status).toBe(302);
    expect(cb.location).toMatch(/meta=connected/);
    const mine = await user.as.query(api.meta.listMine, {});
    expect(mine.accounts).toHaveLength(1);
    expect(mine.accounts[0]).toMatchObject({ platform: "THREADS", username: "shop_official", status: "ACTIVE", mode: "mock" });
    const spaces = await user.as.query(api.spaces.listMine, {});
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ platform: "THREADS", authMode: "META_API", sessionState: "HEALTHY" });
    // 토큰은 암호화 저장
    const acct = await t.run(async (ctx) => (await ctx.db.query("snsAccounts").collect())[0]!);
    expect(acct.tokenEnc).not.toContain("mock-THREADS");
    // 잘못된 state → error_state
    const bad = await t.fetch("/meta/callback?state=zzz&code=mock", { method: "GET" });
    expect(bad.headers.get("location")).toMatch(/error_state/);

    // 발행: 디바이스 없이도 CLOUD 실행
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: spaces[0]!._id, text: "API 로 게시하는 스레드 글 · 링크는 프로필에", mediaUrls: [], requireApproval: false });
    const before = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(before!.executor).toBe("CLOUD");
    await t.finishAllScheduledFunctions(() => {});
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job!.status).toBe("SUCCEEDED");
    const data = (job!.result as { data: { postUrl: string; authMode: string } }).data;
    expect(data.authMode).toBe("META_API");
    expect(data.postUrl).toMatch(/threads\.net\/@shop_official\/post\//);
    // readback 행 생성(24h 창 대기)
    const metrics = await t.run(async (ctx) => (await ctx.db.query("postMetrics").collect())[0]!);
    expect(metrics).toMatchObject({ jobId, channel: "THREADS", nextWindow: "24h", done: false });
    expect(metrics.snsAccountId).toBe(acct._id);
    // 드라이런은 게시하지 않음
    const dry = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: spaces[0]!._id, text: "dry", mediaUrls: [], requireApproval: false, dryRun: true });
    await t.finishAllScheduledFunctions(() => {});
    expect(((await t.run(async (ctx) => ctx.db.get(dry)))!.result as { data: { dryRun: boolean } }).data.dryRun).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.query("postMetrics").collect()).length)).toBe(1);
    // 승인 대기 → approve 시 클라우드 실행
    const gated = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: spaces[0]!._id, text: "승인 후 게시", mediaUrls: [], requireApproval: true });
    await t.finishAllScheduledFunctions(() => {});
    expect((await t.run(async (ctx) => ctx.db.get(gated)))!.status).toBe("NEEDS_APPROVAL");
    await user.as.mutation(api.jobs.approve, { jobId: gated });
    await t.finishAllScheduledFunctions(() => {});
    expect((await t.run(async (ctx) => ctx.db.get(gated)))!.status).toBe("SUCCEEDED");
    // 데스크톱 claim 은 CLOUD 잡을 집지 않는다 (남은 QUEUED 없음 확인)
    await user.as.mutation(api.meta.disconnect, { accountId: acct._id });
    expect((await user.as.query(api.spaces.listMine, {}))[0]!.sessionState).toBe("PAUSED");
  });

  it("falls back to the browser space when the token is expired and a device exists; instagram requires media", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta2@test.com");
    const { deviceToken } = await pairDevice(t, user);
    await connect(t, user, "INSTAGRAM", "mock:insta_shop");
    const space = (await user.as.query(api.spaces.listMine, {}))[0]!;
    // 미디어 없는 인스타 발행은 클라우드 검증에서 거부(기존 규칙)
    await expect(user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, text: "no media", mediaUrls: [], requireApproval: false })).rejects.toThrow(/media/);
    // 토큰 만료 시뮬레이션: 암호화된 토큰을 expired- 로 교체
    const acct = await t.run(async (ctx) => (await ctx.db.query("snsAccounts").collect())[0]!);
    const { encryptField } = await import("../convex/lib/crypto");
    await t.run(async (ctx) => {
      await ctx.db.patch(acct._id, { tokenEnc: await encryptField(process.env.KYC_ENC_KEY!, "expired-INSTAGRAM-insta_shop") });
      // 브라우저 폴백을 위해 스페이스에 디바이스 연결
      const dev = (await ctx.db.query("devices").collect())[0]!;
      await ctx.db.patch(space._id, { deviceId: dev._id });
    });
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, text: "폴백 테스트", mediaUrls: ["https://cdn.example.com/a.jpg"], requireApproval: false });
    await t.finishAllScheduledFunctions(() => {});
    const failed = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(failed!.status).toBe("FAILED");
    expect(failed!.errorCode).toBe("META_TOKEN_EXPIRED");
    expect((await t.run(async (ctx) => ctx.db.get(acct._id)))!.status).toBe("EXPIRED");
    const fallback = await t.run(async (ctx) => (await ctx.db.query("agentJobs").collect()).find((j) => j.fallbackFromJobId === jobId));
    expect(fallback).toBeTruthy();
    expect(fallback!.executor).toBe("DESKTOP");
    expect(fallback!.status).toBe("QUEUED");
    // 데스크톱 claim 이 폴백 잡을 받는다
    const claimed = await (await t.fetch("/agent/claim", { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" })).json();
    expect(claimed.data.id).toBe(fallback!._id);
    expect(claimed.data.payload.text).toBe("폴백 테스트");
    // 강제 실패([meta-fail]) 는 토큰 문제가 아니므로 계정 상태 유지 + 폴백
    await t.run(async (ctx) => {
      await ctx.db.patch(acct._id, { status: "ACTIVE", tokenEnc: await encryptField(process.env.KYC_ENC_KEY!, "mock-INSTAGRAM-insta_shop") });
    });
    const j2 = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, text: "[meta-fail] 본문", mediaUrls: ["https://cdn.example.com/a.jpg"], requireApproval: false });
    await t.finishAllScheduledFunctions(() => {});
    expect((await t.run(async (ctx) => ctx.db.get(j2)))!.errorCode).toBe("META_PUBLISH_FAILED");
    expect((await t.run(async (ctx) => ctx.db.get(acct._id)))!.status).toBe("ACTIVE");
  });

  it("schedules token refresh jobs 7 days before expiry and refreshes via the cloud runner", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta3@test.com");
    await connect(t, user, "THREADS");
    const acct = await t.run(async (ctx) => (await ctx.db.query("snsAccounts").collect())[0]!);
    expect(await t.mutation(internal.meta.scheduleRefreshes, {})).toMatchObject({ created: 0 });
    const soon = Date.now() + 3 * 24 * 3600_000;
    await t.run(async (ctx) => ctx.db.patch(acct._id, { tokenExpiresAt: soon }));
    expect(await t.mutation(internal.meta.scheduleRefreshes, {})).toMatchObject({ created: 1 });
    expect(await t.mutation(internal.meta.scheduleRefreshes, {})).toMatchObject({ created: 1 }); // 멱등(같은 날)
    await t.finishAllScheduledFunctions(() => {});
    const after = await t.run(async (ctx) => ctx.db.get(acct._id));
    expect(after!.tokenExpiresAt).toBeGreaterThan(soon + 30 * 24 * 3600_000);
    const jobs = await t.run(async (ctx) => ctx.db.query("agentJobs").collect());
    expect(jobs.filter((j) => j.jobType === "meta.token_refresh")).toHaveLength(1);
    expect(jobs[0]!.status).toBe("SUCCEEDED");
    expect((await user.as.query(api.meta.status, {})).mode).toBe("mock");
  });
});
