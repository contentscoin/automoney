import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { generateCode, normalizeCode, PAIR_CODE_TTL_MS } from "@automoney/shared";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { sha256Hex } from "./lib/crypto";
import { fail } from "./lib/errors";
import { requireUser } from "./lib/rbac";

const PAIR_CODE_LENGTH = 8;

/** 유저: 페어링 코드 발급 (10분 유효, 1회용). 코드는 해시만 저장. */
export const createPairCode = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const old = await ctx.db.query("pairCodes").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    for (const o of old) if (!o.usedAt) await ctx.db.delete(o._id);
    const code = generateCode(PAIR_CODE_LENGTH);
    await ctx.db.insert("pairCodes", { userId: user._id, codeHash: await sha256Hex(code), expiresAt: Date.now() + PAIR_CODE_TTL_MS });
    return { code, expiresAt: Date.now() + PAIR_CODE_TTL_MS, deepLink: `automoney://pair?code=${code}` };
  },
});

/**
 * 데스크톱: 코드로 페어링 → 디바이스 토큰 발급 (토큰은 1회만 반환, 해시만 저장).
 * 1유저 1활성 디바이스: 기존 디바이스는 REPLACED, 그 디바이스의 RUNNING 잡은 재큐잉.
 */
export const pair = mutation({
  args: { code: v.string(), deviceName: v.string(), platform: v.string(), appVersion: v.string() },
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (code.length !== PAIR_CODE_LENGTH) fail("INVALID_ARGUMENT", "페어링 코드 형식이 올바르지 않습니다.");
    const codeHash = await sha256Hex(code);
    const pc = await ctx.db.query("pairCodes").withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash)).unique();
    const now = Date.now();
    if (!pc || pc.usedAt || pc.expiresAt < now) fail("INVALID_ARGUMENT", "페어링 코드가 만료되었거나 유효하지 않습니다.");
    await ctx.db.patch(pc._id, { usedAt: now });

    const actives = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", pc.userId).eq("status", "ACTIVE")).collect();
    for (const d of actives) {
      await ctx.db.patch(d._id, { status: "REPLACED" });
      const running = await ctx.db.query("agentJobs").withIndex("by_user_status", (q) => q.eq("userId", pc.userId).eq("status", "RUNNING")).collect();
      for (const j of running) {
        if (j.claimedByDeviceId === d._id) {
          await ctx.db.patch(j._id, { status: "QUEUED", claimedByDeviceId: undefined, leaseUntil: undefined, stage: "requeued:device_replaced", updatedAt: now });
        }
      }
    }
    const rawToken = `${generateCode(20)}${generateCode(23)}`;
    const deviceId = await ctx.db.insert("devices", {
      userId: pc.userId,
      name: args.deviceName.slice(0, 60),
      platform: args.platform.slice(0, 30),
      appVersion: args.appVersion.slice(0, 30),
      tokenHash: await sha256Hex(rawToken),
      status: "ACTIVE",
      pairedAt: now,
      lastSeenAt: now,
    });
    await audit(ctx, { actorUserId: pc.userId, targetUserId: pc.userId, action: "device.pair", metadata: { deviceId, replaced: actives.length } });
    return { deviceId, deviceToken: rawToken, userId: pc.userId };
  },
});

export async function listDevicesFor(ctx: QueryCtx, user: Doc<"users">) {
  const rows = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
  return rows
    .sort((a, b) => b.pairedAt - a.pairedAt)
    .map((d) => ({
      _id: d._id,
      name: d.name,
      platform: d.platform,
      appVersion: d.appVersion,
      status: d.status,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt ?? null,
      online: d.status === "ACTIVE" && !!d.lastSeenAt && Date.now() - d.lastSeenAt < 90_000,
      snapshot: d.snapshot ?? null,
    }));
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    return await listDevicesFor(ctx, await requireUser(ctx));
  },
});

export const revoke = mutation({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const d = await ctx.db.get(args.deviceId);
    if (!d || d.userId !== user._id) fail("NOT_FOUND", "디바이스를 찾을 수 없습니다.");
    await ctx.db.patch(d._id, { status: "REVOKED" });
    const running = await ctx.db.query("agentJobs").withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "RUNNING")).collect();
    for (const j of running) if (j.claimedByDeviceId === d._id) await ctx.db.patch(j._id, { status: "QUEUED", claimedByDeviceId: undefined, leaseUntil: undefined, updatedAt: Date.now() });
    await audit(ctx, { actorUserId: user._id, action: "device.revoke", metadata: { deviceId: d._id } });
  },
});

/** 에이전트 인증: Bearer 토큰 → 활성 디바이스 + 활성 유저 */
export const authenticate = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db.query("devices").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    if (!d || d.status !== "ACTIVE") return null;
    const u = await ctx.db.get(d.userId);
    if (!u || (u.status ?? "ACTIVE") !== "ACTIVE") return null;
    return { deviceId: d._id, userId: d.userId };
  },
});

export const touch = internalMutation({
  args: { deviceId: v.id("devices"), appVersion: v.optional(v.string()), snapshot: v.optional(v.any()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deviceId, { lastSeenAt: Date.now(), ...(args.appVersion ? { appVersion: args.appVersion } : {}), ...(args.snapshot !== undefined ? { snapshot: args.snapshot } : {}) });
  },
});
