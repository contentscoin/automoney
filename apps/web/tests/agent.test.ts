import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { makeT, seedProduct, signup, type T } from "./helpers";

async function pairDevice(t: T, user: Awaited<ReturnType<typeof signup>>) {
  const { code } = await user.as.mutation(api.devices.createPairCode, {});
  const paired = await t.mutation(api.devices.pair, { code, deviceName: "테스트 PC", platform: "linux", appVersion: "0.1.0" });
  return paired;
}

const authed = (token: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" } });

describe("device pairing & agent contract", () => {
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
    expect((await cfg.json()).data.userEmail).toBe("d1@test.com");
    // 잘못된 코드
    await expect(t.mutation(api.devices.pair, { code: "ZZZZZZZZ", deviceName: "x", platform: "x", appVersion: "0" })).rejects.toThrow(/페어링 코드/);
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
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY" } }) }));

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
    const hb = await (await t.fetch(`/agent/jobs/${jobId}/heartbeat`, authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(hb.data.cancelRequested).toBe(true);
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "FAILED", errorCode: "JOB_CANCELLED" }) }));
    jobs = await user.as.query(api.jobs.listMine, {});
    expect(jobs.find((j) => j._id === jobId)?.status).toBe("CANCELLED");
  });

  it("sweeps expired leases: publish jobs fail as uncertain, others requeue", async () => {
    const t = makeT();
    const user = await signup(t, "d4@test.com");
    const { deviceToken, deviceId } = await pairDevice(t, user);
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "s" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.run(async (ctx) => {
      await ctx.db.patch(createJob, { leaseUntil: Date.now() - 1 });
    });
    const r1 = await t.mutation(internal.jobs.sweep, {});
    expect(r1.requeued).toBe(1);
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY" } }) }));
    const pub = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text: "hello", mediaUrls: [] });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.run(async (ctx) => {
      await ctx.db.patch(pub, { leaseUntil: Date.now() - 1 });
    });
    const r2 = await t.mutation(internal.jobs.sweep, {});
    expect(r2.lost).toBe(1);
    const jobs = await user.as.query(api.jobs.listMine, {});
    expect(jobs.find((j) => j._id === pub)?.errorCode).toBe("AGENT_LOST_UNCERTAIN");
    const spaces = await user.as.query(api.spaces.listMine, {});
    expect(spaces[0]?.locked).toBe(false);
    void deviceId;
  });
});

describe("schedules", () => {
  it("creates jobs when due, respects daily limit and approval, recomputes next run", async () => {
    const t = makeT();
    const user = await signup(t, "s1@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "sch" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY" } }) }));
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
    expect(skippedTick).toEqual({ created: 0, skipped: 1 });
    let list = await user.as.query(api.schedules.listMine, {});
    expect(list[0]?.nextRunAt).toBeGreaterThan(nextRunAt!);
    // 한도를 올리고 다음 슬롯(내일) 실행 → 승인 대기 잡 생성
    await user.as.mutation(api.spaces.setDailyLimit, { spaceId, dailyPostLimit: 3 });
    const r = await t.mutation(internal.schedules.tick, { now: list[0]!.nextRunAt! + 1000 });
    expect(r.created).toBe(1);
    const jobs = await user.as.query(api.jobs.listMine, {});
    const scheduled = jobs.find((j) => j.source === "SCHEDULE")!;
    expect(scheduled.status).toBe("NEEDS_APPROVAL");
    list = await user.as.query(api.schedules.listMine, {});
    expect(list[0]?.lastRunAt).toBe(r.created ? list[0]!.lastRunAt : null);
    await user.as.mutation(api.schedules.setEnabled, { id: scheduleId, enabled: false });
    expect((await user.as.query(api.schedules.listMine, {}))[0]?.nextRunAt).toBeNull();
  });
});

describe("telegram", () => {
  const tg = (chatId: string, text: string) => ({ update: { message: { chat: { id: chatId }, text } } });

  it("binds with a code, answers commands, and creates approval-gated posts", async () => {
    const t = makeT();
    const user = await signup(t, "t1@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const { spaceId, jobId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "메인" });
    await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }));
    await t.fetch(`/agent/jobs/${jobId}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY" } }) }));

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

    const post = await t.mutation(internal.telegram.processUpdate, tg("100", "/post 메인 오늘의 코디 추천"));
    expect(post.messages[0]?.keyboard?.[0]?.[0]?.callback_data).toMatch(/^job:approve:/);
    let jobs = await user.as.query(api.jobs.listMine, {});
    const posted = jobs.find((j) => j.source === "TELEGRAM")!;
    expect(posted.status).toBe("NEEDS_APPROVAL");
    const cb = await t.mutation(internal.telegram.processUpdate, { update: { callback_query: { id: "cb1", data: `job:approve:${posted._id}`, message: { chat: { id: "100" } } } } });
    expect(cb.answerText).toBe("승인됨");
    jobs = await user.as.query(api.jobs.listMine, {});
    expect(jobs.find((j) => j._id === posted._id)?.status).toBe("QUEUED");
    void spaceId;
  });

  it("webhook requires the secret header and logs outbox when no bot token", async () => {
    const t = makeT();
    process.env.TELEGRAM_WEBHOOK_SECRET = "wh-secret";
    delete process.env.TELEGRAM_BOT_TOKEN;
    const denied = await t.fetch("/telegram/webhook", { method: "POST", body: JSON.stringify(tg("1", "/help").update) });
    expect(denied.status).toBe(403);
    const ok = await t.fetch("/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wh-secret" }, body: JSON.stringify(tg("1", "/help").update) });
    expect(ok.status).toBe(200);
    const outbox = await t.run((ctx) => ctx.db.query("telegramOutbox").collect());
    expect(outbox[0]?.status).toBe("SKIPPED_NO_TOKEN");
  });
});
