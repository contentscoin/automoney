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
import { COUNTED_STATUSES, syncOrderEntriesStandalone } from "./lib/commissionEngine";
import { bumpMonthlyStats, type StatsDelta } from "./lib/stats";
import { kstMonth } from "./lib/time";
import { getDefaultUserRateBps } from "./settings";
import { sha256Hex } from "./lib/crypto";
import { canonicalJson } from "./jobs";

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
  handler: async (ctx, args) => await ingestOrderPayload(ctx, args.payload, "WEBHOOK"),
});

export async function ingestOrderPayload(ctx: MutationCtx, payload: unknown, source: "CSV" | "WEBHOOK" | "RECON") {
    const parsed = parseAttrangsOrderWebhook(payload);
    if (!parsed.ok) return { accepted: false as const, reason: parsed.error };
    const evt = parsed.value;
    const payloadHash = await sha256Hex(canonicalJson(payload));

    const dupEvent = await ctx.db
      .query("orderEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", evt.event_id))
      .unique();
    if (dupEvent) {
      if (dupEvent.payloadHash === payloadHash || (!dupEvent.payloadHash && canonicalJson(dupEvent.payload) === canonicalJson(payload))) return { accepted: true as const, duplicate: true as const };
      await ctx.db.insert("orderEventConflicts", { eventId: evt.event_id, existingPayloadHash: dupEvent.payloadHash ?? await sha256Hex(canonicalJson(dupEvent.payload)), incomingPayloadHash: payloadHash, payload, reason: "EVENT_ID_PAYLOAD_CONFLICT", createdAt: Date.now() });
      return { accepted: false as const, quarantined: true as const, reason: "EVENT_ID_PAYLOAD_CONFLICT" };
    }

    const existing = await ctx.db
      .query("orders")
      .withIndex("by_attrangsOrderId", (q) => q.eq("attrangsOrderId", evt.order.order_id))
      .unique();
    const applied = existing ? await applyToExisting(ctx, existing, evt, source) : { orderId: await createOrder(ctx, evt, source), applyStatus: "APPLIED" as const, reason: undefined };

    await ctx.db.insert("orderEvents", {
      orderId: applied.orderId,
      eventId: evt.event_id,
      eventType: evt.event_type,
      occurredAt: Date.parse(evt.occurred_at),
      payload,
      payloadHash,
      applyStatus: applied.applyStatus,
      reason: applied.reason,
    });
    return { accepted: true as const, duplicate: false as const, orderId: applied.orderId, applyStatus: applied.applyStatus };
}

async function createOrder(ctx: MutationCtx, evt: AttrangsOrderWebhook, source: "CSV" | "WEBHOOK" | "RECON"): Promise<Id<"orders">> {
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
    lastOccurredAt: Date.parse(evt.occurred_at),
    lastSourceVersion: evt.source_version,
    source,
    ingestionVersion: 1,
    updatedAt: Date.now(),
  };
  const id = await ctx.db.insert("orders", doc);
  if (doc.userId && COUNTED_STATUSES.has(status)) {
    const delta = statsDelta(doc, 1);
    if (delta) await bumpMonthlyStats(ctx, doc.userId, kstMonth(orderedAt), delta);
  }
  const saved = await ctx.db.get(id);
  if (saved) await syncOrderEntriesStandalone(ctx, saved);
  return id;
}

async function applyToExisting(ctx: MutationCtx, existing: Doc<"orders">, evt: AttrangsOrderWebhook, source: "CSV" | "WEBHOOK" | "RECON"): Promise<{ orderId: Id<"orders">; applyStatus: "APPLIED" | "STALE" | "QUARANTINED"; reason?: string }> {
  const occurredAt = Date.parse(evt.occurred_at);
  if (evt.source_version && existing.lastSourceVersion && evt.source_version <= existing.lastSourceVersion) return { orderId: existing._id, applyStatus: "STALE", reason: "SOURCE_VERSION_NOT_NEWER" };
  if (!evt.source_version && existing.lastOccurredAt !== undefined && occurredAt <= existing.lastOccurredAt) return { orderId: existing._id, applyStatus: "STALE", reason: "OCCURRED_AT_NOT_NEWER" };
  const nextStatus = toOrderStatus(evt.order.status);
  const terminal = existing.status === "CANCELLED" || existing.status === "REFUNDED";
  if (terminal && nextStatus !== existing.status) return { orderId: existing._id, applyStatus: "QUARANTINED", reason: "TERMINAL_STATUS_REVERSAL" };
  if (nextStatus === "REFUNDED" && (evt.order.order_amount !== existing.orderAmount || evt.order.commissionable_amount !== existing.commissionableAmount)) {
    return { orderId: existing._id, applyStatus: "QUARANTINED", reason: "PARTIAL_REFUND_UNSUPPORTED" };
  }
  const amountChanged = evt.order.order_amount !== existing.orderAmount || evt.order.commissionable_amount !== existing.commissionableAmount;
  if (amountChanged && existing.userId && COUNTED_STATUSES.has(existing.status)) {
    const before = statsDelta(existing, -1);
    if (before) await bumpMonthlyStats(ctx, existing.userId, kstMonth(existing.orderedAt), before);
  }
  await ctx.db.patch(existing._id, {
    orderAmount: evt.order.order_amount,
    commissionableAmount: evt.order.commissionable_amount,
    quantity: evt.order.items.reduce((sum, item) => sum + item.qty, 0),
    rawPayload: evt,
    lastOccurredAt: occurredAt,
    lastSourceVersion: evt.source_version ?? existing.lastSourceVersion,
    source,
    ingestionVersion: 1,
  });
  const refreshed = (await ctx.db.get(existing._id))!;
  await transitionOrderStatus(ctx, refreshed, nextStatus, evt.event_id, amountChanged);
  return { orderId: existing._id, applyStatus: "APPLIED" };
}

/** 상태 전이 공통 경로: 월 집계 증감 + 수수료 항목 동기화. 웹훅과 리컨실이 함께 사용. */
export async function transitionOrderStatus(
  ctx: MutationCtx,
  existing: Doc<"orders">,
  nextStatus: Doc<"orders">["status"],
  eventId?: string,
  amountAlreadyRemoved = false,
): Promise<void> {
  const wasCounted = COUNTED_STATUSES.has(existing.status);
  const willCount = COUNTED_STATUSES.has(nextStatus);
  await ctx.db.patch(existing._id, { status: nextStatus, lastEventId: eventId ?? existing.lastEventId, updatedAt: Date.now() });
  if (existing.userId && (amountAlreadyRemoved ? willCount : wasCounted !== willCount)) {
    const delta = statsDelta(existing, willCount ? 1 : -1);
    if (delta) await bumpMonthlyStats(ctx, existing.userId, kstMonth(existing.orderedAt), delta);
  }
  const updated = await ctx.db.get(existing._id);
  if (updated) await syncOrderEntriesStandalone(ctx, updated);
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
