import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { makeT, signup, type T } from "./helpers";
import { metaLivePublishAvailable } from "../convex/lib/meta";
import { createGraphAdapter } from "../convex/lib/meta/graph";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function pairDevice(t: T, user: Awaited<ReturnType<typeof signup>>) {
  const { code } = await user.as.mutation(api.devices.createPairCode, {});
  return await t.mutation(api.devices.pair, { code, deviceName: "PC", platform: "linux", appVersion: "0.1.13" });
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
  it("allows mock live publishing only inside the explicit test harness", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousEscape = process.env.META_ALLOW_MOCK_LIVE_TESTS;
    try {
      process.env.NODE_ENV = "production";
      process.env.META_ALLOW_MOCK_LIVE_TESTS = "true";
      expect(metaLivePublishAvailable("mock")).toBe(false);
      process.env.NODE_ENV = "test";
      expect(metaLivePublishAvailable("mock")).toBe(true);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      process.env.META_ALLOW_MOCK_LIVE_TESTS = previousEscape;
    }
  });

  it("keeps the reservation uncertain after an irreversible Meta publish attempt fails", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta-attempt@test.com");
    await connect(t, user, "THREADS", "mock:attempt_shop");
    const space = (await user.as.query(api.spaces.listMine, {}))[0]!;
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, text: "시도 후 오류", mediaUrls: [], requireApproval: false });
    await user.as.mutation(api.jobs.approve, { jobId });
    expect(await t.mutation(internal.meta.markRunning, { jobId, stage: "meta_publishing" })).toBe(true);
    expect(await t.mutation(internal.agent.preflightJob, { jobId })).toMatchObject({ ok: true });
    expect(await t.mutation(internal.meta.markCloudPublishAttempted, { jobId })).toBe(true);
    await t.mutation(internal.meta.completeCloudJob, {
      jobId,
      status: "FAILED",
      errorCode: "META_TOKEN_EXPIRED",
      errorMessage: "provider response lost",
      accountStatus: "EXPIRED",
      fallback: true,
    });
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({ status: "FAILED", publishPhase: "UNCERTAIN", errorCode: "PUBLISH_RESULT_UNCERTAIN" });
    expect(await t.run(async (ctx) => ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", jobId)).unique())).toMatchObject({ state: "UNCERTAIN" });
    expect((await t.run(async (ctx) => ctx.db.query("agentJobs").collect())).filter((job) => job.fallbackFromJobId === jobId)).toHaveLength(0);
  });

  it("releases a cloud publish lease lost before the commit marker but keeps a post-marker loss uncertain", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta-lease-fence@test.com");
    await connect(t, user, "THREADS", "mock:lease_fence");
    const space = (await user.as.query(api.spaces.listMine, {}))[0]!;

    const beforeMarker = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, text: "커밋 전 중단", mediaUrls: [], requireApproval: false });
    await user.as.mutation(api.jobs.approve, { jobId: beforeMarker });
    expect(await t.mutation(internal.meta.markRunning, { jobId: beforeMarker, stage: "meta_publishing" })).toBe(true);
    await t.run((ctx) => ctx.db.patch(beforeMarker, { leaseUntil: Date.now() - 1 }));
    expect(await t.mutation(internal.jobs.sweep, {})).toMatchObject({ lost: 1 });
    expect(await t.run((ctx) => ctx.db.get(beforeMarker))).toMatchObject({
      status: "FAILED",
      publishPhase: "PREPARING",
      errorCode: "AGENT_LOST_BEFORE_PUBLISH",
    });
    expect(await t.run((ctx) => ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", beforeMarker)).unique())).toBeNull();

    const afterMarker = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, text: "커밋 후 응답 중단", mediaUrls: [], requireApproval: false });
    await user.as.mutation(api.jobs.approve, { jobId: afterMarker });
    expect(await t.mutation(internal.meta.markRunning, { jobId: afterMarker, stage: "meta_publishing" })).toBe(true);
    expect(await t.mutation(internal.agent.preflightJob, { jobId: afterMarker })).toMatchObject({ ok: true });
    expect(await t.mutation(internal.meta.markCloudPublishAttempted, { jobId: afterMarker })).toBe(true);
    await t.run((ctx) => ctx.db.patch(afterMarker, { leaseUntil: Date.now() - 1 }));
    expect(await t.mutation(internal.jobs.sweep, {})).toMatchObject({ lost: 1 });
    expect(await t.run((ctx) => ctx.db.get(afterMarker))).toMatchObject({
      status: "FAILED",
      publishPhase: "UNCERTAIN",
      errorCode: "AGENT_LOST_UNCERTAIN",
    });
    expect(await t.run((ctx) => ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", afterMarker)).unique())).toMatchObject({ state: "UNCERTAIN" });
  });

  it("aborts an unresponsive Graph request after 30 seconds as a retryable error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const request = createGraphAdapter({ appId: "app", appSecret: "secret" }).me("THREADS", "token");
    const rejected = expect(request).rejects.toMatchObject({ code: "META_PUBLISH_FAILED", retryable: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

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
    await user.as.mutation(api.jobs.approve, { jobId });
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
    await t.run(async (ctx) => {
      for (const reservation of await ctx.db.query("publishReservations").collect()) await ctx.db.patch(reservation._id, { committedAt: Date.now() - 16 * 60_000 });
    });
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
    const browser = await user.as.mutation(api.spaces.create, { platform: "INSTAGRAM", name: "브라우저", handle: "insta_shop" });
    await t.fetch("/agent/claim", { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" });
    await t.fetch(`/agent/jobs/${browser.jobId}/complete`, { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "insta_shop" } }) });
    // 미디어 없는 인스타 발행은 클라우드 검증에서 거부(기존 규칙)
    await expect(user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, text: "no media", mediaUrls: [], requireApproval: false })).rejects.toThrow(/media/);
    // 토큰 만료 시뮬레이션: 암호화된 토큰을 expired- 로 교체
    const acct = await t.run(async (ctx) => (await ctx.db.query("snsAccounts").collect())[0]!);
    await user.as.mutation(api.meta.setFallbackSpace, { accountId: acct._id, fallbackSpaceId: browser.spaceId });
    const { encryptField } = await import("../convex/lib/crypto");
    await t.run(async (ctx) => {
      await ctx.db.patch(acct._id, { tokenEnc: await encryptField(process.env.KYC_ENC_KEY!, "expired-INSTAGRAM-insta_shop") });
    });
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, contentChannel: "INSTAGRAM_FEED", text: "폴백 테스트", mediaUrls: ["https://cdn.example.com/a.jpg"], requireApproval: false });
    const fallbackExpiresAt = Date.now() + 60 * 60_000;
    await t.run(async (ctx) => ctx.db.patch(jobId, { expiresAt: fallbackExpiresAt }));
    await user.as.mutation(api.jobs.approve, { jobId });
    await t.finishAllScheduledFunctions(() => {});
    const failed = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(failed!.status).toBe("FAILED");
    expect(failed!.errorCode).toBe("META_TOKEN_EXPIRED");
    expect((await t.run(async (ctx) => ctx.db.get(acct._id)))!.status).toBe("EXPIRED");
    const fallback = await t.run(async (ctx) => (await ctx.db.query("agentJobs").collect()).find((j) => j.fallbackFromJobId === jobId));
    expect(fallback).toBeTruthy();
    expect(fallback!.executor).toBe("DESKTOP");
    expect(fallback!.status).toBe("NEEDS_APPROVAL");
    expect(fallback!.approvalRequired).toBe(true);
    expect(fallback!.approval).toBeUndefined();
    expect(fallback!.expiresAt).toBe(fallbackExpiresAt);
    await user.as.mutation(api.jobs.approve, { jobId: fallback!._id });
    expect(await t.run((ctx) => ctx.db.get(fallback!._id))).toMatchObject({
      status: "QUEUED",
      approval: { payloadHash: fallback!.payloadHash },
    });
    // 데스크톱 claim 이 폴백 잡을 받는다
    const claimed = await (await t.fetch("/agent/claim", { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" })).json();
    expect(claimed.data.id).toBe(fallback!._id);
    expect(claimed.data.payload.text).toBe("폴백 테스트");
    // 강제 실패([meta-fail]) 는 토큰 문제가 아니므로 계정 상태 유지 + 폴백
    await t.run(async (ctx) => {
      await ctx.db.patch(acct._id, { status: "ACTIVE", tokenEnc: await encryptField(process.env.KYC_ENC_KEY!, "mock-INSTAGRAM-insta_shop") });
      await ctx.db.patch(space._id, { sessionState: "HEALTHY", lockJobId: undefined });
    });
    const j2 = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: space._id, contentChannel: "INSTAGRAM_FEED", text: "[meta-fail] 본문", mediaUrls: ["https://cdn.example.com/a.jpg"], requireApproval: false });
    await user.as.mutation(api.jobs.approve, { jobId: j2 });
    await t.finishAllScheduledFunctions(() => {});
    expect((await t.run(async (ctx) => ctx.db.get(j2)))!.errorCode).toBe("META_PUBLISH_FAILED");
    expect((await t.run(async (ctx) => ctx.db.get(acct._id)))!.status).toBe("ACTIVE");
  });

  it("keeps a consumed one-shot schedule valid across a Meta-to-browser fallback", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta-one-shot-fallback@test.com");
    const { deviceToken } = await pairDevice(t, user);
    await connect(t, user, "INSTAGRAM", "mock:scheduled_shop");
    const apiSpace = (await user.as.query(api.spaces.listMine, {}))[0]!;
    const browser = await user.as.mutation(api.spaces.create, { platform: "INSTAGRAM", name: "예약 브라우저", handle: "scheduled_shop" });
    await t.fetch("/agent/claim", { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" });
    await t.fetch(`/agent/jobs/${browser.jobId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "scheduled_shop" } }),
    });
    const account = await t.run(async (ctx) => (await ctx.db.query("snsAccounts").collect())[0]!);
    await user.as.mutation(api.meta.setFallbackSpace, { accountId: account._id, fallbackSpaceId: browser.spaceId });
    const { encryptField } = await import("../convex/lib/crypto");
    await t.run(async (ctx) => ctx.db.patch(account._id, { tokenEnc: await encryptField(process.env.KYC_ENC_KEY!, "expired-INSTAGRAM-scheduled_shop") }));

    const futureKst = new Date(Date.now() + 9 * 3600_000 + 24 * 3600_000);
    const schedule = await user.as.mutation(api.schedules.upsert, {
      spaceId: apiSpace._id,
      kind: "ONE_SHOT",
      runDate: futureKst.toISOString().slice(0, 10),
      timeOfDay: `${String(futureKst.getUTCHours()).padStart(2, "0")}:${String(futureKst.getUTCMinutes()).padStart(2, "0")}`,
      daysOfWeek: [],
      jitterMinutes: 0,
      contentChannel: "INSTAGRAM_FEED",
      text: "일회 예약 폴백",
      mediaUrls: ["https://cdn.example.com/a.jpg"],
      autoApprove: false,
    });
    await t.run((ctx) => ctx.db.patch(schedule.scheduleId, { runDate: "2000-01-01", nextRunAt: Date.now() - 1 }));
    expect(await t.mutation(internal.schedules.tick, { now: Date.now() })).toMatchObject({ created: 1 });
    const originalJobId = (await t.run((ctx) => ctx.db.get(schedule.scheduleId)))!.lastJobId!;
    await user.as.mutation(api.jobs.approve, { jobId: originalJobId });
    await t.finishAllScheduledFunctions(() => {});

    const fallback = await t.run(async (ctx) => (await ctx.db.query("agentJobs").collect()).find((job) => job.fallbackFromJobId === originalJobId));
    expect(fallback).toMatchObject({ executor: "DESKTOP", rootJobId: originalJobId, scheduleId: schedule.scheduleId, status: "NEEDS_APPROVAL" });
    await user.as.mutation(api.jobs.approve, { jobId: fallback!._id });
    const claim = (await (await t.fetch("/agent/claim", { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" })).json()).data;
    expect(claim.id).toBe(fallback!._id);
    const preflight = await t.fetch(`/agent/jobs/${fallback!._id}/preflight`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ attemptNo: claim.attemptNo, leaseToken: claim.leaseToken }),
    });
    expect(preflight.status).toBe(200);
    const marked = await t.fetch(`/agent/jobs/${fallback!._id}/publish-attempt`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ attemptNo: claim.attemptNo, leaseToken: claim.leaseToken }),
    });
    expect(marked.status).toBe(200);
  });

  it("keeps cancellation authoritative before and after a cloud fallback is created", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta-cancel-lineage@test.com");
    const { deviceToken } = await pairDevice(t, user);
    await connect(t, user, "THREADS", "mock:cancel_lineage");
    const apiSpace = (await user.as.query(api.spaces.listMine, {}))[0]!;
    const browser = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "취소 폴백", handle: "cancel_lineage" });
    const creation = await (await t.fetch("/agent/claim", { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" })).json();
    expect(creation.data.id).toBe(browser.jobId);
    await t.fetch(`/agent/jobs/${browser.jobId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "cancel_lineage" } }),
    });
    const account = await t.run(async (ctx) => (await ctx.db.query("snsAccounts").collect())[0]!);
    await user.as.mutation(api.meta.setFallbackSpace, { accountId: account._id, fallbackSpaceId: browser.spaceId });

    const cancelledFirst = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: apiSpace._id, text: "호출 전 취소", mediaUrls: [] });
    await user.as.mutation(api.jobs.approve, { jobId: cancelledFirst });
    expect(await t.mutation(internal.meta.markRunning, { jobId: cancelledFirst, stage: "meta_publishing" })).toBe(true);
    await user.as.mutation(api.jobs.cancel, { jobId: cancelledFirst });
    await t.mutation(internal.meta.completeCloudJob, {
      jobId: cancelledFirst,
      status: "FAILED",
      errorCode: "META_TOKEN_EXPIRED",
      errorMessage: "cancel won",
      fallback: true,
    });
    expect(await t.run((ctx) => ctx.db.get(cancelledFirst))).toMatchObject({ status: "CANCELLED", errorCode: "JOB_CANCELLED", cancelRequested: true });
    expect((await t.run((ctx) => ctx.db.query("agentJobs").collect())).filter((job) => job.fallbackFromJobId === cancelledFirst)).toHaveLength(0);

    const fallbackFirst = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: apiSpace._id, text: "폴백 뒤 취소", mediaUrls: [] });
    await user.as.mutation(api.jobs.approve, { jobId: fallbackFirst });
    // Simulate a trusted auto-approved schedule/MCP lineage, whose fallback is
    // immediately QUEUED instead of waiting for another human approval.
    await t.run((ctx) => ctx.db.patch(fallbackFirst, { approvalRequired: false }));
    expect(await t.mutation(internal.meta.markRunning, { jobId: fallbackFirst, stage: "meta_publishing" })).toBe(true);
    await t.mutation(internal.meta.completeCloudJob, {
      jobId: fallbackFirst,
      status: "FAILED",
      errorCode: "META_TOKEN_EXPIRED",
      errorMessage: "fallback queued",
      fallback: true,
    });
    const child = await t.run(async (ctx) => (await ctx.db.query("agentJobs").collect()).find((job) => job.fallbackFromJobId === fallbackFirst));
    expect(child).toMatchObject({ status: "QUEUED", rootJobId: fallbackFirst });
    await user.as.mutation(api.jobs.cancel, { jobId: fallbackFirst });
    expect(await t.run((ctx) => ctx.db.get(fallbackFirst))).toMatchObject({ status: "FAILED", cancelRequested: true });
    expect(await t.run((ctx) => ctx.db.get(child!._id))).toMatchObject({ status: "CANCELLED", cancelRequested: true, errorCode: "JOB_CANCELLED" });
  });

  it("never creates a browser fallback after the original cloud job expires", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta-expired-fallback@test.com");
    const { deviceToken } = await pairDevice(t, user);
    await connect(t, user, "THREADS", "mock:expired_fallback");
    const apiSpace = (await user.as.query(api.spaces.listMine, {}))[0]!;
    const browser = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "브라우저", handle: "expired_fallback" });
    const createClaim = await (await t.fetch("/agent/claim", { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" })).json();
    expect(createClaim.data.id).toBe(browser.jobId);
    await t.fetch(`/agent/jobs/${browser.jobId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "expired_fallback" } }),
    });
    const account = await t.run(async (ctx) => (await ctx.db.query("snsAccounts").collect())[0]!);
    await user.as.mutation(api.meta.setFallbackSpace, { accountId: account._id, fallbackSpaceId: browser.spaceId });
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: apiSpace._id, text: "만료된 실행", mediaUrls: [], requireApproval: false });
    await t.run((ctx) => ctx.db.patch(jobId, { expiresAt: Date.now() - 1 }));
    await user.as.mutation(api.jobs.approve, { jobId });
    await t.finishAllScheduledFunctions(() => {});

    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: "FAILED", errorCode: "SCHEDULE_EXPIRED" });
    expect((await t.run((ctx) => ctx.db.query("agentJobs").collect())).filter((job) => job.fallbackFromJobId === jobId)).toHaveLength(0);
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

  it("continues past the first token-refresh batch without starving later accounts", async () => {
    const t = makeT();
    delete process.env.META_APP_ID;
    const user = await signup(t, "meta-refresh-batch@test.com");
    await connect(t, user, "THREADS", "mock:refresh_batch_0");
    const seed = await t.run(async (ctx) => (await ctx.db.query("snsAccounts").collect())[0]!);
    const soon = Date.now() + 3 * 24 * 3600_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(seed._id, { tokenExpiresAt: soon });
      for (let index = 1; index < 26; index++) {
        const accountId = await ctx.db.insert("snsAccounts", {
          userId: user.userId,
          platform: "THREADS",
          providerUserId: `refresh-batch-${index}`,
          username: `refresh_batch_${index}`,
          tokenEnc: seed.tokenEnc,
          tokenExpiresAt: soon + index,
          scopes: seed.scopes,
          status: "ACTIVE",
          mode: "mock",
          createdAt: Date.now() + index,
        });
        const spaceId = await ctx.db.insert("spaces", {
          userId: user.userId,
          platform: "THREADS",
          name: `refresh-${index}`,
          handle: `refresh_batch_${index}`,
          pinned: false,
          sessionState: "HEALTHY",
          dailyPostLimit: 1,
          authMode: "META_API",
          snsAccountId: accountId,
          createdAt: Date.now() + index,
        });
        await ctx.db.patch(accountId, { spaceId });
      }
    });

    expect(await t.mutation(internal.meta.scheduleRefreshes, {})).toMatchObject({ due: 25, batchLimited: true });
    expect((await t.run((ctx) => ctx.db.query("agentJobs").collect())).filter((job) => job.jobType === "meta.token_refresh")).toHaveLength(25);
    await t.finishAllScheduledFunctions(() => {});
    const refreshJobs = (await t.run((ctx) => ctx.db.query("agentJobs").collect())).filter((job) => job.jobType === "meta.token_refresh");
    expect(refreshJobs).toHaveLength(26);
    expect(refreshJobs.every((job) => job.status === "SUCCEEDED")).toBe(true);
  });
});
