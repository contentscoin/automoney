import { v } from "convex/values";
import { PLATFORM_LIMITS } from "@automoney/shared";
import { mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireUser } from "./lib/rbac";
import { enqueueJob } from "./jobs";

const platformValidator = v.union(v.literal("THREADS"), v.literal("X"), v.literal("INSTAGRAM"), v.literal("TIKTOK"), v.literal("NAVER_BLOG"));

/** 스페이스 생성: 활성 디바이스 필요. 로컬 프로필 생성은 space.create 잡으로 에이전트가 수행. */
export const create = mutation({
  args: { platform: platformValidator, name: v.string(), handle: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const device = (await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "ACTIVE")).collect())[0];
    if (!device) fail("CONFLICT", "먼저 데스크톱 에이전트를 페어링하세요.");
    const name = args.name.trim().slice(0, 40);
    if (name.length < 1) fail("INVALID_ARGUMENT", "스페이스 이름을 입력하세요.");
    const now = Date.now();
    const spaceId = await ctx.db.insert("spaces", {
      userId: user._id,
      deviceId: device._id,
      platform: args.platform,
      name,
      handle: args.handle?.trim().replace(/^@/, "") || undefined,
      pinned: false,
      sessionState: "CREATED",
      dailyPostLimit: PLATFORM_LIMITS[args.platform].dailyDefault,
      createdAt: now,
    });
    const jobId = await enqueueJob(ctx, { userId: user._id, jobType: "space.create", payload: { spaceId, platform: args.platform, name }, spaceId, source: "WEB" });
    await audit(ctx, { actorUserId: user._id, action: "space.create", metadata: { spaceId, platform: args.platform } });
    return { spaceId, jobId };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const rows = await ctx.db.query("spaces").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        _id: s._id,
        platform: s.platform,
        name: s.name,
        handle: s.handle ?? null,
        pinned: s.pinned,
        sessionState: s.sessionState,
        dailyPostLimit: s.dailyPostLimit,
        lastCheckedAt: s.lastCheckedAt ?? null,
        lastError: s.lastError ?? null,
        locked: !!s.lockJobId,
        createdAt: s.createdAt,
      }));
  },
});

export const setPinned = mutation({
  args: { spaceId: v.id("spaces"), pinned: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.spaceId);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    await ctx.db.patch(s._id, { pinned: args.pinned });
    await audit(ctx, { actorUserId: user._id, action: "space.pin", metadata: { spaceId: s._id, pinned: args.pinned } });
  },
});

export const setPaused = mutation({
  args: { spaceId: v.id("spaces"), paused: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.spaceId);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    await ctx.db.patch(s._id, { sessionState: args.paused ? "PAUSED" : "LOGIN_REQUIRED" });
  },
});

export const setDailyLimit = mutation({
  args: { spaceId: v.id("spaces"), dailyPostLimit: v.number() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.spaceId);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    const max = PLATFORM_LIMITS[s.platform].dailyDefault * 2;
    if (!Number.isInteger(args.dailyPostLimit) || args.dailyPostLimit < 0 || args.dailyPostLimit > max) fail("INVALID_ARGUMENT", `일일 한도는 0~${max} 사이여야 합니다.`);
    await ctx.db.patch(s._id, { dailyPostLimit: args.dailyPostLimit });
  },
});

/** 로그인 창 열기 요청 → 에이전트가 사용자 PC 에서 창을 띄운다 */
export const requestLogin = mutation({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.spaceId);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    return await enqueueJob(ctx, { userId: user._id, jobType: "space.login", payload: { spaceId: s._id, platform: s.platform }, spaceId: s._id, source: "WEB", idempotencyKey: `space.login:${s._id}:${Math.floor(Date.now() / 60_000)}` });
  },
});

export const requestVerify = mutation({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.spaceId);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    return await enqueueJob(ctx, { userId: user._id, jobType: "space.verify", payload: { spaceId: s._id, platform: s.platform }, spaceId: s._id, source: "WEB", idempotencyKey: `space.verify:${s._id}:${Math.floor(Date.now() / 60_000)}` });
  },
});

export const remove = mutation({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const s = await ctx.db.get(args.spaceId);
    if (!s || s.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    if (s.pinned) fail("CONFLICT", "고정된 스페이스는 먼저 고정을 해제해야 삭제할 수 있습니다.");
    const schedules = await ctx.db.query("schedules").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    for (const sc of schedules) if (sc.spaceId === s._id) await ctx.db.patch(sc._id, { enabled: false, nextRunAt: undefined });
    await ctx.db.delete(s._id);
    await audit(ctx, { actorUserId: user._id, action: "space.remove", metadata: { spaceId: s._id } });
  },
});
