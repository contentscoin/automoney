import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export interface StatsDelta {
  clicks?: number;
  directOrders?: number;
  directSales?: number;
  directCommissionable?: number;
  indirectOrders?: number;
  indirectSales?: number;
  indirectCommissionable?: number;
}

const ZERO = {
  clicks: 0,
  directOrders: 0,
  directSales: 0,
  directCommissionable: 0,
  indirectOrders: 0,
  indirectSales: 0,
  indirectCommissionable: 0,
};

/** 월별 유저 집계를 트랜잭션 안에서 증감한다. */
export async function bumpMonthlyStats(ctx: MutationCtx, userId: Id<"users">, month: string, delta: StatsDelta) {
  const existing = await ctx.db
    .query("userMonthlyStats")
    .withIndex("by_user_month", (q) => q.eq("userId", userId).eq("month", month))
    .unique();
  if (!existing) {
    await ctx.db.insert("userMonthlyStats", { userId, month, ...ZERO, ...normalize(delta) });
    return;
  }
  const d = normalize(delta);
  await ctx.db.patch(existing._id, {
    clicks: existing.clicks + d.clicks,
    directOrders: existing.directOrders + d.directOrders,
    directSales: existing.directSales + d.directSales,
    directCommissionable: existing.directCommissionable + d.directCommissionable,
    indirectOrders: existing.indirectOrders + d.indirectOrders,
    indirectSales: existing.indirectSales + d.indirectSales,
    indirectCommissionable: existing.indirectCommissionable + d.indirectCommissionable,
  });
}

function normalize(d: StatsDelta) {
  return { ...ZERO, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) } as typeof ZERO;
}
