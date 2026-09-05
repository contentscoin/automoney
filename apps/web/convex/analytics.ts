import { v } from "convex/values";
import { classifyCta, classifyHook, evaluateLift, hourBucket, kstHour, playbookHint, type PublishPayload, type ReadbackPayload } from "@automoney/shared";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { decryptField } from "./lib/crypto";
import { fail } from "./lib/errors";
import { getMetaAdapter, metaTokenKey, type MetaPlatform } from "./lib/meta";
import { requireSuperAdmin, requireUser } from "./lib/rbac";
import { enqueueJob } from "./jobs";

type Window = "24h" | "72h" | "7d";
const WINDOWS: Window[] = ["24h", "72h", "7d"];
const WINDOW_MS: Record<Window, number> = { "24h": 24 * 3600_000, "72h": 72 * 3600_000, "7d": 7 * 24 * 3600_000 };
const DIMENSIONS = ["HOOK", "CTA", "HOUR"] as const;
const minSamples = () => Number(process.env.ANALYTICS_MIN_SAMPLES ?? 20);

function channelOf(platform: string, mediaUrls: string[]): string {
  if (platform === "INSTAGRAM") return mediaUrls.some((u) => /\.(mp4|mov)(\?|$)/i.test(u)) ? "INSTAGRAM_REEL" : "INSTAGRAM_FEED";
  if (platform === "NAVER_BLOG") return "BLOG";
  return platform;
}

/** post.publish 성공 시(에이전트·클라우드 공통) readback 행 생성. postUrl 없으면 무시. */
export async function recordPublishedPost(ctx: MutationCtx, job: Doc<"agentJobs">): Promise<Id<"postMetrics"> | null> {
  const data = (job.result as { data?: { postUrl?: string; externalPostId?: string; dryRun?: boolean } } | undefined)?.data;
  if (!data?.postUrl || data.dryRun) return null;
  if (await ctx.db.query("postMetrics").withIndex("by_job", (q) => q.eq("jobId", job._id)).first()) return null;
  const p = job.payload as PublishPayload & { pieceId?: string };
  const space = job.spaceId ? await ctx.db.get(job.spaceId) : null;
  const now = job.finishedAt ?? Date.now();
  let linkId: Id<"marketingLinks"> | undefined;
  if (p.linkUrl) {
    const code = p.linkUrl.split("/r/")[1];
    if (code) linkId = (await ctx.db.query("marketingLinks").withIndex("by_shortCode", (q) => q.eq("shortCode", code)).unique())?._id;
  }
  return await ctx.db.insert("postMetrics", {
    jobId: job._id,
    userId: job.userId,
    spaceId: job.spaceId,
    snsAccountId: space?.snsAccountId,
    platform: p.platform,
    channel: channelOf(p.platform, p.mediaUrls ?? []),
    postUrl: data.postUrl,
    externalPostId: data.externalPostId,
    pieceId: p.pieceId as Id<"contentPieces"> | undefined,
    linkId,
    hookType: classifyHook(p.text ?? ""),
    ctaType: classifyCta(p.text ?? ""),
    hourKst: kstHour(now),
    postedAt: now,
    snapshots: [],
    nextWindow: "24h",
    nextWindowAt: now + WINDOW_MS["24h"],
    done: false,
  });
}

export async function latestMetricsForJob(ctx: QueryCtx | MutationCtx, jobId: Id<"agentJobs">) {
  const m = await ctx.db.query("postMetrics").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
  if (!m) return null;
  const last = m.snapshots[m.snapshots.length - 1] ?? null;
  return { postedAt: m.postedAt, channel: m.channel, hookType: m.hookType, ctaType: m.ctaType, latest: last, snapshots: m.snapshots.length, done: m.done, nextWindow: m.nextWindow ?? null };
}

/** 원장 결합: 게시 이후 창 끝까지의 링크 클릭·주문·매출 */
async function ledgerFor(ctx: MutationCtx, m: Doc<"postMetrics">, until: number) {
  if (!m.linkId) return { clicks: 0, orders: 0, sales: 0 };
  const clicks = (await ctx.db.query("clickEvents").withIndex("by_link", (q) => q.eq("linkId", m.linkId!).gte("clickedAt", m.postedAt).lte("clickedAt", until)).collect()).length;
  const orders = (await ctx.db.query("orders").withIndex("by_user", (q) => q.eq("userId", m.userId).gte("orderedAt", m.postedAt).lte("orderedAt", until)).collect()).filter((o) => o.linkId === m.linkId && o.status !== "CANCELLED");
  return { clicks, orders: orders.length, sales: orders.reduce((a, o) => a + o.orderAmount, 0) };
}

