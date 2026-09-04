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

    const r1 = await t.mutation(internal.orders.ingest, { payload: payload({}, { tracking_code: link.trackingCode }) });
    expect(r1.accepted).toBe(true);
    // 같은 event_id 재전송은 멱등
    const r2 = await t.mutation(internal.orders.ingest, { payload: payload({}, { tracking_code: link.trackingCode }) });
    expect(r2).toMatchObject({ accepted: true, duplicate: true });

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
});
