import { describe, expect, it } from "vitest";
import { buildAttrangsSettlementCsv } from "@automoney/shared";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { encryptField } from "../convex/lib/crypto";
import { kstMonth } from "../convex/lib/time";
import { makeT, seedProduct, setRole, signup, type T } from "./helpers";

const now = () => new Date().toISOString();
const clicked = () => new Date(Date.now() - 3600_000).toISOString();

function webhook(orderId: string, trackingCode: string, attribution: "direct" | "indirect", status = "paid", eventSuffix = "") {
  return {
    event_id: `evt_${orderId}${eventSuffix}`,
    event_type: status === "paid" ? "order.created" : `order.${status}`,
    occurred_at: now(),
    order: {
      order_id: orderId,
      ordered_at: now(),
      tracking_code: trackingCode,
      attribution,
      clicked_at: clicked(),
      landing_product_id: 100001,
      items: [{ product_id: 100001, qty: 1, amount: 39000, commissionable_amount: 35000 }],
      order_amount: 39000,
      commissionable_amount: 35000,
      status,
    },
  };
}

async function approveKyc(t: T, owner: Awaited<ReturnType<typeof signup>>, userId: Id<"users">) {
  const accountNoEnc = await encryptField(process.env.KYC_ENC_KEY!, "12345678901234");
  const kycId = await t.run(async (ctx) =>
    ctx.db.insert("kycProfiles", {
      userId,
      legalName: "홍길동",
      phone: "010-1111-2222",
      address: "서울",
      birthDate: "1995-01-01",
      residentNoEnc: "x",
      residentNoLast4: "1234",
      bankCode: "004",
      bankName: "국민은행",
      accountNoEnc,
      accountNoLast4: "5678",
      accountHolder: "홍길동",
      bankbookStorageId: await ctx.storage.store(new Blob(["x"], { type: "image/png" })),
      status: "SUBMITTED",
      submittedAt: Date.now(),
    }),
  );
  await owner.as.mutation(api.kyc.review, { kycId, decision: "APPROVED" });
}

/** 운영자·총판·유저·상품·링크·기본 요율 시드 */
async function scenario() {
  const t = makeT();
  const owner = await signup(t, "owner@automoney.test");
  await owner.as.mutation(api.commissionRules.seedDefaults, {});
  const admin = await signup(t, "admin@test.com");
  await setRole(t, admin.userId, "ADMIN");
  const invite = await admin.as.mutation(api.invites.create, {});
  const user = await signup(t, "user@test.com", { inviteCode: invite.code });
  const productId = await seedProduct(t);
  const link = await user.as.action(api.links.issue, { productId });
  return { t, owner, admin, user, link, month: kstMonth(Date.now()) };
}

async function entriesFor(t: T, orderKey: string) {
  return await t.run(async (ctx) => {
    const order = (await ctx.db.query("orders").withIndex("by_attrangsOrderId", (q) => q.eq("attrangsOrderId", orderKey)).unique())!;
    const rows = await ctx.db.query("commissionEntries").withIndex("by_order", (q) => q.eq("orderId", order._id)).collect();
    const sum: Record<string, number> = {};
    for (const r of rows) sum[r.beneficiaryType] = (sum[r.beneficiaryType] ?? 0) + r.sign * r.amount;
    return { rows, sum };
  });
}

describe("commission engine", () => {
  it("splits a direct order across user/admin/operator with default rules (G1 15%)", async () => {
    const { t, link } = await scenario();
    await t.mutation(internal.orders.ingest, { payload: webhook("D1", link.trackingCode, "direct") });
    const { sum } = await entriesFor(t, "D1");
    // 35000 × (5% / 8% / 15%) → user 1750, admin 2800−1750=1050, operator 5250−1750−1050=2450
    expect(sum).toEqual({ USER: 1750, ADMIN: 1050, OPERATOR: 2450 });
  });

  it("pays nothing to the user on indirect orders; admin and operator split the rest", async () => {
    const { t, link } = await scenario();
    await t.mutation(internal.orders.ingest, { payload: webhook("I1", link.trackingCode, "indirect") });
    const { sum, rows } = await entriesFor(t, "I1");
    expect(sum.USER ?? 0).toBe(0);
    expect(rows.some((r) => r.beneficiaryType === "USER")).toBe(false);
    expect(sum).toEqual({ ADMIN: 1050, OPERATOR: 4200 });
  });

  it("user without an admin: operator takes the admin share", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    await owner.as.mutation(api.commissionRules.seedDefaults, {});
    const solo = await signup(t, "solo@test.com");
    const productId = await seedProduct(t);
    const link = await solo.as.action(api.links.issue, { productId });
    await t.mutation(internal.orders.ingest, { payload: webhook("S1", link.trackingCode, "direct") });
    const { sum } = await entriesFor(t, "S1");
    expect(sum).toEqual({ USER: 1750, OPERATOR: 3500 });
  });

  it("cancellation reverses unsettled entries to a net of zero", async () => {
    const { t, link } = await scenario();
    await t.mutation(internal.orders.ingest, { payload: webhook("C1", link.trackingCode, "direct") });
    await t.mutation(internal.orders.ingest, { payload: webhook("C1", link.trackingCode, "direct", "cancelled", "_c") });
    const { rows } = await entriesFor(t, "C1");
    expect(rows).toHaveLength(0); // 미정산 항목은 삭제 후 재생성 → 원하는 상태가 0 이면 항목 없음
  });

  it("cancellation after settlement leaves a negative carry-over entry", async () => {
    const { t, owner, user, link, month } = await scenario();
    await approveKyc(t, owner, user.userId);
    await t.mutation(internal.orders.ingest, { payload: webhook("C2", link.trackingCode, "direct") });
    await owner.as.mutation(api.settlements.closeMonth, { month });
    await t.mutation(internal.orders.ingest, { payload: webhook("C2", link.trackingCode, "direct", "refunded", "_r") });
    const { rows, sum } = await entriesFor(t, "C2");
    expect(sum).toEqual({ USER: 0, ADMIN: 0, OPERATOR: 0 });
    const unsettled = rows.filter((r) => !r.settlementId);
    expect(unsettled).toHaveLength(3);
    expect(unsettled.every((r) => r.sign === -1)).toBe(true);
  });
});