/** 창 확정: 스냅샷 추가 → 다음 창 예약 → 7d 이면 실험 원장 갱신 */
export async function finalizeWindow(ctx: MutationCtx, metricsId: Id<"postMetrics">, window: Window, source: "META_API" | "BROWSER" | "LEDGER", engagement: { impressions?: number; reach?: number; likes?: number; comments?: number; saves?: number; shares?: number }, now = Date.now()) {
  const m = await ctx.db.get(metricsId);
  if (!m || m.done || m.nextWindow !== window) return;
  // 원장은 창 경계(게시 + 24h/72h/7d)까지로 고정해 처리 시점과 무관하게 재현 가능
  const ledger = await ledgerFor(ctx, m, m.postedAt + WINDOW_MS[window]);
  const snapshots = [...m.snapshots, { window, at: now, source, ...engagement, ...ledger }];
  const idx = WINDOWS.indexOf(window);
  const next = WINDOWS[idx + 1];
  await ctx.db.patch(m._id, { snapshots, nextWindow: next, nextWindowAt: next ? m.postedAt + WINDOW_MS[next] : undefined, pendingJobId: undefined, done: !next });
  if (!next) await updateExperiments(ctx, { ...m, snapshots });
}

async function updateExperiments(ctx: MutationCtx, m: Doc<"postMetrics">) {
  const final = m.snapshots[m.snapshots.length - 1]!;
  const engagement = (final.likes ?? 0) + (final.comments ?? 0) * 2 + (final.saves ?? 0) * 2 + (final.shares ?? 0) * 3;
  const variants: Record<(typeof DIMENSIONS)[number], string> = { HOOK: m.hookType, CTA: m.ctaType, HOUR: hourBucket(m.hourKst) };
  for (const scope of ["USER", "GLOBAL"] as const) {
    const userId = scope === "USER" ? m.userId : undefined;
    for (const dimension of DIMENSIONS) {
      const rows = await ctx.db.query("experiments").withIndex("by_scope_user", (q) => q.eq("scope", scope).eq("userId", userId).eq("channel", m.channel)).collect();
      const row = rows.find((r) => r.dimension === dimension && r.variant === variants[dimension]);
      const patch = { samples: (row?.samples ?? 0) + 1, sumClicks: (row?.sumClicks ?? 0) + final.clicks, sumOrders: (row?.sumOrders ?? 0) + final.orders, sumSales: (row?.sumSales ?? 0) + final.sales, sumEngagement: (row?.sumEngagement ?? 0) + engagement, updatedAt: Date.now() };
      if (row) await ctx.db.patch(row._id, patch);
      else await ctx.db.insert("experiments", { scope, userId, channel: m.channel, dimension, variant: variants[dimension], status: "RUNNING", ...patch });
    }
    await evaluatePromotions(ctx, scope, userId, m.channel);
  }
}

