import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { makeT, seedProduct, setRole, signup, type T } from "./helpers";

const H = 3600_000;
const authed = (token: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" } });

async function pairDevice(t: T, user: Awaited<ReturnType<typeof signup>>) {
  const { code } = await user.as.mutation(api.devices.createPairCode, {});
  return await t.mutation(api.devices.pair, { code, deviceName: "PC", platform: "linux", appVersion: "0.1.0" });
}

/** 브라우저 스페이스로 게시 성공까지(에이전트 HTTP 계약 사용) */
async function publishViaAgent(t: T, user: Awaited<ReturnType<typeof signup>>, token: string, spaceId: Id<"spaces">, text: string, linkId?: Id<"marketingLinks">, postUrl = "https://x.com/e2e/status/1") {
  const jobId = await user.as.mutation(api.jobs.enqueuePublish, { spaceId, text, mediaUrls: [], linkId, requireApproval: false });
  const claimed = await (await t.fetch("/agent/claim", authed(token, { method: "POST", body: "{}" }))).json();
  expect(claimed.data?.id).toBe(jobId);
  await t.fetch(`/agent/jobs/${jobId}/complete`, authed(token, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok", data: { postUrl } } }) }));
  return jobId;
}

describe("analytics loop — readback windows, ledger join, experiments, playbook", () => {
  it("records a post, collects 24h/72h/7d via browser readback + ledger, then feeds experiments and playbook hints", async () => {
    const t = makeT();
    process.env.ANALYTICS_MIN_SAMPLES = "2";
    const user = await signup(t, "an1@test.com");
    const { deviceToken } = await pairDevice(t, user);
    const productId = await seedProduct(t, 100001);
    const linkId = await t.run(async (ctx) => ctx.db.insert("marketingLinks", { userId: user.userId, productId, trackingCode: "TRK1", shortCode: "ABCDEFG", targetUrl: "https://attrangs.co.kr/x", status: "ACTIVE", issuedAt: Date.now(), clickCount: 0 }));
    const { spaceId, jobId: createJob } = await user.as.mutation(api.spaces.create, { platform: "X", name: "x-main" });
    // space.create 처리
    await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    await t.fetch(`/agent/jobs/${createJob}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", spaceUpdate: { sessionState: "HEALTHY" } }) }));

    const jobId = await publishViaAgent(t, user, deviceToken, spaceId, "올가을 니트, 뭐 입을까요?\n\n링크에서 확인", linkId);
    const m0 = await t.run(async (ctx) => (await ctx.db.query("postMetrics").withIndex("by_job", (q) => q.eq("jobId", jobId)).unique())!);
    expect(m0).toMatchObject({ hookType: "QUESTION", ctaType: "LINK", channel: "X", nextWindow: "24h", done: false, linkId });
    const posted = m0.postedAt;
    // 원장: 게시 후 클릭 3건, 주문 1건(창 안), 클릭 1건(창 밖)
    await t.run(async (ctx) => {
      for (const dt of [1 * H, 2 * H, 20 * H, 30 * H]) await ctx.db.insert("clickEvents", { linkId, userId: user.userId, clickedAt: posted + dt });
      await ctx.db.insert("orders", { attrangsOrderId: "O-1", linkId, userId: user.userId, attribution: "DIRECT", trackingCode: "TRK1", orderedAt: posted + 5 * H, quantity: 1, orderAmount: 39000, commissionableAmount: 39000, status: "CONFIRMED", rawPayload: {}, lastEventId: "e1", updatedAt: posted + 5 * H });
    });
    // 24h 창: 브라우저 readback 잡 생성
    const t24 = posted + 24 * H + 1;
    expect(await t.mutation(internal.analytics.tick, { now: t24 })).toMatchObject({ browser: 1, api: 0, ledger: 0 });
    const rb = await t.run(async (ctx) => (await ctx.db.query("agentJobs").collect()).find((j) => j.jobType === "post.readback")!);
    expect(rb.payload).toMatchObject({ postUrl: "https://x.com/e2e/status/1", window: "24h", platform: "X" });
    // 재틱은 중복 생성하지 않음
    expect(await t.mutation(internal.analytics.tick, { now: t24 + 60_000 })).toMatchObject({ browser: 0, ledger: 0 });
    // 에이전트가 readback 완료 → BROWSER 스냅샷 + 원장 결합
    const claimed = await (await t.fetch("/agent/claim", authed(deviceToken, { method: "POST", body: "{}" }))).json();
    expect(claimed.data.id).toBe(rb._id);
    await t.fetch(`/agent/jobs/${rb._id}/complete`, authed(deviceToken, { method: "POST", body: JSON.stringify({ status: "SUCCEEDED", result: { schema: "automoney.job-result/v1", kind: "ok", data: { metrics: { likes: 12000, comments: 34, views: 45678 }, window: "24h" } } }) }));
    const m1 = await t.run(async (ctx) => (await ctx.db.get(m0._id))!);
    expect(m1.snapshots).toHaveLength(1);
    expect(m1.snapshots[0]).toMatchObject({ window: "24h", source: "BROWSER", likes: 12000, comments: 34, impressions: 45678, orders: 1, sales: 39000 });
    expect(m1.snapshots[0]!.clicks).toBeGreaterThanOrEqual(3); // 창 계산 시각 기준
    expect(m1.nextWindow).toBe("72h");
    // 72h·7d: 스페이스를 일시정지해 원장만으로 확정
    await user.as.mutation(api.spaces.setPaused, { spaceId, paused: true });
    expect(await t.mutation(internal.analytics.tick, { now: posted + 72 * H + 1 })).toMatchObject({ ledger: 1 });
    expect(await t.mutation(internal.analytics.tick, { now: posted + 7 * 24 * H + 1 })).toMatchObject({ ledger: 1 });
    const done = await t.run(async (ctx) => (await ctx.db.get(m0._id))!);
    expect(done.done).toBe(true);
    expect(done.snapshots.map((s) => s.window)).toEqual(["24h", "72h", "7d"]);
    expect(done.snapshots[2]!.clicks).toBe(4);
    // 실험 원장: USER·GLOBAL 각 3차원
    const exps = await t.run(async (ctx) => ctx.db.query("experiments").collect());
    expect(exps.filter((e) => e.scope === "USER")).toHaveLength(3);
    expect(exps.find((e) => e.scope === "GLOBAL" && e.dimension === "HOOK")!).toMatchObject({ variant: "QUESTION", samples: 1, sumClicks: 4, sumOrders: 1 });
    // 화면 쿼리
    const mine = await user.as.query(api.analytics.listMine, {});
    expect(mine.posts).toHaveLength(1);
    expect(mine.byDim.HOOK!.QUESTION).toMatchObject({ posts: 1, clicks: 4 });
    // MCP post_verify_published 에 쓰이는 최신 지표
    const { latestMetricsForJob } = await import("../convex/analytics");
    const latest = await t.run(async (ctx) => latestMetricsForJob(ctx, jobId));
    expect(latest!.latest!.window).toBe("7d");
    delete process.env.ANALYTICS_MIN_SAMPLES;
  });

  it("promotes a winning variant into the playbook and injects hints into content generation", async () => {
    const t = makeT();
    process.env.ANALYTICS_MIN_SAMPLES = "3";
    const user = await signup(t, "an2@test.com");
    await pairDevice(t, user);
    const owner = await signup(t, "owner@automoney.test");
    await setRole(t, owner.userId, "SUPER_ADMIN");
    // 실험 원장 직접 시딩: QUESTION 훅 3건 평균 10클릭 vs STATEMENT 3건 평균 2클릭
    const seed = async (scope: "USER" | "GLOBAL", variant: string, samples: number, sumClicks: number) =>
      t.run(async (ctx) => ctx.db.insert("experiments", { scope, userId: scope === "USER" ? user.userId : undefined, channel: "THREADS", dimension: "HOOK", variant, samples, sumClicks, sumOrders: 0, sumSales: 0, sumEngagement: 0, status: "RUNNING", updatedAt: Date.now() }));
    await seed("USER", "QUESTION", 3, 30);
    await seed("USER", "STATEMENT", 3, 6);
    await seed("GLOBAL", "QUESTION", 3, 30);
    await seed("GLOBAL", "STATEMENT", 3, 6);
    const { evaluatePromotions, playbookHintsFor } = await import("../convex/analytics");
    await t.run(async (ctx) => {
      await evaluatePromotions(ctx, "USER", user.userId, "THREADS");
      await evaluatePromotions(ctx, "GLOBAL", undefined, "THREADS");
    });
    const pb = await t.run(async (ctx) => ctx.db.query("playbooks").collect());
    expect(pb).toHaveLength(2);
    expect(pb[0]!.rules[0]).toMatchObject({ dimension: "HOOK", variant: "QUESTION" });
    expect(pb[0]!.rules[0]!.lift).toBeCloseTo(4, 1);
    const hints = await t.run(async (ctx) => playbookHintsFor(ctx, user.userId, ["THREADS", "X"]));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/\[THREADS\].*질문형/);
    // 생성 요청 페이로드에 힌트·거절 사유 주입
    const magazineId = await t.run(async (ctx) => ctx.db.insert("magazines", { title: "m", imageUrls: [], bodyText: "본문", attrangsProductIds: [], productIds: [], atomCount: 0, status: "ACTIVE", ingestedAt: Date.now(), createdBy: owner.userId }));
    await t.run(async (ctx) => ctx.db.insert("contentRejections", { userId: user.userId, channel: "THREADS", reason: "톤이 안 맞음", createdAt: Date.now() }));
    const jobId = await user.as.mutation(api.content.requestGenerate, { magazineId, channels: ["THREADS"] });
    const payload = (await t.run(async (ctx) => ctx.db.get(jobId)))!.payload as { playbook: string[]; avoid: string[] };
    expect(payload.playbook[0]).toMatch(/질문형/);
    expect(payload.avoid[0]).toMatch(/톤이 안 맞음/);
    // 수퍼어드민 수동 철회 → 전역 플레이북에서 제거
    const over = await owner.as.query(api.analytics.superOverview, {});
    const promoted = over.experiments.find((e) => e.status === "PROMOTED")!;
    await owner.as.mutation(api.analytics.setExperimentStatus, { experimentId: promoted._id, status: "RETIRED" });
    expect((await owner.as.query(api.analytics.superOverview, {})).playbooks.every((p) => p.rules.length === 0)).toBe(true);
    await expect(user.as.query(api.analytics.superOverview, {})).rejects.toThrow();
    delete process.env.ANALYTICS_MIN_SAMPLES;
  });
});
