import { v } from "convex/values";
import { estimateUserCommission } from "@automoney/shared";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { sumEntries } from "./lib/commissionEngine";
import { requireAdminOrSuper, requireSuperAdmin, requireUser, roleOf } from "./lib/rbac";
import { kstMonth, previousMonth } from "./lib/time";
import { getDefaultUserRateBps } from "./settings";

const EMPTY = { clicks: 0, directOrders: 0, directSales: 0, directCommissionable: 0, indirectOrders: 0, indirectSales: 0, indirectCommissionable: 0 };

async function statsFor(ctx: QueryCtx, userId: Id<"users">, month: string) {
  const row = await ctx.db
    .query("userMonthlyStats")
    .withIndex("by_user_month", (q) => q.eq("userId", userId).eq("month", month))
    .unique();
  return row ?? { ...EMPTY, userId, month };
}

function userFacing(s: typeof EMPTY, rateBps: number) {
  return {
    clicks: s.clicks,
    orders: s.directOrders,
    sales: s.directSales,
    commissionable: s.directCommissionable,
    estimatedCommission: estimateUserCommission(s.directCommissionable, rateBps),
  };
}

/** 유저 대시보드: 이번 달 실적, 차월 정산 예정액(전월 추정), KYC·링크 요약. */
export const userSummary = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const rate = user.userRateBpsOverride ?? (await getDefaultUserRateBps(ctx));
    const now = Date.now();
    const thisMonth = kstMonth(now);
    const lastMonth = previousMonth(thisMonth);
    const [cur, prev, kyc, links, curEntries, prevEntries] = await Promise.all([
      statsFor(ctx, user._id, thisMonth),
      statsFor(ctx, user._id, lastMonth),
      ctx.db.query("kycProfiles").withIndex("by_user", (q) => q.eq("userId", user._id)).unique(),
      ctx.db.query("marketingLinks").withIndex("by_user", (q) => q.eq("userId", user._id)).collect(),
      sumEntries(ctx, { beneficiaryUserId: user._id, beneficiaryType: "USER", month: thisMonth }),
      sumEntries(ctx, { beneficiaryUserId: user._id, beneficiaryType: "USER", month: lastMonth }),
    ]);
    // 예상 수당은 수수료 원장(commissionEntries) 합계를 정본으로 한다. 원장이 비어 있으면 단일 요율 추정치로 폴백.
    const curFacing = { ...userFacing(cur, rate), estimatedCommission: curEntries.count > 0 ? curEntries.amount : userFacing(cur, rate).estimatedCommission };
    const prevFacing = { ...userFacing(prev, rate), estimatedCommission: prevEntries.count > 0 ? prevEntries.amount : userFacing(prev, rate).estimatedCommission };
    return {
      month: thisMonth,
      rateBps: rate,
      current: curFacing,
      nextSettlement: { month: lastMonth, ...prevFacing, payable: kyc?.status === "APPROVED" },
      kycStatus: kyc?.status ?? null,
      linkCount: links.length,
      activeLinkCount: links.filter((l) => l.status === "ACTIVE").length,
    };
  },
});

/** 총판 대시보드: 하부 유저별 이번 달 DIRECT 실적. 간접·차액은 M2. */
export const adminSummary = query({
  args: { month: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireAdminOrSuper(ctx);
    const month = args.month ?? kstMonth(Date.now());
    const rate = await getDefaultUserRateBps(ctx);
    const team: Doc<"users">[] =
      roleOf(actor) === "SUPER_ADMIN"
        ? await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "USER")).collect()
        : await ctx.db.query("users").withIndex("by_parentAdmin", (q) => q.eq("parentAdminId", actor._id)).collect();
    const rows = [];
    const total = { clicks: 0, orders: 0, sales: 0, commissionable: 0, estimatedCommission: 0 };
    for (const u of team) {
      const s = userFacing(await statsFor(ctx, u._id, month), u.userRateBpsOverride ?? rate);
      rows.push({ userId: u._id, name: u.name ?? "", email: u.email ?? "", ...s });
      total.clicks += s.clicks;
      total.orders += s.orders;
      total.sales += s.sales;
      total.commissionable += s.commissionable;
      total.estimatedCommission += s.estimatedCommission;
    }
    return { month, memberCount: team.length, total, rows: rows.sort((a, b) => b.sales - a.sales) };
  },
});

/** 수퍼어드민: 전체 집계(간접 포함), 대기 KYC, 유저 수. */
export const superSummary = query({
  args: { month: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const month = args.month ?? kstMonth(Date.now());
    const rate = await getDefaultUserRateBps(ctx);
    const stats = await ctx.db.query("userMonthlyStats").withIndex("by_month", (q) => q.eq("month", month)).collect();
    const agg = { ...EMPTY };
    for (const s of stats) {
      agg.clicks += s.clicks;
      agg.directOrders += s.directOrders;
      agg.directSales += s.directSales;
      agg.directCommissionable += s.directCommissionable;
      agg.indirectOrders += s.indirectOrders;
      agg.indirectSales += s.indirectSales;
      agg.indirectCommissionable += s.indirectCommissionable;
    }
    const [users, pendingKyc, products, links] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("kycProfiles").withIndex("by_status", (q) => q.eq("status", "SUBMITTED")).collect(),
      ctx.db.query("products").withIndex("by_status", (q) => q.eq("status", "ACTIVE")).collect(),
      ctx.db.query("marketingLinks").collect(),
    ]);
    const [opSum, adminSum, userSum] = await Promise.all([
      sumEntries(ctx, { beneficiaryType: "OPERATOR", month }),
      sumEntries(ctx, { beneficiaryType: "ADMIN", month }),
      sumEntries(ctx, { beneficiaryType: "USER", month }),
    ]);
    return {
      month,
      rateBps: rate,
      margins: { operator: opSum.amount, admin: adminSum.amount, user: userSum.amount, operatorIndirect: opSum.indirect },
      direct: { orders: agg.directOrders, sales: agg.directSales, commissionable: agg.directCommissionable, estimatedUserCommission: estimateUserCommission(agg.directCommissionable, rate) },
      indirect: { orders: agg.indirectOrders, sales: agg.indirectSales, commissionable: agg.indirectCommissionable },
      clicks: agg.clicks,
      counts: {
        users: users.filter((u) => roleOf(u) === "USER").length,
        admins: users.filter((u) => roleOf(u) === "ADMIN").length,
        pendingKyc: pendingKyc.length,
        activeProducts: products.length,
        links: links.length,
      },
    };
  },
});