/** 승격 판정: 변형 vs 나머지(대조군), 표본·15%·유의성. 승격 시 플레이북 규칙 갱신 */
export async function evaluatePromotions(ctx: MutationCtx, scope: "USER" | "GLOBAL", userId: Id<"users"> | undefined, channel: string) {
  const rows = await ctx.db.query("experiments").withIndex("by_scope_user", (q) => q.eq("scope", scope).eq("userId", userId).eq("channel", channel)).collect();
  const pb = await ctx.db.query("playbooks").withIndex("by_scope_user_channel", (q) => q.eq("scope", scope).eq("userId", userId).eq("channel", channel)).unique();
  const rules = [...(pb?.rules ?? [])];
  for (const dimension of DIMENSIONS) {
    const group = rows.filter((r) => r.dimension === dimension);
    for (const r of group) {
      const control = group.filter((x) => x._id !== r._id).reduce((a, x) => ({ samples: a.samples + x.samples, sum: a.sum + x.sumClicks + x.sumEngagement * 0.1 }), { samples: 0, sum: 0 });
      const verdict = evaluateLift({ samples: r.samples, sum: r.sumClicks + r.sumEngagement * 0.1 }, control, { minSamples: minSamples() });
      const i = rules.findIndex((x) => x.dimension === dimension && x.variant === r.variant);
      if (verdict.promote && r.status !== "RETIRED") {
        await ctx.db.patch(r._id, { status: "PROMOTED", lift: verdict.lift });
        const rule = { dimension, variant: r.variant, lift: verdict.lift, samples: r.samples, promotedAt: Date.now() };
        if (i >= 0) rules[i] = rule;
        else rules.push(rule);
      } else if (r.status === "PROMOTED" && verdict.reason !== "MIN_SAMPLES" && verdict.lift < 0) {
        await ctx.db.patch(r._id, { status: "RUNNING", lift: verdict.lift });
        if (i >= 0) rules.splice(i, 1);
      } else if (r.status === "RUNNING") await ctx.db.patch(r._id, { lift: verdict.lift });
    }
  }
  if (pb) await ctx.db.patch(pb._id, { rules, updatedAt: Date.now() });
  else if (rules.length) await ctx.db.insert("playbooks", { scope, userId, channel, rules, updatedAt: Date.now() });
}

/** 생성 프롬프트 힌트: 개인 플레이북 우선, 없으면 전역 */
export async function playbookHintsFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">, channels: string[]): Promise<string[]> {
  const hints: string[] = [];
  for (const channel of channels) {
    const mine = await ctx.db.query("playbooks").withIndex("by_scope_user_channel", (q) => q.eq("scope", "USER").eq("userId", userId).eq("channel", channel)).unique();
    const global = await ctx.db.query("playbooks").withIndex("by_scope_user_channel", (q) => q.eq("scope", "GLOBAL").eq("userId", undefined).eq("channel", channel)).unique();
    for (const r of [...(mine?.rules ?? []), ...(global?.rules ?? [])]) {
      const h = `[${channel}] ${playbookHint(r)}`;
      if (!hints.includes(h)) hints.push(h);
    }
  }
  return hints.slice(0, 8);
}

/** post.readback 잡 성공 → BROWSER 스냅샷 */
export async function ingestReadbackJob(ctx: MutationCtx, job: Doc<"agentJobs">) {
  const p = job.payload as ReadbackPayload;
  const data = (job.result as { data?: { metrics?: { likes?: number; comments?: number; shares?: number; views?: number; saves?: number } } } | undefined)?.data;
  const m = data?.metrics ?? {};
  await finalizeWindow(ctx, p.metricsId as Id<"postMetrics">, p.window, "BROWSER", { likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves, impressions: m.views });
}

/** 창이 도래한 게시물 처리 — META_API 는 insights 액션, BROWSER 는 데스크톱 잡, 그 외 원장만 */
export async function runTick(ctx: MutationCtx, now: number, limit = 50, onlyUserId?: Id<"users">) {
  const due = (await ctx.db.query("postMetrics").withIndex("by_due", (q) => q.eq("done", false).lte("nextWindowAt", now)).take(limit * 4)).filter((m) => !onlyUserId || m.userId === onlyUserId).slice(0, limit);
  let api = 0, browser = 0, ledger = 0;
  for (const m of due) {
    const window = m.nextWindow!;
    if (m.pendingJobId) {
      const j = await ctx.db.get(m.pendingJobId);
      if (j && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(j.status)) continue;
      if (j?.status === "SUCCEEDED") continue; // ingest 훅이 확정함
    }
    const space = m.spaceId ? await ctx.db.get(m.spaceId) : null;
    const account = m.snsAccountId ? await ctx.db.get(m.snsAccountId) : null;
    if (account?.status === "ACTIVE" && m.externalPostId) {
      await ctx.scheduler.runAfter(0, internal.analytics.fetchInsights, { metricsId: m._id, window, now });
      api++;
    } else if (space?.deviceId && space.authMode !== "META_API" && !["PAUSED", "RESTRICTED"].includes(space.sessionState) && !m.pendingJobId) {
      const payload: ReadbackPayload = { spaceId: space._id, platform: space.platform, postUrl: m.postUrl, metricsId: m._id, window };
      const jobId = await enqueueJob(ctx, { userId: m.userId, jobType: "post.readback", payload: payload as unknown as Record<string, unknown>, spaceId: space._id, source: "SYSTEM", idempotencyKey: `readback:${m._id}:${window}` });
      await ctx.db.patch(m._id, { pendingJobId: jobId });
      browser++;
    } else {
      await finalizeWindow(ctx, m._id, window, "LEDGER", {}, now);
      ledger++;
    }
  }
  return { due: due.length, api, browser, ledger };
}

