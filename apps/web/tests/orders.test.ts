import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { makeT, seedProduct, signup } from "./helpers";

function payload(overrides: Record<string, unknown> = {}, orderOverrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_1",
    event_type: "order.created",
    occurred_at: new Date().toISOString(),
    order: {
      order_id: "A1",
      ordered_at: new Date().toISOString(),
      tracking_code: "tc_x",
      attribution: "direct",
      clicked_at: new Date(Date.now() - 3600_000).toISOString(),
      landing_product_id: 100001,
      items: [{ product_id: 100001, qty: 1, amount: 39000, commissionable_amount: 35000 }],
      order_amount: 39000,
      commissionable_amount: 35000,
      status: "paid",
      ...orderOverrides,
    },
    ...overrides,
  };
}

describe("orders ingest", () => {
  it("attributes an order to the link owner and updates the dashboard", async () => {
    const t = makeT();
    const user = await signup(t, "o1@test.com");
    const productId = await seedProduct(t);
    const link = await user.as.action(api.links.issue, { productId });

    const firstPayload = payload({}, { tracking_code: link.trackingCode });
    const r1 = await t.mutation(internal.orders.ingest, { payload: firstPayload });
    expect(r1.accepted).toBe(true);
    // 같은 event_id 재전송은 멱등
    const r2 = await t.mutation(internal.orders.ingest, { payload: firstPayload });
    expect(r2).toMatchObject({ accepted: true, duplicate: true });
    const conflict = await t.mutation(internal.orders.ingest, { payload: { ...firstPayload, order: { ...firstPayload.order, order_amount: 40000 } } });
    expect(conflict).toMatchObject({ accepted: false, quarantined: true, reason: "EVENT_ID_PAYLOAD_CONFLICT" });

    const summary = await user.as.query(api.dashboard.userSummary, {});
    expect(summary.current.orders).toBe(1);
    expect(summary.current.sales).toBe(39000);
    expect(summary.current.estimatedCommission).toBe(1750); // 35000 × 5%

    const mine = await user.as.query(api.orders.listMine, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]?.estimatedCommission).toBe(1750);

    // 취소 이벤트 → 집계 차감
    const cancel = payload({ event_id: "evt_2", event_type: "order.cancelled" }, { tracking_code: link.trackingCode, status: "cancelled" });
    await t.mutation(internal.orders.ingest, { payload: cancel });
    const after = await user.as.query(api.dashboard.userSummary, {});
    expect(after.current.orders).toBe(0);
    expect(after.current.estimatedCommission).toBe(0);
  });

  it("hides indirect orders from users but counts them for super admin", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const user = await signup(t, "o2@test.com");
    const productId = await seedProduct(t);
    const link = await user.as.action(api.links.issue, { productId });
    await t.mutation(internal.orders.ingest, {
      payload: payload({ event_id: "evt_i" }, { order_id: "I1", tracking_code: link.trackingCode, attribution: "indirect", landing_product_id: 100002 }),
    });
    expect(await user.as.query(api.orders.listMine, {})).toEqual([]);
    const us = await user.as.query(api.dashboard.userSummary, {});
    expect(us.current.orders).toBe(0);
    const ss = await owner.as.query(api.dashboard.superSummary, {});
    expect(ss.indirect.orders).toBe(1);
    expect(ss.indirect.sales).toBe(39000);
    expect(ss.direct.orders).toBe(0);
  });

  it("drops attribution when the click is older than 24h or the tracking code is unknown", async () => {
    const t = makeT();
    const user = await signup(t, "o3@test.com");
    const productId = await seedProduct(t);
    const link = await user.as.action(api.links.issue, { productId });
    await t.mutation(internal.orders.ingest, {
      payload: payload({ event_id: "e_old" }, { order_id: "OLD", tracking_code: link.trackingCode, clicked_at: new Date(Date.now() - 30 * 3600_000).toISOString() }),
    });
    await t.mutation(internal.orders.ingest, { payload: payload({ event_id: "e_unk" }, { order_id: "UNK", tracking_code: "tc_unknown" }) });
    expect(await user.as.query(api.orders.listMine, {})).toEqual([]);
    const orders = await t.run((ctx) => ctx.db.query("orders").collect());
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.attribution === undefined)).toBe(true);
  });

  it("rejects malformed payloads", async () => {
    const t = makeT();
    const r = await t.mutation(internal.orders.ingest, { payload: { nope: true } });
    expect(r.accepted).toBe(false);
  });

  it("does not resurrect refunded orders from stale events and quarantines partial refunds", async () => {
    const t = makeT();
    const user = await signup(t, "order-sequence@test.com");
    const productId = await seedProduct(t);
    const link = await user.as.action(api.links.issue, { productId });
    const baseTime = Date.now();
    const paid = payload({ event_id: "seq-paid", occurred_at: new Date(baseTime).toISOString() }, { order_id: "SEQ", tracking_code: link.trackingCode });
    expect((await t.mutation(internal.orders.ingest, { payload: paid })).applyStatus).toBe("APPLIED");
    const partial = payload({ event_id: "seq-partial", event_type: "order.refunded", occurred_at: new Date(baseTime + 1000).toISOString() }, { order_id: "SEQ", tracking_code: link.trackingCode, status: "refunded", order_amount: 10000, commissionable_amount: 9000 });
    expect((await t.mutation(internal.orders.ingest, { payload: partial })).applyStatus).toBe("QUARANTINED");
    const refund = payload({ event_id: "seq-refund", event_type: "order.refunded", occurred_at: new Date(baseTime + 2000).toISOString() }, { order_id: "SEQ", tracking_code: link.trackingCode, status: "refunded" });
    expect((await t.mutation(internal.orders.ingest, { payload: refund })).applyStatus).toBe("APPLIED");
    const stale = payload({ event_id: "seq-stale", occurred_at: new Date(baseTime + 500).toISOString() }, { order_id: "SEQ", tracking_code: link.trackingCode, status: "paid" });
    expect((await t.mutation(internal.orders.ingest, { payload: stale })).applyStatus).toBe("STALE");
    const order = await t.run((ctx) => ctx.db.query("orders").withIndex("by_attrangsOrderId", (q) => q.eq("attrangsOrderId", "SEQ")).unique());
    expect(order?.status).toBe("REFUNDED");
    expect((await user.as.query(api.dashboard.userSummary, {})).current.orders).toBe(0);
  });

  it("previews, applies, resumes, and deduplicates order CSV batches", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const user = await signup(t, "order-import@test.com");
    const productId = await seedProduct(t);
    const link = await user.as.action(api.links.issue, { productId });
    const occurred = new Date().toISOString();
    const clicked = new Date(Date.now() - 60_000).toISOString();
    const csv = [
      "event_id,event_type,occurred_at,order_id,ordered_at,tracking_code,attribution,clicked_at,order_amount,commissionable_amount,status,source_version",
      `csv-event-1,order.created,${occurred},CSV-1,${occurred},${link.trackingCode},direct,${clicked},39000,35000,paid,1`,
    ].join("\n");
    const preview = await owner.as.mutation(api.imports.previewOrders, { csv });
    expect(preview).toMatchObject({ duplicate: false, validRows: 1, errorRows: 0, status: "VALIDATED" });
    expect(await owner.as.mutation(api.imports.applyOrders, { batchId: preview.batchId })).toMatchObject({ completed: true, applied: 1, quarantined: 0 });
    expect(await owner.as.mutation(api.imports.applyOrders, { batchId: preview.batchId })).toMatchObject({ completed: true, applied: 0 });
    expect((await owner.as.mutation(api.imports.previewOrders, { csv })).duplicate).toBe(true);
    const order = await t.run((ctx) => ctx.db.query("orders").withIndex("by_attrangsOrderId", (q) => q.eq("attrangsOrderId", "CSV-1")).unique());
    expect(order?.source).toBe("CSV");
    expect((await user.as.query(api.dashboard.userSummary, {})).current.orders).toBe(1);
  });
});
