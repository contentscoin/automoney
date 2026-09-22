import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { makeT, seedProduct, signup, type T } from "./helpers";

async function pairDevice(t: T, user: Awaited<ReturnType<typeof signup>>, appVersion = "0.1.13") {
  const { code } = await user.as.mutation(api.devices.createPairCode, {});
  const paired = await t.mutation(api.devices.pair, { code, deviceName: "테스트 PC", platform: "linux", appVersion });
  return paired;
}

const authed = (token: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" } });
const approveLive = async (user: Awaited<ReturnType<typeof signup>>, jobId: Id<"agentJobs">) => user.as.mutation(api.jobs.approve, { jobId });
const markPublishAttempt = (t: T, token: string, jobId: Id<"agentJobs">, proof: { attemptNo: number; leaseToken: string }) =>
  t.fetch(`/agent/jobs/${jobId}/publish-attempt`, authed(token, { method: "POST", body: JSON.stringify(proof) }));
const continuePublishAttempt = (t: T, token: string, jobId: Id<"agentJobs">, proof: { attemptNo: number; leaseToken: string }) =>
  t.fetch(`/agent/jobs/${jobId}/publish-continuation`, authed(token, { method: "POST", body: JSON.stringify(proof) }));

describe("device pairing & agent contract", () => {
  it("queues Codex login only for an online paired device", async () => {
    const t = makeT();
    const user = await signup(t, "codex-connect@test.com");
    await expect(user.as.mutation(api.devices.requestCodexLogin, {})).rejects.toThrow(/온라인/);
    const paired = await pairDevice(t, user);
    const first = await user.as.mutation(api.devices.requestCodexLogin, {});
    expect((await t.run((ctx) => ctx.db.get(first.jobId)))?.jobType).toBe("codex.login");
    await t.run((ctx) => ctx.db.patch(paired.deviceId, { lastSeenAt: Date.now() - 120_000 }));
    await expect(user.as.mutation(api.devices.requestCodexLogin, {})).rejects.toThrow(/온라인/);
  });

  it("binds approval to payload, isolates request keys per tenant, and enforces v2 attempts/completion replay", async () => {
    const t = makeT();
    const user = await signup(t, "v2@test.com");
    const other = await signup(t, "v2-other@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "v2" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "v2_shop" } }) }));

    const publish = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "승인 본문", mediaUrls: [] });
    expect((await t.run((ctx) => ctx.db.get(publish)))?.status).toBe("NEEDS_APPROVAL");
    await user.as.mutation(api.jobs.approve, { jobId: publish });
    const approved = await t.run((ctx) => ctx.db.get(publish));
    expect(approved?.approval?.payloadHash).toBe(approved?.payloadHash);

    const claimedResponse = await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    const claimed = (await claimedResponse.json()).data as { id: string; attemptNo: number; leaseToken: string; protocolVersion: number };
    expect(claimed).toMatchObject({ id: publish, attemptNo: 1, protocolVersion: 2 });
    const stale = await (await t.fetch(`/agent/jobs/${publish}/heartbeat`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: 0, leaseToken: "wrong" }) }))).json();
    expect(stale.data.staleAttempt).toBe(true);
    expect((await t.fetch(`/agent/jobs/${publish}/preflight`, authed(deviceToken, { method: "POST", body: "{}" }))).status).toBe(409);
    expect((await t.fetch(`/agent/jobs/${publish}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: claimed.attemptNo, leaseToken: claimed.leaseToken, status: "SUCCEEDED" }) }))).status).toBe(409);
    const preflight = await t.fetch(`/agent/jobs/${publish}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: claimed.attemptNo, leaseToken: claimed.leaseToken }) }));
    expect(preflight.status).toBe(200);
    expect((await preflight.json()).data).toMatchObject({ protocolVersion: 2, livePublishEnabled: true });
    const prematureContinuation = await continuePublishAttempt(t, deviceToken, publish, claimed);
    expect(prematureContinuation.status).toBe(409);
    expect((await prematureContinuation.json()).error.code).toBe("PUBLISH_ATTEMPT_REQUIRED");
    expect((await markPublishAttempt(t, deviceToken, publish, claimed)).status).toBe(200);
    expect((await continuePublishAttempt(t, deviceToken, publish, claimed)).status).toBe(200);
    expect((await markPublishAttempt(t, deviceToken, publish, claimed)).status).toBe(409);
    const repeatedPreflight = await t.fetch(`/agent/jobs/${publish}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(claimed) }));
    expect(repeatedPreflight.status).toBe(409);
    expect((await repeatedPreflight.json()).error.code).toBe("PUBLISH_ALREADY_ATTEMPTED");
    await t.run((ctx) => ctx.db.patch(publish, { cancelRequested: true }));
    const revokedContinuation = await continuePublishAttempt(t, deviceToken, publish, claimed);
    expect(revokedContinuation.status).toBe(409);
    expect((await revokedContinuation.json()).error.code).toBe("JOB_CANCELLED");
    await t.run((ctx) => ctx.db.patch(publish, { cancelRequested: false }));
    const completion = { attemptNo: claimed.attemptNo, leaseToken: claimed.leaseToken, completionId: "completion-v2", status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok", data: { postUrl: "https://www.threads.net/@v2_shop/post/CV2" } } };
    expect((await t.fetch(`/agent/jobs/${publish}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify(completion) }))).status).toBe(200);
    expect((await t.fetch(`/agent/jobs/${publish}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify(completion) }))).status).toBe(200);
    expect((await t.fetch(`/agent/jobs/${publish}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ completionId: completion.completionId, status: completion.status, result: completion.result }) }))).status).toBe(200);
    expect((await t.fetch(`/agent/jobs/${publish}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ ...completion, status: "FAILED" }) }))).status).toBe(409);

    const key = "same-request";
    const a = await t.mutation(internal.jobs.enqueueInternal, { userId: user.userId, jobType: "content.generate", payload: { a: 1 }, source: "SYSTEM", requestKey: key });
    expect(await t.mutation(internal.jobs.enqueueInternal, { userId: user.userId, jobType: "content.generate", payload: { a: 1 }, source: "SYSTEM", requestKey: key })).toBe(a);
    await expect(t.mutation(internal.jobs.enqueueInternal, { userId: user.userId, jobType: "content.generate", payload: { a: 2 }, source: "SYSTEM", requestKey: key })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(await t.mutation(internal.jobs.enqueueInternal, { userId: other.userId, jobType: "content.generate", payload: { a: 2 }, source: "SYSTEM", requestKey: key })).not.toBe(a);
  });

  it("pairs with a one-time code, replaces the previous device, and authenticates HTTP calls", async () => {
    const t = makeT();
    const user = await signup(t, "d1@test.com");
    const first = await pairDevice(t, user);
    expect(first.deviceToken).toHaveLength(43);
    const second = await pairDevice(t, user);
    const devices = await user.as.query(api.devices.listMine, {});
    expect(devices.map((d) => d.status).sort()).toEqual(["ACTIVE", "REPLACED"]);

    // 교체된 토큰은 거부, 새 토큰은 통과
    const bad = await t.fetch("/agent/claim", authed(first.deviceToken, { method: "POST", body: "{}" }));
    expect(bad.status).toBe(401);
    const ok = await t.fetch("/agent/claim", authed(second.deviceToken, { method: "POST", body: JSON.stringify({ appVersion: "0.1.1" }) }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toBeNull();
    const cfg = await t.fetch("/agent/config", authed(second.deviceToken));
    expect((await cfg.json()).data).toMatchObject({ userEmail: "d1@test.com", protocolVersion: 2, capabilities: { livePublish: true, publishPreflightRequired: true } });
    // 잘못된 코드
    await expect(t.mutation(api.devices.pair, { code: "ZZZZZZZZ", deviceName: "x", platform: "x", appVersion: "0" })).rejects.toThrow(/페어링 코드/);
  });

  it("never gives an irreversible publish job to a desktop without the publish safety protocol", async () => {
    const t = makeT();
    const user = await signup(t, "old-publisher@test.com");
    const { deviceToken } = await pairDevice(t, user, "0.1.12");
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "X", name: "구버전", handle: "old_publisher" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: JSON.stringify({ appVersion: "0.1.12" }) }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "old_publisher" } }) }));
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "구버전 차단", mediaUrls: [], requireApproval: false });
    await approveLive(user, jobId);
    const claim = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: JSON.stringify({ appVersion: "0.1.12" }) }))).json();
    expect(claim.data).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({ status: "QUEUED" });
    const config = await (await t.fetch("/agent/config", authed(deviceToken))).json();
    expect(config.data.minAppVersion).toBe("0.1.13");
  });

  it("serializes aliases of one publishing account and applies the strictest daily limit", async () => {
    const t = makeT();
    const user = await signup(t, "account-mutex@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const firstSpace = await user.as.mutation(api.spaces.create, { platform: "X", name: "별칭 1", handle: "same_shop" });
    const secondSpace = await user.as.mutation(api.spaces.create, { platform: "X", name: "별칭 2", handle: "@SAME_SHOP" });
    for (const createJobId of [firstSpace.jobId, secondSpace.jobId]) {
      const claim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
      expect(claim.id).toBe(createJobId);
      await t.fetch(`/agent/jobs/${createJobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "same_shop" } }) }));
    }
    await user.as.mutation(api.spaces.setDailyLimit, { spaceId: firstSpace.spaceId, dailyPostLimit: 3 });
    await user.as.mutation(api.spaces.setDailyLimit, { spaceId: secondSpace.spaceId, dailyPostLimit: 1 });

    const first = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: firstSpace.spaceId, text: "첫 게시", mediaUrls: [], requireApproval: false });
    const second = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: secondSpace.spaceId, text: "동시 게시", mediaUrls: [], requireApproval: false });
    await approveLive(user, first);
    await approveLive(user, second);
    const firstClaim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    expect(firstClaim.id).toBe(first);
    expect((await t.fetch(`/agent/jobs/${first}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(firstClaim) }))).status).toBe(200);
    const originalDay = await t.run(async (ctx) => {
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", first)).unique();
      const day = reservation!.kstDay;
      await ctx.db.patch(reservation!._id, { kstDay: "1999-12-31" });
      return day;
    });
    const secondClaim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    expect(secondClaim.id).toBe(second);
    const blocked = await t.fetch(`/agent/jobs/${second}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(secondClaim) }));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("PUBLISH_IN_PROGRESS");
    await t.run(async (ctx) => {
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", first)).unique();
      await ctx.db.patch(reservation!._id, { kstDay: originalDay });
    });
    await t.fetch(`/agent/jobs/${second}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ ...secondClaim, status: "FAILED", errorCode: "PUBLISH_IN_PROGRESS" }) }));
    expect((await markPublishAttempt(t, deviceToken, first, firstClaim)).status).toBe(200);
    await t.fetch(`/agent/jobs/${first}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ ...firstClaim, status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok", data: { postUrl: "https://x.com/same_shop/status/1001" } } }) }));
    await t.run(async (ctx) => {
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", first)).unique();
      await ctx.db.patch(reservation!._id, { kstDay: "1999-12-31" });
    });
    const intervalJob = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: secondSpace.spaceId, text: "자정 경계 간격", mediaUrls: [], requireApproval: false });
    await approveLive(user, intervalJob);
    const intervalClaim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    const intervalBlocked = await t.fetch(`/agent/jobs/${intervalJob}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(intervalClaim) }));
    expect(intervalBlocked.status).toBe(409);
    expect((await intervalBlocked.json()).error.code).toBe("MIN_INTERVAL");
    await t.fetch(`/agent/jobs/${intervalJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ ...intervalClaim, status: "FAILED", errorCode: "MIN_INTERVAL" }) }));
    await t.run(async (ctx) => {
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", first)).unique();
      await ctx.db.patch(reservation!._id, { kstDay: originalDay, committedAt: Date.now() - 16 * 60_000 });
    });

    const third = await user.as.mutation(api.jobs.enqueuePublish, { spaceId: firstSpace.spaceId, text: "한도 초과", mediaUrls: [], requireApproval: false });
    await approveLive(user, third);
    const thirdClaim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    expect(thirdClaim.id).toBe(third);
    const dailyBlocked = await t.fetch(`/agent/jobs/${third}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(thirdClaim) }));
    expect(dailyBlocked.status).toBe(409);
    expect((await dailyBlocked.json()).error.code).toBe("DAILY_LIMIT");
  });

  it("fails closed for live publishing while retaining dry-run and capability discovery", async () => {
    const t = makeT();
    const user = await signup(t, "kill-switch@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "safe" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "safe_shop" } }) }));

    const queuedLive = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "queued-live", mediaUrls: [], requireApproval: false });
    await approveLive(user, queuedLive);
    delete process.env.LIVE_PUBLISH_ENABLED;
    await expect(user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "live", mediaUrls: [], requireApproval: false })).rejects.toThrow(/kill switch/);
    const liveClaim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    expect(liveClaim.id).toBe(queuedLive);
    const denied = await t.fetch(`/agent/jobs/${queuedLive}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: liveClaim.attemptNo, leaseToken: liveClaim.leaseToken }) }));
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { code: "LIVE_PUBLISH_DISABLED" }, data: { protocolVersion: 2, livePublishEnabled: false } });
    await t.fetch(`/agent/jobs/${queuedLive}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: liveClaim.attemptNo, leaseToken: liveClaim.leaseToken, status: "FAILED", errorCode: "LIVE_PUBLISH_DISABLED" }) }));
    const dry = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "dry", mediaUrls: [], requireApproval: false, dryRun: true });
    const claimed = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    expect(claimed.id).toBe(dry);
    const preflight = await t.fetch(`/agent/jobs/${dry}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: claimed.attemptNo, leaseToken: claimed.leaseToken }) }));
    expect((await preflight.json()).data).toMatchObject({ dryRun: true, protocolVersion: 2, livePublishEnabled: false, publishIntentId: null });
    const config = await (await t.fetch("/agent/config", authed(deviceToken))).json();
    expect(config.data.capabilities.livePublish).toBe(false);
    process.env.LIVE_PUBLISH_ENABLED = "true";
  });

  it("marks running publishes uncertain instead of requeueing on revoke or replacement", async () => {
    const t = makeT();
    const startPublish = async (email: string) => {
      const user = await signup(t, email);
      const paired = await pairDevice(t, user);
      const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: email });
      await t.fetch("/agent/claim", authed(paired.deviceToken, { method: "POST", body: "{}" }));
      await t.fetch(`/agent/jobs/${createJob}/complete`, authed(paired.deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: email.split("@")[0] } }) }));
      const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "uncertain", mediaUrls: [], requireApproval: false });
      await approveLive(user, jobId);
      const claim = (await (await t.fetch("/agent/claim", authed(paired.deviceToken, { method: "POST", body: "{}" }))).json()).data;
      await t.fetch(`/agent/jobs/${jobId}/preflight`, authed(paired.deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: claim.attemptNo, leaseToken: claim.leaseToken }) }));
      return { user, paired, jobId };
    };

    const revoked = await startPublish("revoke-running@test.com");
    await revoked.user.as.mutation(api.devices.revoke, { deviceId: revoked.paired.deviceId });
    expect(await t.run(async (ctx) => ctx.db.get(revoked.jobId))).toMatchObject({ status: "FAILED", publishPhase: "UNCERTAIN", errorCode: "AGENT_LOST_UNCERTAIN" });
    expect(await t.run(async (ctx) => ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", revoked.jobId)).unique())).toMatchObject({ state: "UNCERTAIN" });

    const replaced = await startPublish("replace-running@test.com");
    await pairDevice(t, replaced.user);
    expect(await t.run(async (ctx) => ctx.db.get(replaced.jobId))).toMatchObject({ status: "FAILED", publishPhase: "UNCERTAIN", errorCode: "AGENT_LOST_UNCERTAIN" });
    expect(await t.run(async (ctx) => ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", replaced.jobId)).unique())).toMatchObject({ state: "UNCERTAIN" });
  });

  it("runs a space job through claim → heartbeat → complete with space lock and state update", async () => {
    const t = makeT();
    const user = await signup(t, "d2@test.com");
    await expect(user.as.mutation(api.spaces.create, { platform: "THREADS", name: "메인" })).rejects.toThrow(/페어링/);
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "메인", handle: "@shop_main" });

    const claimed = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(claimed.data.id).toBe(jobId);
    expect(claimed.data.jobType).toBe("space.create");
    expect(claimed.data.space.platform).toBe("THREADS");
    // 같은 스페이스는 락 → 두 번째 클레임은 없음
    await user.as.mutation(api.spaces.requestLogin, { spaceId });
    const again = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(again.data).toBeNull();

    const hb = await (await t.fetch(`/agent/jobs/${jobId}/heartbeat`, authed(deviceToken, { method: "POST", body: JSON.stringify({ stage: "creating", progress: 40 }) }))).json();
    expect(hb.data).toEqual({ active: true, cancelRequested: false });

    const done = await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok" }, spaceUpdate: { sessionState: "LOGIN_REQUIRED", fingerprint: { ua: "x" } } }) }));
    expect(done.status).toBe(200);
    const spaces = await user.as.query(api.spaces.listMine, {});
    expect(spaces[0]?.sessionState).toBe("LOGIN_REQUIRED");
    expect(spaces[0]?.locked).toBe(false);
    // 락 해제 후 대기 중이던 로그인 잡이 클레임된다
    const next = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(next.data.jobType).toBe("space.login");
    // 중복 complete 는 409
    const dup = await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED" }) }));
    expect(dup.status).toBe(409);
    const jobs = await user.as.query(api.jobs.listMine, {});
    expect(jobs.find((j) => j._id === jobId)?.status).toBe("SUCCEEDED");
  });

  it("validates publish payloads, supports approval flow and cancellation", async () => {
    const t = makeT();
    const user = await signup(t, "d3@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "X", name: "엑스" });
    // space.create 잡 완료시켜 락 해제
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "x_shop" } }) }));

    await expect(user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "a".repeat(300), mediaUrls: [] })).rejects.toThrow(/exceeds/);
    const productId = await seedProduct(t);
    const link = await user.as.action(api.links.issue, { productId });
    const links = await user.as.query(api.links.listMine, {});
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "신상 원피스 소개", mediaUrls: [], linkId: links[0]!._id, requireApproval: true });
    let jobs = await user.as.query(api.jobs.listMine, {});
    expect(jobs[0]?.status).toBe("NEEDS_APPROVAL");
    const none = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(none.data).toBeNull();
    await user.as.mutation(api.jobs.approve, { jobId });
    const claimed = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(claimed.data.id).toBe(jobId);
    expect(claimed.data.payload.linkUrl).toContain(`/r/${link.shortCode}`);
    // 실행 중 취소 요청 → 하트비트로 전달
    await user.as.mutation(api.jobs.cancel, { jobId });
    const hb = await (await t.fetch(`/agent/jobs/${jobId}/heartbeat`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: claimed.data.attemptNo, leaseToken: claimed.data.leaseToken }) }))).json();
    expect(hb.data.cancelRequested).toBe(true);
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: claimed.data.attemptNo, leaseToken: claimed.data.leaseToken, status: "FAILED", errorCode: "JOB_CANCELLED" }) }));
    jobs = await user.as.query(api.jobs.listMine, {});
    expect(jobs.find((j) => j._id === jobId)?.status).toBe("CANCELLED");
  });

  it("deduplicates publish retries by a tenant-scoped client request id", async () => {
    const t = makeT();
    const user = await signup(t, "publish-retry@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "재시도" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "confirmed_shop" } }) }));

    const clientRequestId = "publish_retry_1234";
    const input = { spaceId, text: "같은 게시 본문", mediaUrls: [] as string[], dryRun: true, clientRequestId };
    const first = await user.as.mutation(api.jobs.enqueuePublish, input);
    expect(await user.as.mutation(api.jobs.enqueuePublish, input)).toBe(first);
    expect(await t.run(async (ctx) => (await ctx.db.get(first))?.requestKey)).toBe(`publish-request:${user.userId}:${clientRequestId}`);
    expect((await user.as.query(api.jobs.listMine, {})).filter((job) => job._id === first)).toHaveLength(1);

    await expect(user.as.mutation(api.jobs.enqueuePublish, { ...input, text: "변경된 게시 본문" })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    await expect(user.as.mutation(api.jobs.enqueuePublish, { ...input, clientRequestId: "short" })).rejects.toThrow(/요청 식별자/);
    await expect(user.as.mutation(api.jobs.enqueuePublish, { ...input, clientRequestId: "publish retry 1234" })).rejects.toThrow(/요청 식별자/);
  });

  it("revalidates mutable policy at the publish-attempt boundary", async () => {
    const t = makeT();
    const user = await signup(t, "attempt-policy@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "X", name: "직전 재검증", handle: "attempt_policy" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "attempt_policy" } }) }));
    const productId = await seedProduct(t, 100099);
    const issued = await user.as.action(api.links.issue, { productId });
    const linkId = (await user.as.query(api.links.listMine, {})).find((link) => link.shortCode === issued.shortCode)!._id;
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "직전 링크 상태 확인", mediaUrls: [], linkId });
    await user.as.mutation(api.jobs.approve, { jobId });
    const claim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data as { attemptNo: number; leaseToken: string };
    expect((await t.fetch(`/agent/jobs/${jobId}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(claim) }))).status).toBe(200);

    await user.as.mutation(api.links.setStatus, { linkId, status: "DISABLED" });
    expect((await markPublishAttempt(t, deviceToken, jobId, claim)).status).toBe(409);
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({ publishPhase: "INTENT_RECORDED" });
    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.publishAttemptedAt).toBeUndefined();
  });

  it("keeps a publish reservation uncertain when the click result cannot be verified", async () => {
    const t = makeT();
    const user = await signup(t, "publish-uncertain@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "확인 필요" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "confirmed_shop" } }) }));

    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "게시 여부 확인", mediaUrls: [] });
    await user.as.mutation(api.jobs.approve, { jobId });
    const claimed = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data as { attemptNo: number; leaseToken: string };
    await t.fetch(`/agent/jobs/${jobId}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(claimed) }));
    const done = await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ ...claimed, status: "FAILED", errorCode: "PUBLISH_RESULT_UNCERTAIN", errorMessage: "게시 결과 확인 실패" }) }));
    expect(done.status).toBe(200);
    expect(await t.run(async (ctx) => (await ctx.db.get(jobId))?.publishPhase)).toBe("UNCERTAIN");
    expect(await t.run(async (ctx) => (await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", jobId)).unique())?.state)).toBe("UNCERTAIN");

    await expect(user.as.mutation(api.jobs.resolveUncertainPublish, {
      jobId,
      outcome: "PUBLISHED",
      evidenceUrl: "https://evil.example/post/1",
    })).rejects.toThrow(/올바른 게시물 HTTPS URL/);
    await user.as.mutation(api.jobs.resolveUncertainPublish, {
      jobId,
      outcome: "PUBLISHED",
      evidenceUrl: "https://www.threads.net/@confirmed_shop/post/C123",
    });
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "FAILED",
      publishPhase: "CONFIRMED",
      manualPublishResolution: { outcome: "PUBLISHED", evidenceUrl: "https://www.threads.net/@confirmed_shop/post/C123" },
    });
    expect(await t.run(async (ctx) => (await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", jobId)).unique())?.state)).toBe("COMMITTED");
    await t.finishAllScheduledFunctions(() => {});
    expect(await t.run(async (ctx) => (await ctx.db.query("postMetrics").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect()).length)).toBe(1);
    await expect(user.as.mutation(api.jobs.resolveUncertainPublish, { jobId, outcome: "NOT_PUBLISHED" })).rejects.toThrow(/결과 미확인 상태/);
  });

  it("rejects a canonical-looking receipt that belongs to another account", async () => {
    const t = makeT();
    const user = await signup(t, "receipt-owner@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "X", name: "영수증", handle: "receipt_owner" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "receipt_owner" } }) }));
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "계정 귀속 확인", mediaUrls: [], requireApproval: false });
    await approveLive(user, jobId);
    const claimed = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    await t.fetch(`/agent/jobs/${jobId}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(claimed) }));
    expect((await markPublishAttempt(t, deviceToken, jobId, claimed)).status).toBe(200);
    const completion = await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({
      ...claimed,
      status: "SUCCEEDED",
      result: { schema: "automoney.job-result/v1", kind: "ok", data: { postUrl: "https://x.com/other_account/status/999" } },
    }) }));
    expect(await completion.json()).toMatchObject({ data: { receiptUncertain: true } });
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({ status: "FAILED", publishPhase: "UNCERTAIN", errorCode: "PUBLISH_RECEIPT_MISSING" });
    expect(await t.run(async (ctx) => (await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", jobId)).unique())?.state)).toBe("UNCERTAIN");
  });

  it("keeps the reservation uncertain when cancellation arrives after publish intent", async () => {
    const t = makeT();
    const user = await signup(t, "cancel-after-intent@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "X", name: "취소 경합", handle: "cancel_race" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "cancel_race" } }) }));
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "취소 경합", mediaUrls: [], requireApproval: false });
    await approveLive(user, jobId);
    const claimed = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    await t.fetch(`/agent/jobs/${jobId}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(claimed) }));
    await user.as.mutation(api.jobs.cancel, { jobId });
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ ...claimed, status: "FAILED", errorCode: "JOB_CANCELLED" }) }));
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({ status: "FAILED", publishPhase: "UNCERTAIN", errorCode: "PUBLISH_RESULT_UNCERTAIN" });
    expect(await t.run(async (ctx) => (await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", jobId)).unique())?.state)).toBe("UNCERTAIN");
  });

  it("releases the account reservation after the owner confirms an uncertain publish did not post", async () => {
    const t = makeT();
    const user = await signup(t, "publish-not-posted@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "X", name: "미게시 확인", handle: "not_posted" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "not_posted" } }) }));
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "게시되지 않은 작업", mediaUrls: [], requireApproval: false });
    await approveLive(user, jobId);
    const claimed = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data as { attemptNo: number; leaseToken: string };
    await t.fetch(`/agent/jobs/${jobId}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(claimed) }));
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ ...claimed, status: "FAILED", errorCode: "PUBLISH_RESULT_UNCERTAIN" }) }));

    const resolution = await user.as.mutation(api.jobs.resolveUncertainPublish, { jobId, outcome: "NOT_PUBLISHED" });
    expect(resolution.releaseAt).toBeGreaterThan(Date.now());
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "FAILED",
      publishPhase: "NOT_PUBLISHED",
      manualPublishResolution: { outcome: "NOT_PUBLISHED" },
    });
    expect(await t.run(async (ctx) => (await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", jobId)).unique())?.state)).toBe("UNCERTAIN");
    expect(await t.run(async (ctx) => (await ctx.db.query("postMetrics").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect()).length)).toBe(0);
    const reservation = await t.run(async (ctx) => ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", jobId)).unique());
    await t.run(async (ctx) => ctx.db.patch(reservation!._id, { expiresAt: Date.now() - 1 }));
    await t.mutation(internal.jobs.releaseNotPublishedReservation, { reservationId: reservation!._id, jobId });
    expect(await t.run(async (ctx) => (await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", jobId)).unique())?.state)).toBe("RELEASED");
  });

  it("sweeps expired leases: preflight-free publish jobs fail safely, others requeue", async () => {
    const t = makeT();
    const user = await signup(t, "d4@test.com");
    const { deviceToken, deviceId } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "s" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.run(async (ctx) => {
      // Optional lease fields from legacy/incomplete rows must be ordered as expired
      // by the compound index rather than becoming permanently RUNNING.
      await ctx.db.patch(createJob, { leaseUntil: undefined });
    });
    const r1 = await t.mutation(internal.jobs.sweep, {});
    expect(r1).toEqual({ requeued: 1, lost: 0, exhausted: 0, timedOut: 0, expired: 0 });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "x_shop" } }) }));
    const pub = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "hello", mediaUrls: [] });
    await user.as.mutation(api.jobs.approve, { jobId: pub });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.run(async (ctx) => {
      await ctx.db.patch(pub, { leaseUntil: Date.now() - 1 });
    });
    const r2 = await t.mutation(internal.jobs.sweep, {});
    expect(r2).toEqual({ requeued: 0, lost: 1, exhausted: 0, timedOut: 0, expired: 0 });
    const jobs = await user.as.query(api.jobs.listMine, {});
    expect(jobs.find((j) => j._id === pub)?.errorCode).toBe("AGENT_LOST_BEFORE_PUBLISH");
    const spaces = await user.as.query(api.spaces.listMine, {});
    expect(spaces[0]?.locked).toBe(false);
    void deviceId;
  });

  it("terminally fails content generation after three expired leases and refreshes its run", async () => {
    const t = makeT();
    const user = await signup(t, "content-retry-exhausted@test.com");
    const { deviceToken } = await pairDevice(t, user, "0.1.11");
    const productId = await seedProduct(t, 200001);
    const requested = await user.as.mutation(api.content.requestGenerateBatch, { productIds: [productId], channels: ["THREADS"] });
    const jobId = requested.jobIds[0]!;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
      expect(claimed).toMatchObject({ id: jobId, attemptNo: attempt });
      await t.run(async (ctx) => ctx.db.patch(jobId, { leaseUntil: Date.now() - 1 }));
      const swept = await t.mutation(internal.jobs.sweep, {});
      if (attempt < 3) {
        expect(swept).toMatchObject({ requeued: 1, lost: 0, exhausted: 0, timedOut: 0, expired: 0 });
        expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({ status: "QUEUED" });
      } else {
        expect(swept).toMatchObject({ requeued: 0, lost: 0, exhausted: 1, timedOut: 0, expired: 0 });
      }
    }

    await t.finishAllScheduledFunctions(() => {});
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "FAILED",
      attemptNo: 3,
      errorCode: "EXECUTION_RETRY_EXHAUSTED",
    });
    expect(await user.as.query(api.content.getRun, { runId: requested.runId })).toMatchObject({
      status: "FAILED",
      completedJobs: 1,
      savedOutputs: 0,
    });
  });

  it("terminally fails 24-hour stale queued content generation and refreshes its run", async () => {
    const t = makeT();
    const user = await signup(t, "content-queue-timeout@test.com");
    await pairDevice(t, user, "0.1.11");
    const productId = await seedProduct(t, 200002);
    const requested = await user.as.mutation(api.content.requestGenerateBatch, { productIds: [productId], channels: ["X"] });
    const jobId = requested.jobIds[0]!;
    await t.run(async (ctx) => ctx.db.patch(jobId, { createdAt: Date.now() - 24 * 60 * 60_000 - 1 }));

    expect(await t.mutation(internal.jobs.sweep, {})).toMatchObject({
      requeued: 0,
      lost: 0,
      exhausted: 0,
      timedOut: 1,
      expired: 0,
    });
    await t.finishAllScheduledFunctions(() => {});
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({ status: "FAILED", errorCode: "DEVICE_OFFLINE_TIMEOUT" });
    expect(await user.as.query(api.content.getRun, { runId: requested.runId })).toMatchObject({
      status: "FAILED",
      completedJobs: 1,
      savedOutputs: 0,
    });
  });

  it("binds an approved live publish to the verified external account identity", async () => {
    const t = makeT();
    const user = await signup(t, "identity-snapshot@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "X", name: "identity" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "account_a" } }) }));
    const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "A 계정 승인 본문", mediaUrls: [], requireApproval: true });
    await user.as.mutation(api.jobs.approve, { jobId });
    await t.run((ctx) => ctx.db.patch(spaceId, { handle: "account_b" }));
    const claim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data;
    expect(claim.id).toBe(jobId);
    const preflight = await t.fetch(`/agent/jobs/${jobId}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify({ attemptNo: claim.attemptNo, leaseToken: claim.leaseToken }) }));
    expect(preflight.status).toBe(409);
    expect((await preflight.json()).error.code).toBe("TARGET_IDENTITY_CHANGED");
  });
});

