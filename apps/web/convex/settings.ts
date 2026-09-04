import { v } from "convex/values";
import { DEFAULT_USER_RATE_BPS } from "@automoney/shared";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireSuperAdmin, requireUser } from "./lib/rbac";

export const SETTING_KEYS = {
  defaultUserRateBps: "defaultUserRateBps",
  siteName: "siteName",
} as const;

export async function getSetting<T>(ctx: QueryCtx | MutationCtx, key: string, fallback: T): Promise<T> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return row ? (row.value as T) : fallback;
}

export async function getDefaultUserRateBps(ctx: QueryCtx | MutationCtx): Promise<number> {
  return getSetting<number>(ctx, SETTING_KEYS.defaultUserRateBps, DEFAULT_USER_RATE_BPS);
}

export const getPublic = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return { defaultUserRateBps: await getDefaultUserRateBps(ctx) };
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const rows = await ctx.db.query("settings").collect();
    return {
      defaultUserRateBps: await getDefaultUserRateBps(ctx),
      raw: rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt })),
    };
  },
});

export const setDefaultUserRateBps = mutation({
  args: { rateBps: v.number() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (!Number.isInteger(args.rateBps) || args.rateBps < 0 || args.rateBps > 10000) {
      fail("INVALID_ARGUMENT", "요율은 0~10000 bps 정수여야 합니다.");
    }
    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", SETTING_KEYS.defaultUserRateBps))
      .unique();
    const now = Date.now();
    if (existing) await ctx.db.patch(existing._id, { value: args.rateBps, updatedBy: actor._id, updatedAt: now });
    else
      await ctx.db.insert("settings", {
        key: SETTING_KEYS.defaultUserRateBps,
        value: args.rateBps,
        updatedBy: actor._id,
        updatedAt: now,
      });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "settings.defaultUserRateBps",
      metadata: { from: existing?.value ?? null, to: args.rateBps },
    });
  },
});
