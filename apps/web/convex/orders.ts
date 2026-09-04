import { v } from "convex/values";
import {
  estimateUserCommission,
  parseAttrangsOrderWebhook,
  resolveAttribution,
  toOrderStatus,
  type AttrangsOrderWebhook,
} from "@automoney/shared";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import { requireSuperAdmin, requireUser, requireViewableUser } from "./lib/rbac";
import { bumpMonthlyStats, type StatsDelta } from "./lib/stats";
import { kstMonth } from "./lib/time";
import { getDefaultUserRateBps } from "./settings";

const COUNTED_STATUSES = new Set(["PAID", "CONFIRMED"]);

function statsDelta(order: Pick<Doc<"orders">, "attribution" | "orderAmount" | "commissionableAmount">, sign: 1 | -1): StatsDelta | null {
  if (!order.attribution) return null;
  if (order.attribution === "DIRECT") {
    return { directOrders: sign, directSales: sign * order.orderAmount, directCommissionable: sign * order.commissionableAmount };
  }
  return { indirectOrders: sign, indirectSales: sign * order.orderAmount, indirectCommissionable: sign * order.commissionableAmount };
}

/** 웹훅 수신 → 주문 원장 반영. 멱등(event_id), 상태 전이에 따라 월 집계 증감. */
export const ingest = internalMutation({
  args: { payload: v.any() },
  handler: async (ctx, args) => {
    const parsed = parseAttrangsOrderWebhook(args.payload);
    if (!parsed.ok) return { accepted: false as const, reason: parsed.error };
    const evt = parsed.value;

    const dupEvent = await ctx.db
      .query("orderEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", evt.event_id))
      .unique();
    if (dupEvent) return { accepted: true as const, duplicate: true as const };

    const existing = await ctx.db
      .query("orders")
      .withIndex("by_attrangsOrderId", (q) => q.eq("attrangsOrderId", evt.order.order_id))
      .unique();
    const orderId = existing ? await applyToExisting(ctx, existing, evt) : await createOrder(ctx, evt);

    await ctx.db.insert("orderEvents", {
      orderId,
      eventId: evt.event_id,
      eventType: evt.event_type,
      occurredAt: Date.parse(evt.occurred_at),
      payload: args.payload,
    });
    return { accepted: true as const, duplicate: false as const, orderId };
  },
});

async function createOrder(ctx: MutationCtx, evt: AttrangsOrderWebhook): Promise<Id<"orders">> {
  const o = evt.order;
  const attribution = resolveAttribution({ attribution: o.attribution, clickedAt: o.clicked_at, orderedAt: o.ordered_at });
  let link: Doc<"marketingLinks"> | null = null;
  if (o.tracking_code) {
    link = await ctx.db
      .query("marketingLinks")
      .withIndex("by_trackingCode", (q) => q.eq("trackingCode", o.tracking_code!))
      .unique();
  }
  const status = toOrderStatus(o.status);
  const orderedAt = Date.parse(o.ordered_at);
  const doc = {
    attrangsOrderId: o.order_id,
    linkId: link?._id,
    userId: link?.userId,
    attribution: link ? attribution ?? undefined : undefined,
    trackingCode: o.tracking_code ?? undefined,
    clickedAt: o.clicked_at ? Date.parse(o.clicked_at) : undefined,
    orderedAt,
    landingProductId: o.landing_product_id ?? undefined,
    quantity: o.items.reduce((s, it) => s + it.qty, 0),
    orderAmount: o.order_amount,
    commissionableAmount: o.commissionable_amount,
    status,
    rawPayload: evt,
    lastEventId: evt.event_id,
    updatedAt: Date.now(),
  };
  const id = await ctx.db.insert("orders", doc);
  if (doc.userId && COUNTED_STATUSES.has(status)) {
    const delta = statsDelta(doc, 1);
    if (delta) await bumpMonthlyStats(ctx, doc.userId, kstMonth(orderedAt), delta);
  }
  return id;
}

async function applyToExisting(ctx: MutationCtx, existing: Doc<"orders">, evt: AttrangsOrderWebhook): Promise<Id<"orders">> {
  const nextStatus = toOrderStatus(evt.order.status);
  const wasCounted = COUNTED_STATUSES.has(existing.status);
  const willCount = COUNTED_STATUSES.has(nextStatus);
  await ctx.db.patch(existing._id, { status: nextStatus, lastEventId: evt.event_id, updatedAt: Date.now() });
  if (existing.userId && wasCounted !== willCount) {
    const delta = statsDelta(existing, willCount ? 1 : -1);
    if (delta) await bumpMonthlyStats(ctx, existing.userId, kstMonth(existing.orderedAt), delta);
  }
  return existing._id;
}

/** 유저 본인 주문 — DIRECT 만. 간접구매는 유저·총판에게 노출하지 않는다 (docs/03 §6). */
export const listMine = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const rate = user.userRateBpsOverride ?? (await getDefaultUserRateBps(ctx));
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_user_attribution", (q) => q.eq("userId", user._id).eq("attribution", "DIRECT"))
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
    return rows.map((r) => toUserView(r, rate));
  },
});

/** 총판: 하부 유저의 DIRECT 주문. 수퍼어드민: 전체(간접 포함). */
export const listForUser = query({
  args: { userId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const target = await requireViewableUser(ctx, actor, args.userId);
    const rate = target.userRateBpsOverride ?? (await getDefaultUserRateBps(ctx));
    const isSuper = actor.role === "SUPER_ADMIN";
    const rows = isSuper
      ? await ctx.db.query("orders").withIndex("by_user", (q) => q.eq("userId", args.userId)).order("desc").take(Math.min(args.limit ?? 50, 200))
      : await ctx.db
          .query("orders")
          .withIndex("by_user_attribution", (q) => q.eq("userId", args.userId).eq("attribution", "DIRECT"))
          .order("desc")
          .take(Math.min(args.limit ?? 50, 200));
    return rows.map((r) => toUserView(r, rate));
  },
});

export const listAll = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const rate = await getDefaultUserRateBps(ctx);
    const rows = await ctx.db.query("orders").order("desc").take(Math.min(args.limit ?? 100, 500));
    return rows.map((r) => ({ ...toUserView(r, rate), userId: r.userId ?? null, trackingCode: r.trackingCode ?? null }));
  },
});

function toUserView(r: Doc<"orders">, rateBps: number) {
  return {
    _id: r._id,
    attrangsOrderId: r.attrangsOrderId,
    attribution: r.attribution ?? null,
    orderedAt: r.orderedAt,
    quantity: r.quantity,
    orderAmount: r.orderAmount,
    commissionableAmount: r.commissionableAmount,
    status: r.status,
    estimatedCommission: COUNTED_STATUSES.has(r.status) ? estimateUserCommission(r.commissionableAmount, rateBps) : 0,
  };
}