describe("settlement lifecycle", () => {
  it("closes the month: HELD without KYC, DRAFT after approval; reconcile confirms with zero diff; approve → payout → paid", async () => {
    const { t, owner, admin, user, link, month } = await scenario();
    await t.mutation(internal.orders.ingest, { payload: webhook("L1", link.trackingCode, "direct") });
    await t.mutation(internal.orders.ingest, { payload: webhook("L2", link.trackingCode, "indirect") });

    await expect(user.as.mutation(api.settlements.closeMonth, { month })).rejects.toThrow(/권한/);
    const first = await owner.as.mutation(api.settlements.closeMonth, { month });
    expect(first.held).toBe(1); // 유저 KYC 미승인
    expect(first.created).toBe(2); // 총판·운영사
    let mine = await user.as.query(api.settlements.listMine, {});
    expect(mine[0]?.status).toBe("HELD");
    expect(mine[0]?.heldReason).toBe("KYC_INCOMPLETE");

    await approveKyc(t, owner, user.userId);
    const second = await owner.as.mutation(api.settlements.closeMonth, { month });
    expect(second.held).toBe(0);
    expect(second.created).toBe(3);
    mine = await user.as.query(api.settlements.listMine, {});
    expect(mine[0]?.status).toBe("DRAFT");
    expect(mine[0]?.grossAmount).toBe(1750);

    // 아뜨랑스 확정: G2(18%) → 두 주문 × 35000 × 18% = 12600
    const csv = buildAttrangsSettlementCsv({
      month,
      grade: "G2",
      rateBps: 1800,
      payoutTotal: 12600,
      orders: [
        { orderId: "L1", commissionableAmount: 35000, attribution: "DIRECT", status: "CONFIRMED" },
        { orderId: "L2", commissionableAmount: 35000, attribution: "INDIRECT", status: "CONFIRMED" },
      ],
    });
    await owner.as.mutation(api.settlements.uploadBatchCsv, { csv });
    const recon = await owner.as.mutation(api.settlements.reconcile, { month });
    expect(recon.diffs).toEqual([]);
    expect(recon.diffAmount).toBe(0);
    expect(recon.clean).toBe(true);
    expect(recon.oursTotal).toBe(12600);

    const sm = await owner.as.query(api.settlements.superMonth, { month });
    expect(sm.grade).toBe("G2");
    expect(sm.gradeSource).toBe("ATTRANGS");
    expect(sm.totals.total).toBe(12600);
    // 유저 1750(직접만), 총판 1050 + 1050, 운영사 = 나머지
    expect(sm.totals.user).toBe(1750);
    expect(sm.totals.admin).toBe(2100);
    expect(sm.totals.operator).toBe(12600 - 1750 - 2100);
    expect(sm.settlements.every((s) => s.status === "CONFIRMED")).toBe(true);

    // DRAFT 정산은 리컨실 시 재구성되므로 id 를 다시 조회
    mine = await user.as.query(api.settlements.listMine, {});
    expect(mine[0]?.status).toBe("CONFIRMED");

    // 주문 상태도 CONFIRMED 로 반영
    const orders = await t.run((ctx) => ctx.db.query("orders").collect());
    expect(orders.every((o) => o.status === "CONFIRMED")).toBe(true);

    // 총판 화면: 본인 차액 2100, 하부 유저 수당 1750
    const am = await admin.as.query(api.settlements.adminMonth, { month });
    expect(am.adminMargin).toBe(2100);
    expect(am.rows[0]?.userCommission).toBe(1750);

    // 명세서: 본인 OK, 총판 OK(하부), 운영사 명세서는 유저 금지
    const statement = await user.as.query(api.settlements.getStatement, { id: mine[0]!._id });
    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]?.amount).toBe(1750);
    await admin.as.query(api.settlements.getStatement, { id: mine[0]!._id });
    const opSettlement = sm.settlements.find((s) => s.beneficiaryType === "OPERATOR")!;
    await expect(user.as.query(api.settlements.getStatement, { id: opSettlement._id })).rejects.toThrow(/권한/);

    // 승인 → 지급 파일 → 지급 완료
    await owner.as.mutation(api.settlements.approve, { month });
    const payout = await owner.as.action(api.settlements.exportPayout, { month });
    expect(payout.count).toBe(1); // KYC 승인된 유저만 (총판은 KYC 없음)
    expect(payout.total).toBe(1750);
    expect(typeof payout.url).toBe("string");
    await owner.as.mutation(api.settlements.markPaid, { month, paidRef: "ATT-2026-09" });
    mine = await user.as.query(api.settlements.listMine, {});
    expect(mine[0]?.status).toBe("PAID");
    expect(mine[0]?.paidRef).toBe("ATT-2026-09");
    await expect(owner.as.mutation(api.settlements.reconcile, { month })).rejects.toThrow(/승인·지급/);

    const audits = await owner.as.query(api.audit.list, {});
    expect(audits.some((a) => a.action === "settlement.exportPayout")).toBe(true);
  });

  it("holds the month on payout mismatch and reports diffs", async () => {
    const { t, owner, user, link, month } = await scenario();
    await approveKyc(t, owner, user.userId);
    await t.mutation(internal.orders.ingest, { payload: webhook("M1", link.trackingCode, "direct") });
    await owner.as.mutation(api.settlements.closeMonth, { month });
    const csv = buildAttrangsSettlementCsv({
      month,
      grade: "G1",
      rateBps: 1500,
      payoutTotal: 9999,
      orders: [
        { orderId: "M1", commissionableAmount: 30000, attribution: "DIRECT", status: "CONFIRMED" },
        { orderId: "GHOST", commissionableAmount: 1000, attribution: "DIRECT", status: "CONFIRMED" },
      ],
    });
    await owner.as.mutation(api.settlements.uploadBatchCsv, { csv });
    const recon = await owner.as.mutation(api.settlements.reconcile, { month });
    expect(recon.clean).toBe(false);
    expect(recon.diffs.map((d) => d.kind).sort()).toEqual(["AMOUNT_MISMATCH", "MISSING_OURS", "PAYOUT_TOTAL_MISMATCH"]);
    const mine = await user.as.query(api.settlements.listMine, {});
    expect(mine[0]?.status).toBe("HELD");
    expect(mine[0]?.heldReason).toBe("RECON_MISMATCH");
    await expect(owner.as.mutation(api.settlements.approve, { month })).rejects.toThrow(/확정/);
  });

  it("recompute is idempotent and reflects rule changes on unsettled months", async () => {
    const { t, owner, link, month } = await scenario();
    await t.mutation(internal.orders.ingest, { payload: webhook("R1", link.trackingCode, "direct") });
    const before = await entriesFor(t, "R1");
    await owner.as.mutation(api.commissionRules.recompute, { month });
    const same = await entriesFor(t, "R1");
    expect(same.sum).toEqual(before.sum);
    // 유저 요율 10% 로 변경 → 재계산
    await owner.as.mutation(api.commissionRules.upsertRule, { level: "ADMIN_TO_USER", attribution: "DIRECT", rateBps: 1000 });
    await owner.as.mutation(api.commissionRules.recompute, { month });
    const after = await entriesFor(t, "R1");
    // 유저 10% = 3500, 총판 8% 는 유저분 이하라 0, 운영사 = 5250 − 3500
    expect(after.sum).toEqual({ USER: 3500, OPERATOR: 1750 });
    expect((after.sum.USER ?? 0) + (after.sum.ADMIN ?? 0) + (after.sum.OPERATOR ?? 0)).toBe(5250);
  });

  it("dashboard estimated commission follows the ledger", async () => {
    const { t, user, link } = await scenario();
    await t.mutation(internal.orders.ingest, { payload: webhook("E1", link.trackingCode, "direct") });
    await t.mutation(internal.orders.ingest, { payload: webhook("E2", link.trackingCode, "indirect") });
    const s = await user.as.query(api.dashboard.userSummary, {});
    expect(s.current.orders).toBe(1);
    expect(s.current.estimatedCommission).toBe(1750);
  });
});
