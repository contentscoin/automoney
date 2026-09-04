import { v } from "convex/values";
import { DEFAULT_COMMISSION_RULES, DEFAULT_GRADE_TIERS } from "@automoney/shared";
import { mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { recomputeMonth } from "./lib/commissionEngine";
import { fail } from "./lib/errors";
import { requireSuperAdmin } from "./lib/rbac";
import { attributionValidator } from "./schema";

const levelValidator = v.union(v.literal("ATTRANGS_TO_OPERATOR"), v.literal("OPERATOR_TO_ADMIN"), v.literal("ADMIN_TO_USER"));

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const [rules, tiers] = await Promise.all([ctx.db.query("commissionRules").collect(), ctx.db.query("gradeTiers").collect()]);
    return {
      rules: rules.sort((a, b) => a.level.localeCompare(b.level) || b.validFrom - a.validFrom),
      tiers: tiers.sort((a, b) => a.minMonthlySales - b.minMonthlySales),
    };
  },
});

/** 기본 요율·그레이드 시드. 이미 규칙이 있으면 건너뛴다. */
export const seedDefaults = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await requireSuperAdmin(ctx);
    const existing = await ctx.db.query("commissionRules").first();
    const existingTier = await ctx.db.query("gradeTiers").first();
    const now = Date.now();
    let inserted = 0;
    if (!existing) {
      for (const r of DEFAULT_COMMISSION_RULES) {
        await ctx.db.insert("commissionRules", { level: r.level, attribution: r.attribution, rateBps: r.rateBps, validFrom: 0, active: true, note: "기본값" });
        inserted++;
      }
    }
    if (!existingTier) {
      for (const t of DEFAULT_GRADE_TIERS) {
        await ctx.db.insert("gradeTiers", t);
        inserted++;
      }
    }
    await audit(ctx, { actorUserId: actor._id, action: "rules.seedDefaults", metadata: { inserted, at: now } });
    return { inserted };
  },
});

export const upsertRule = mutation({
  args: {
    id: v.optional(v.id("commissionRules")),
    level: levelValidator,
    attribution: v.union(attributionValidator, v.literal("ANY")),
    grade: v.optional(v.string()),
    rateBps: v.number(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    scopeUserId: v.optional(v.id("users")),
    scopeAdminId: v.optional(v.id("users")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (!Number.isInteger(args.rateBps) || args.rateBps < 0 || args.rateBps > 10000) fail("INVALID_ARGUMENT", "요율은 0~10000 bps 정수여야 합니다.");
    if (args.level !== "ATTRANGS_TO_OPERATOR" && args.grade) fail("INVALID_ARGUMENT", "그레이드는 아뜨랑스→운영사 규칙에만 지정합니다.");
    const doc = {
      level: args.level,
      attribution: args.attribution,
      grade: args.grade,
      rateBps: args.rateBps,
      validFrom: args.validFrom ?? 0,
      validTo: args.validTo,
      scopeUserId: args.scopeUserId,
      scopeAdminId: args.scopeAdminId,
      active: true,
      note: args.note,
    };
    const id = args.id ? (await ctx.db.patch(args.id, doc), args.id) : await ctx.db.insert("commissionRules", doc);
    await audit(ctx, { actorUserId: actor._id, action: "rules.upsert", metadata: { id, ...doc } });
    return id;
  },
});

export const setRuleActive = mutation({
  args: { id: v.id("commissionRules"), active: v.boolean() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    await ctx.db.patch(args.id, { active: args.active });
    await audit(ctx, { actorUserId: actor._id, action: "rules.setActive", metadata: args });
  },
});

export const upsertTier = mutation({
  args: { id: v.optional(v.id("gradeTiers")), grade: v.string(), minMonthlySales: v.number(), attrangsRateBps: v.number(), active: v.boolean() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (!Number.isInteger(args.attrangsRateBps) || args.attrangsRateBps < 0 || args.attrangsRateBps > 10000) fail("INVALID_ARGUMENT", "요율은 0~10000 bps 정수여야 합니다.");
    if (args.minMonthlySales < 0) fail("INVALID_ARGUMENT", "구간 하한은 0 이상이어야 합니다.");
    const { id, ...doc } = args;
    const tierId = id ? (await ctx.db.patch(id, doc), id) : await ctx.db.insert("gradeTiers", doc);
    await audit(ctx, { actorUserId: actor._id, action: "rules.upsertTier", metadata: { id: tierId, ...doc } });
    return tierId;
  },
});

/** 규칙 변경 후 미정산 월 재계산 */
export const recompute = mutation({
  args: { month: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (!/^\d{4}-\d{2}$/.test(args.month)) fail("INVALID_ARGUMENT", "month 는 YYYY-MM 형식입니다.");
    const r = await recomputeMonth(ctx, args.month);
    await audit(ctx, { actorUserId: actor._id, action: "rules.recompute", metadata: { month: args.month, ...r } });
    return r;
  },
});