/** 크론(1시간) */
export const tick = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => runTick(ctx, args.now ?? Date.now(), args.limit),
});

/** 유저: 내 게시물 지표 지금 수집(도래한 창만). `now` 는 E2E_TEST_HOOKS=1 일 때만 허용 */
export const tickNow = mutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const now = args.now !== undefined && process.env.E2E_TEST_HOOKS === "1" ? args.now : Date.now();
    return await runTick(ctx, now, 20, user._id);
  },
});

export const insightsContext = internalQuery({
  args: { metricsId: v.id("postMetrics") },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.metricsId);
    const a = m?.snsAccountId ? await ctx.db.get(m.snsAccountId) : null;
    return m && a ? { platform: a.platform, tokenEnc: a.tokenEnc, externalPostId: m.externalPostId ?? null } : null;
  },
});

export const fetchInsights = internalAction({
  args: { metricsId: v.id("postMetrics"), window: v.union(v.literal("24h"), v.literal("72h"), v.literal("7d")), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const c = await ctx.runQuery(internal.analytics.insightsContext, { metricsId: args.metricsId });
    const key = metaTokenKey();
    let engagement: Record<string, number | undefined> = {};
    let source: "META_API" | "LEDGER" = "LEDGER";
    if (c && key && c.externalPostId) {
      try {
        const token = await decryptField(key, c.tokenEnc);
        engagement = { ...(await getMetaAdapter().insights(c.platform as MetaPlatform, token, c.externalPostId)) };
        source = "META_API";
      } catch {
        source = "LEDGER";
      }
    }
    await ctx.runMutation(internal.analytics.finalizeWindowInternal, { metricsId: args.metricsId, window: args.window, source, engagement, now: args.now });
  },
});

export const finalizeWindowInternal = internalMutation({
  args: { metricsId: v.id("postMetrics"), window: v.union(v.literal("24h"), v.literal("72h"), v.literal("7d")), source: v.union(v.literal("META_API"), v.literal("BROWSER"), v.literal("LEDGER")), engagement: v.any(), now: v.optional(v.number()) },
  handler: async (ctx, args) => finalizeWindow(ctx, args.metricsId, args.window, args.source, args.engagement ?? {}, args.now),
});

// ───────────────────────────── 화면용 ─────────────────────────────

export const listMine = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const rows = await ctx.db.query("postMetrics").withIndex("by_user", (q) => q.eq("userId", user._id)).order("desc").take(Math.min(args.limit ?? 50, 200));
    const out = [];
    for (const m of rows) {
      const space = m.spaceId ? await ctx.db.get(m.spaceId) : null;
      out.push({ _id: m._id, jobId: m.jobId, platform: m.platform, channel: m.channel, spaceName: space?.name ?? null, postUrl: m.postUrl, hookType: m.hookType, ctaType: m.ctaType, hourKst: m.hourKst, hourBucket: hourBucket(m.hourKst), postedAt: m.postedAt, snapshots: m.snapshots, nextWindow: m.nextWindow ?? null, nextWindowAt: m.nextWindowAt ?? null, done: m.done });
    }
    const byDim: Record<string, Record<string, { posts: number; clicks: number; engagement: number }>> = { HOOK: {}, CTA: {}, HOUR: {} };
    for (const m of rows) {
      const last = m.snapshots[m.snapshots.length - 1];
      if (!last) continue;
      const eng = (last.likes ?? 0) + (last.comments ?? 0) + (last.saves ?? 0) + (last.shares ?? 0);
      for (const [dim, variant] of [["HOOK", m.hookType], ["CTA", m.ctaType], ["HOUR", hourBucket(m.hourKst)]] as const) {
        const cell = (byDim[dim]![variant] ??= { posts: 0, clicks: 0, engagement: 0 });
        cell.posts++;
        cell.clicks += last.clicks;
        cell.engagement += eng;
      }
    }
    const playbooks = await ctx.db.query("playbooks").withIndex("by_scope_user_channel", (q) => q.eq("scope", "USER").eq("userId", user._id)).collect();
    const global = await ctx.db.query("playbooks").withIndex("by_scope_user_channel", (q) => q.eq("scope", "GLOBAL").eq("userId", undefined)).collect();
    return { posts: out, byDim, playbooks: playbooks.map((p) => ({ channel: p.channel, rules: p.rules })), globalPlaybooks: global.map((p) => ({ channel: p.channel, rules: p.rules })), minSamples: minSamples() };
  },
});