describe("schedules", () => {
  it("allows the generated job of a consumed one-shot schedule to pass preflight", async () => {
    const t = makeT();
    const user = await signup(t, "schedule-one-shot@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "일회 예약" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "one_shot" } }) }));
    const futureKst = new Date(Date.now() + 9 * 3600_000 + 24 * 3600_000);
    const runDate = futureKst.toISOString().slice(0, 10);
    const timeOfDay = `${String(futureKst.getUTCHours()).padStart(2, "0")}:${String(futureKst.getUTCMinutes()).padStart(2, "0")}`;
    const schedule = await user.as.mutation(api.schedules.upsert, {
      spaceId,
      kind: "ONE_SHOT",
      runDate,
      timeOfDay,
      daysOfWeek: [],
      jitterMinutes: 0,
      text: "한 번만 게시",
      mediaUrls: [],
      autoApprove: false,
    });
    await t.run((ctx) => ctx.db.patch(schedule.scheduleId, { runDate: "2000-01-01", nextRunAt: Date.now() - 1 }));
    expect(await t.mutation(internal.schedules.tick, { now: Date.now() })).toMatchObject({ created: 1 });
    const consumed = await t.run((ctx) => ctx.db.get(schedule.scheduleId));
    expect(consumed?.enabled).toBe(false);
    expect(consumed?.nextRunAt).toBeUndefined();
    const jobId = consumed!.lastJobId!;
    await user.as.mutation(api.jobs.approve, { jobId });
    const claim = (await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json()).data as { id: Id<"agentJobs">; attemptNo: number; leaseToken: string };
    expect(claim.id).toBe(jobId);
    expect((await t.fetch(`/agent/jobs/${jobId}/preflight`, authed(deviceToken, { method: "POST", body: JSON.stringify(claim) }))).status).toBe(200);
    expect((await markPublishAttempt(t, deviceToken, jobId, claim)).status).toBe(200);
  });

  it("pauses on account changes and cancels queued occurrences when the schedule revision changes", async () => {
    const t = makeT();
    const user = await signup(t, "schedule-identity@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "예약 계정" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "schedule_a" } }) }));
    const timeOfDay = "10:00";
    const first = await user.as.mutation(api.schedules.upsert, { spaceId, kind: "DAILY", timeOfDay, daysOfWeek: [], jitterMinutes: 0, text: "계정 고정", mediaUrls: [], autoApprove: true });
    expect(await t.run((ctx) => ctx.db.get(first.scheduleId))).toMatchObject({ autoApprove: false });
    await t.run((ctx) => ctx.db.patch(spaceId, { handle: "schedule_b" }));
    expect(await t.mutation(internal.schedules.tick, { now: first.nextRunAt! + 1 })).toMatchObject({ created: 0, skipped: 1 });
    expect((await user.as.query(api.schedules.listMine, {})).find((row) => row._id === first.scheduleId)).toMatchObject({ enabled: false, lastSkipReason: "TARGET_IDENTITY_CHANGED" });

    await t.run((ctx) => ctx.db.patch(spaceId, { handle: "schedule_a" }));
    const second = await user.as.mutation(api.schedules.upsert, { spaceId, kind: "DAILY", timeOfDay, daysOfWeek: [], jitterMinutes: 0, text: "revision 고정", mediaUrls: [], autoApprove: true });
    expect(await t.mutation(internal.schedules.tick, { now: second.nextRunAt! + 1 })).toMatchObject({ created: 1 });
    const scheduledJob = (await user.as.query(api.jobs.listMine, {})).find((job) => job.source === "SCHEDULE" && job.status === "NEEDS_APPROVAL")!;
    await user.as.mutation(api.schedules.setEnabled, { id: second.scheduleId, enabled: false });
    expect(await t.run((ctx) => ctx.db.get(scheduledJob._id))).toMatchObject({ status: "CANCELLED", errorCode: "JOB_CANCELLED" });
  });

  it("rejects cross-user, deleted, and suspended-user schedule updates without changing the target", async () => {
    const t = makeT();
    const owner = await signup(t, "schedule-owner@test.com");
    const attacker = await signup(t, "schedule-attacker@test.com");
    await pairDevice(t, owner);
    await pairDevice(t, attacker);
    const ownerSpace = await owner.as.mutation(api.spaces.create, { platform: "THREADS", name: "owner" });
    const attackerSpace = await attacker.as.mutation(api.spaces.create, { platform: "THREADS", name: "attacker" });
    await t.run(async (ctx) => {
      await ctx.db.patch(ownerSpace.spaceId, { sessionState: "HEALTHY", handle: "owner_shop" });
      await ctx.db.patch(attackerSpace.spaceId, { sessionState: "HEALTHY", handle: "attacker_shop" });
    });
    const original = {
      spaceId: ownerSpace.spaceId,
      kind: "DAILY" as const,
      timeOfDay: "10:00",
      daysOfWeek: [],
      jitterMinutes: 0,
      text: "소유자 예약",
      mediaUrls: [],
      autoApprove: false,
    };
    const { scheduleId } = await owner.as.mutation(api.schedules.upsert, original);

    await expect(
      attacker.as.mutation(api.schedules.upsert, { ...original, id: scheduleId, spaceId: attackerSpace.spaceId, text: "탈취 시도" }),
    ).rejects.toThrow(/예약을 찾을 수 없습니다/);
    expect((await owner.as.query(api.schedules.listMine, {}))[0]?.text).toBe("소유자 예약");

    await owner.as.mutation(api.schedules.remove, { id: scheduleId });
    await expect(owner.as.mutation(api.schedules.upsert, { ...original, id: scheduleId })).rejects.toThrow(/예약을 찾을 수 없습니다/);

    const recreated = await owner.as.mutation(api.schedules.upsert, original);
    await t.run((ctx) => ctx.db.patch(owner.userId, { status: "SUSPENDED" }));
    await expect(owner.as.mutation(api.schedules.upsert, { ...original, id: recreated.scheduleId, text: "정지 후 수정" })).rejects.toThrow(/정지된 계정/);
    const stored = await t.run((ctx) => ctx.db.get(recreated.scheduleId));
    expect(stored?.text).toBe("소유자 예약");
  });

  it("creates jobs when due, respects daily limit and approval, recomputes next run", async () => {
    const t = makeT();
    const user = await signup(t, "s1@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "sch" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "schedule_shop" } }) }));
    await user.as.mutation(api.spaces.setDailyLimit, { spaceId, dailyPostLimit: 1 });

    // 오늘 안에 도래하도록 현재 KST 시각 + 2분 슬롯
    const kst = new Date(Date.now() + 9 * 3600_000 + 2 * 60_000);
    const timeOfDay = `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;
    const { scheduleId, nextRunAt } = await user.as.mutation(api.schedules.upsert, { spaceId, kind: "DAILY", timeOfDay, daysOfWeek: [], jitterMinutes: 0, text: "매일 아침 코디", mediaUrls: [], autoApprove: false });
    expect(nextRunAt).toBeGreaterThan(Date.now());
    // 아직 도래 전 → 생성 없음
    expect((await t.mutation(internal.schedules.tick, {})).created).toBe(0);
    // 오늘 수동 발행 1건 → 일일 한도(1) 도달 → 예약 슬롯은 스킵
    await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "수동 게시", mediaUrls: [] });
    const skippedTick = await t.mutation(internal.schedules.tick, { now: nextRunAt! + 1000 });
    expect(skippedTick).toMatchObject({ created: 0, skipped: 1 });
    let list = await user.as.query(api.schedules.listMine, {});
    expect(list[0]?.nextRunAt).toBeGreaterThan(nextRunAt!);
    expect(list[0]?.lastSkipReason).toBe("DAILY_POST_LIMIT");
    expect(list[0]?.lastSkippedAt).toBe(nextRunAt! + 1000);
    // 한도를 올리고 다음 슬롯(내일) 실행 → 승인 대기 잡 생성
    await user.as.mutation(api.spaces.setDailyLimit, { spaceId, dailyPostLimit: 3 });
    const r = await t.mutation(internal.schedules.tick, { now: list[0]!.nextRunAt! + 1000 });
    expect(r.created).toBe(1);
    const jobs = await user.as.query(api.jobs.listMine, {});
    const scheduled = jobs.find((j) => j.source === "SCHEDULE")!;
    expect(scheduled.status).toBe("NEEDS_APPROVAL");
    list = await user.as.query(api.schedules.listMine, {});
    expect(list[0]?.lastRunAt).toBe(r.created ? list[0]!.lastRunAt : null);
    expect(list[0]?.lastSkipReason).toBeUndefined();
    expect(list[0]?.lastSkippedAt).toBeUndefined();
    await user.as.mutation(api.schedules.setEnabled, { id: scheduleId, enabled: false });
    expect((await user.as.query(api.schedules.listMine, {}))[0]?.nextRunAt).toBeNull();
  });

  it("drains an overdue schedule backlog in bounded batches", async () => {
    const t = makeT();
    const user = await signup(t, "schedule-batch@test.com");
    await pairDevice(t, user);
    const { spaceId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "대량 예약", handle: "schedule_batch" });
    await t.run((ctx) => ctx.db.patch(spaceId, { sessionState: "HEALTHY", handle: "schedule_batch", lockJobId: undefined, dailyPostLimit: 100 }));
    const base = await user.as.mutation(api.schedules.upsert, {
      spaceId,
      kind: "DAILY",
      timeOfDay: "10:00",
      daysOfWeek: [],
      jitterMinutes: 0,
      text: "배치 예약",
      mediaUrls: [],
      autoApprove: false,
    });
    const dueAt = Date.now() - 60_000;
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(base.scheduleId))!;
      await ctx.db.patch(row._id, { nextRunAt: dueAt });
      const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...fields } = row;
      void _ignoredId;
      void _ignoredCreationTime;
      for (let index = 0; index < 25; index++) {
        await ctx.db.insert("schedules", { ...fields, nextRunAt: dueAt + index + 1 });
      }
    });

    const result = await t.mutation(internal.schedules.tick, { now: Date.now() });
    expect(result).toMatchObject({ processed: 25, batchLimited: true });
    const stillDue = await t.run((ctx) => ctx.db.query("schedules")
      .withIndex("by_enabled_next", (q) => q.eq("enabled", true).lte("nextRunAt", Date.now()))
      .collect());
    expect(stillDue).toHaveLength(1);
  });

  it("isolates a malformed legacy Instagram schedule from valid due rows", async () => {
    const t = makeT();
    const user = await signup(t, "schedule-legacy-isolation@test.com");
    await pairDevice(t, user);
    const instagram = await user.as.mutation(api.spaces.create, { platform: "INSTAGRAM", name: "구형 인스타", handle: "legacy_ig" });
    const threads = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "정상 스레드", handle: "valid_threads" });
    await t.run(async (ctx) => {
      await ctx.db.patch(instagram.spaceId, { sessionState: "HEALTHY", handle: "legacy_ig", lockJobId: undefined });
      await ctx.db.patch(threads.spaceId, { sessionState: "HEALTHY", handle: "valid_threads", lockJobId: undefined });
    });
    const legacy = await user.as.mutation(api.schedules.upsert, {
      spaceId: instagram.spaceId,
      kind: "DAILY",
      timeOfDay: "10:00",
      daysOfWeek: [],
      jitterMinutes: 0,
      contentChannel: "INSTAGRAM_FEED",
      text: "구형 인스타 예약",
      mediaUrls: ["https://cdn.example.com/legacy.jpg"],
      autoApprove: false,
    });
    const valid = await user.as.mutation(api.schedules.upsert, {
      spaceId: threads.spaceId,
      kind: "DAILY",
      timeOfDay: "10:00",
      daysOfWeek: [],
      jitterMinutes: 0,
      text: "정상 예약",
      mediaUrls: [],
      autoApprove: false,
    });
    const dueAt = Date.now() - 60_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(legacy.scheduleId, { contentChannel: undefined, nextRunAt: dueAt });
      await ctx.db.patch(valid.scheduleId, { nextRunAt: dueAt + 1 });
    });

    expect(await t.mutation(internal.schedules.tick, { now: Date.now() })).toMatchObject({ created: 1, skipped: 1 });
    expect(await t.run((ctx) => ctx.db.get(legacy.scheduleId))).toMatchObject({ enabled: false, lastSkipReason: "CONTENT_CHANNEL_REVIEW_REQUIRED" });
    expect((await user.as.query(api.jobs.listMine, {})).filter((job) => job.source === "SCHEDULE")).toHaveLength(1);
  });
});

describe("telegram", () => {
  let nextUpdateId = 10_000;
  const tg = (chatId: string, text: string, updateId = nextUpdateId++) => ({ update: { update_id: updateId, message: { chat: { id: chatId }, text } } });

  it("binds with a code, answers commands, and creates approval-gated posts", async () => {
    const t = makeT();
    const user = await signup(t, "t1@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "메인" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "telegram_shop" } }) }));

    const unbound = await t.mutation(internal.telegram.processUpdate, tg("100", "/status"));
    expect(unbound.messages[0]?.text).toMatch(/연결/);
    const { code } = await user.as.mutation(api.telegram.createBindCode, {});
    const bound = await t.mutation(internal.telegram.processUpdate, tg("100", `/start ${code}`));
    expect(bound.messages[0]?.text).toMatch(/연결되었습니다/);
    expect((await user.as.query(api.telegram.getMine, {})).bound).toBe(true);
    const bad = await t.mutation(internal.telegram.processUpdate, tg("200", `/start ${code}`));
    expect(bad.messages[0]?.text).toMatch(/만료|올바르지/);

    const status = await t.mutation(internal.telegram.processUpdate, tg("100", "/status"));
    expect(status.messages[0]?.text).toContain("메인");
    const earnings = await t.mutation(internal.telegram.processUpdate, tg("100", "/earnings"));
    expect(earnings.messages[0]?.text).toMatch(/예상 수당/);

    const postUpdate = tg("100", "/post 메인 오늘의 코디 추천", 20_001);
    const post = await t.mutation(internal.telegram.processUpdate, postUpdate);
    expect(await t.mutation(internal.telegram.processUpdate, postUpdate)).toEqual({ ...post, replayed: true });
    expect(post.messages[0]?.keyboard?.[0]?.[0]?.callback_data).toMatch(/^job:approve:/);
    let jobs = await user.as.query(api.jobs.listMine, {});
    const telegramJobs = jobs.filter((j) => j.source === "TELEGRAM");
    expect(telegramJobs).toHaveLength(1);
    const posted = telegramJobs[0]!;
    expect(posted.status).toBe("NEEDS_APPROVAL");
    expect(await t.run(async (ctx) => (await ctx.db.get(posted._id))?.requestKey)).toBe("telegram:update:20001");
    const callbackUpdate = { update: { update_id: 20_002, callback_query: { id: "cb1", data: `job:approve:${posted._id}`, message: { chat: { id: "100" } } } } };
    const cb = await t.mutation(internal.telegram.processUpdate, callbackUpdate);
    expect(await t.mutation(internal.telegram.processUpdate, callbackUpdate)).toEqual({ ...cb, replayed: true });
    expect(cb.answerText).toBe("승인됨");
    jobs = await user.as.query(api.jobs.listMine, {});
    expect(jobs.find((j) => j._id === posted._id)?.status).toBe("QUEUED");
    const approved = await t.run(async (ctx) => ctx.db.get(posted._id));
    expect(approved?.approval).toMatchObject({ actorUserId: user.userId, payloadHash: approved?.payloadHash });
    expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((event) => event.action === "job.approve" && event.metadata?.jobId === posted._id)).toHaveLength(1);
    void spaceId;
  });

  it("webhook requires the secret header and logs outbox when no bot token", async () => {
    const t = makeT();
    process.env.TELEGRAM_WEBHOOK_SECRET = "wh-secret";
    delete process.env.TELEGRAM_BOT_TOKEN;
    const denied = await t.fetch("/telegram/webhook", { method: "POST", body: JSON.stringify(tg("1", "/help").update) });
    expect(denied.status).toBe(403);
    const missingUpdateId = await t.fetch("/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wh-secret" }, body: JSON.stringify({ message: { chat: { id: "1" }, text: "/help" } }) });
    expect(missingUpdateId.status).toBe(400);
    const ok = await t.fetch("/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wh-secret" }, body: JSON.stringify(tg("1", "/help").update) });
    expect(ok.status).toBe(200);
    const outbox = await t.run((ctx) => ctx.db.query("telegramOutbox").collect());
    expect(outbox[0]?.status).toBe("SKIPPED_NO_TOKEN");
  });

  it("deduplicates a retried /post webhook by Telegram update_id", async () => {
    const t = makeT();
    const user = await signup(t, "telegram-retry@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { jobId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "재시도" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY", handle: "telegram_retry" } }) }));
    const { code } = await user.as.mutation(api.telegram.createBindCode, {});
    await t.mutation(internal.telegram.processUpdate, tg("300", `/start ${code}`, 30_000));

    process.env.TELEGRAM_WEBHOOK_SECRET = "wh-secret-retry";
    delete process.env.TELEGRAM_BOT_TOKEN;
    const update = tg("300", "/post 재시도 동일 본문", 30_001).update;
    const request = () => t.fetch("/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wh-secret-retry", "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    expect((await request()).status).toBe(200);
    const firstDeliveries = await t.run((ctx) => ctx.db.query("telegramOutbox").collect());
    const firstDeliveryCount = firstDeliveries.filter((entry) => entry.chatId === "300" && entry.text.includes("동일 본문")).length;
    expect(firstDeliveryCount).toBeGreaterThan(0);
    expect((await request()).status).toBe(200);

    const jobs = (await user.as.query(api.jobs.listMine, {})).filter((candidate) => candidate.source === "TELEGRAM");
    expect(jobs).toHaveLength(1);
    expect(await t.run(async (ctx) => (await ctx.db.get(jobs[0]!._id))?.requestKey)).toBe("telegram:update:30001");
    expect(await t.run((ctx) => ctx.db.query("telegramUpdates").withIndex("by_updateId", (q) => q.eq("updateId", 30_001)).collect())).toHaveLength(1);
    const duplicateDeliveries = await t.run((ctx) => ctx.db.query("telegramOutbox").collect());
    const duplicateDeliveryCount = duplicateDeliveries.filter((entry) => entry.chatId === "300" && entry.text.includes("동일 본문")).length;
    expect(duplicateDeliveryCount).toBe(firstDeliveryCount);
  });
});