export const superOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const experiments = await ctx.db.query("experiments").withIndex("by_scope_user", (q) => q.eq("scope", "GLOBAL").eq("userId", undefined)).collect();
    const playbooks = await ctx.db.query("playbooks").withIndex("by_scope_user_channel", (q) => q.eq("scope", "GLOBAL").eq("userId", undefined)).collect();
    const recent = await ctx.db.query("postMetrics").order("desc").take(200);
    return {
      experiments: experiments.sort((a, b) => a.channel.localeCompare(b.channel) || a.dimension.localeCompare(b.dimension) || b.samples - a.samples).map((e) => ({ _id: e._id, channel: e.channel, dimension: e.dimension, variant: e.variant, samples: e.samples, avgClicks: e.samples ? e.sumClicks / e.samples : 0, avgEngagement: e.samples ? e.sumEngagement / e.samples : 0, orders: e.sumOrders, sales: e.sumSales, status: e.status, lift: e.lift ?? null })),
      playbooks: playbooks.map((p) => ({ _id: p._id, channel: p.channel, rules: p.rules })),
      totals: { posts: recent.length, done: recent.filter((m) => m.done).length, pending: recent.filter((m) => !m.done).length, withApi: recent.filter((m) => m.snsAccountId).length },
      minSamples: minSamples(),
    };
  },
});

/** 수퍼어드민: 전역 실험 수동 승격/철회 */
export const setExperimentStatus = mutation({
  args: { experimentId: v.id("experiments"), status: v.union(v.literal("PROMOTED"), v.literal("RETIRED"), v.literal("RUNNING")) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const e = await ctx.db.get(args.experimentId);
    if (!e || e.scope !== "GLOBAL") fail("NOT_FOUND", "전역 실험만 수동 조정할 수 있습니다.");
    await ctx.db.patch(e._id, { status: args.status });
    const pb = await ctx.db.query("playbooks").withIndex("by_scope_user_channel", (q) => q.eq("scope", "GLOBAL").eq("userId", undefined).eq("channel", e.channel)).unique();
    const rules = (pb?.rules ?? []).filter((r) => !(r.dimension === e.dimension && r.variant === e.variant));
    if (args.status === "PROMOTED") rules.push({ dimension: e.dimension, variant: e.variant, lift: e.lift ?? 0, samples: e.samples, promotedAt: Date.now() });
    if (pb) await ctx.db.patch(pb._id, { rules, updatedAt: Date.now() });
    else if (rules.length) await ctx.db.insert("playbooks", { scope: "GLOBAL", channel: e.channel, rules, updatedAt: Date.now() });
    await audit(ctx, { actorUserId: actor._id, action: "analytics.experiment.status", metadata: { experimentId: e._id, status: args.status } });
  },
});

/** 텔레그램 /report 등: 최근 7일 요약 */
export async function weeklySummaryFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">, now = Date.now()) {
  const rows = await ctx.db.query("postMetrics").withIndex("by_user", (q) => q.eq("userId", userId).gte("postedAt", now - 7 * 24 * 3600_000)).collect();
  let clicks = 0, orders = 0, sales = 0, engagement = 0;
  for (const m of rows) {
    const last = m.snapshots[m.snapshots.length - 1];
    if (!last) continue;
    clicks += last.clicks;
    orders += last.orders;
    sales += last.sales;
    engagement += (last.likes ?? 0) + (last.comments ?? 0) + (last.saves ?? 0) + (last.shares ?? 0);
  }
  return { posts: rows.length, measured: rows.filter((m) => m.snapshots.length > 0).length, clicks, orders, sales, engagement };
}
