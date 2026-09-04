import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { applyRateBps, parseAttrangsSettlementCsv } from "@automoney/shared";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { COUNTED_STATUSES, loadRules, getMonthMeta, monthRange, recomputeMonth, sumEntries } from "./lib/commissionEngine";
import { decryptField } from "./lib/crypto";
import { fail } from "./lib/errors";
import { canViewUser, requireAdminOrSuper, requireSuperAdmin, requireUser, roleOf } from "./lib/rbac";
import { kstMonth, previousMonth } from "./lib/time";
import { transitionOrderStatus } from "./orders";

type Beneficiary = "USER" | "ADMIN" | "OPERATOR";
const MONTH_RE = /^\d{4}-\d{2}$/;

function assertMonth(month: string) {
  if (!MONTH_RE.test(month)) fail("INVALID_ARGUMENT", "month 는 YYYY-MM 형식입니다.");
}

// ─────────────────────────────── 월 마감 (DRAFT/HELD 재구성) ───────────────────────────────

/**
 * 해당 월 이하의 미정산 항목을 수혜자별 정산으로 묶는다.
 * - DRAFT/HELD 정산은 매번 해체 후 재구성(멱등). CONFIRMED 이상은 불변.
 * - USER 수혜자의 KYC 미승인 → HELD(항목은 묶지 않고 다음 마감으로 이월).
 */
export async function closeMonthImpl(ctx: MutationCtx, month: string): Promise<{ created: number; held: number; totalAmount: number }> {
  assertMonth(month);
  const existing = await ctx.db.query("settlements").withIndex("by_month", (q) => q.eq("month", month)).collect();
  for (const s of existing) {
    if (s.status === "DRAFT" || s.status === "HELD") {
      const linked = await ctx.db.query("commissionEntries").withIndex("by_settlement", (q) => q.eq("settlementId", s._id)).collect();
      for (const e of linked) await ctx.db.patch(e._id, { settlementId: undefined });
      await ctx.db.delete(s._id);
    }
  }
  // 미정산 항목 중 month 이하 (이월 포함)
  const all = await ctx.db.query("commissionEntries").collect();
  const pending = all.filter((e) => !e.settlementId && e.month <= month);
  const groups = new Map<string, { type: Beneficiary; userId?: Id<"users">; entries: Doc<"commissionEntries">[] }>();
  for (const e of pending) {
    const key = `${e.beneficiaryType}:${e.beneficiaryUserId ?? ""}`;
    const g = groups.get(key) ?? { type: e.beneficiaryType, userId: e.beneficiaryUserId, entries: [] };
    g.entries.push(e);
    groups.set(key, g);
  }
  let created = 0;
  let held = 0;
  let totalAmount = 0;
  const now = Date.now();
  for (const g of groups.values()) {
    const gross = g.entries.reduce((s, e) => s + e.sign * e.amount, 0);
    let heldReason: string | undefined;
    if (g.type === "USER" && g.userId) {
      const kyc = await ctx.db.query("kycProfiles").withIndex("by_user", (q) => q.eq("userId", g.userId!)).unique();
      if (kyc?.status !== "APPROVED") heldReason = "KYC_INCOMPLETE";
    }
    if (gross < 0) heldReason = heldReason ?? "NEGATIVE_BALANCE";
    const id = await ctx.db.insert("settlements", {
      month,
      beneficiaryType: g.type,
      beneficiaryUserId: g.userId,
      status: heldReason ? "HELD" : "DRAFT",
      grossAmount: gross,
      entryCount: g.entries.length,
      heldReason,
      updatedAt: now,
    });
    if (!heldReason) {
      for (const e of g.entries) await ctx.db.patch(e._id, { settlementId: id });
      created++;
      totalAmount += gross;
    } else held++;
  }
  const meta = await ctx.db.query("settlementMonths").withIndex("by_month", (q) => q.eq("month", month)).unique();
  if (meta) await ctx.db.patch(meta._id, { closedAt: now, updatedAt: now });
  else {
    const { tiers } = await loadRules(ctx);
    const m = await getMonthMeta(ctx, month, tiers);
    await ctx.db.insert("settlementMonths", { month, grade: m.grade, gradeSource: "PROVISIONAL", computationVersion: m.computationVersion, closedAt: now, updatedAt: now });
  }
  return { created, held, totalAmount };
}

export const closeMonth = mutation({
  args: { month: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const r = await closeMonthImpl(ctx, args.month);
    await audit(ctx, { actorUserId: actor._id, action: "settlement.closeMonth", metadata: { month: args.month, ...r } });
    return r;
  },
});

/** 크론: 매월 전월 마감 */
export const cronCloseLastMonth = internalMutation({
  args: {},
  handler: async (ctx) => {
    const month = previousMonth(kstMonth(Date.now()));
    const r = await closeMonthImpl(ctx, month);
    await audit(ctx, { action: "settlement.cronClose", metadata: { month, ...r } });
  },
});

// ─────────────────────────────── 아뜨랑스 확정 배치 · 리컨실 ───────────────────────────────

export const uploadBatchCsv = mutation({
  args: { csv: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (args.csv.length > 2_000_000) fail("INVALID_ARGUMENT", "CSV 는 2MB 이하여야 합니다.");
    const parsed = parseAttrangsSettlementCsv(args.csv);
    if (!parsed.ok) fail("INVALID_ARGUMENT", `확정 배치 CSV 오류: ${parsed.error}`);
    const b = parsed.batch;
    const id = await ctx.db.insert("attrangsSettlementBatches", { ...b, uploadedBy: actor._id, uploadedAt: Date.now() });
    await audit(ctx, { actorUserId: actor._id, action: "settlement.uploadBatch", metadata: { month: b.month, orders: b.orders.length, payoutTotal: b.payoutTotal } });
    return { id, month: b.month, orders: b.orders.length };
  },
});

/**
 * 리컨실: 배치 ↔ 우리 원장 대조 → 상태 반영 → 그레이드 확정 → 재계산 → 마감 재구성 → 0원 오차면 CONFIRMED.
 */
export const reconcile = mutation({
  args: { month: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    assertMonth(args.month);
    const batch = await ctx.db.query("attrangsSettlementBatches").withIndex("by_month", (q) => q.eq("month", args.month)).order("desc").first();
    if (!batch) fail("NOT_FOUND", "해당 월의 아뜨랑스 확정 배치가 없습니다.");
    const locked = (await ctx.db.query("settlements").withIndex("by_month", (q) => q.eq("month", args.month)).collect()).some((s) =>
      ["APPROVED", "PAID"].includes(s.status),
    );
    if (locked) fail("CONFLICT", "이미 승인·지급된 월은 리컨실할 수 없습니다.");

    const { start, end } = monthRange(args.month);
    const ours = await ctx.db.query("orders").withIndex("by_orderedAt", (q) => q.gte("orderedAt", start).lt("orderedAt", end)).collect();
    const ourById = new Map(ours.map((o) => [o.attrangsOrderId, o]));
    const diffs: { kind: string; orderId: string; detail: string }[] = [];

    // 1) 배치 → 우리 상태 반영
    for (const row of batch.orders) {
      const o = ourById.get(row.orderId);
      if (!o) {
        diffs.push({ kind: "MISSING_OURS", orderId: row.orderId, detail: `아뜨랑스에만 존재 (${row.commissionableAmount}원, ${row.attribution})` });
        continue;
      }
      if (o.commissionableAmount !== row.commissionableAmount) {
        diffs.push({ kind: "AMOUNT_MISMATCH", orderId: row.orderId, detail: `우리 ${o.commissionableAmount} vs 아뜨랑스 ${row.commissionableAmount}` });
      }
      if (o.attribution && o.attribution !== row.attribution) {
        diffs.push({ kind: "ATTRIBUTION_MISMATCH", orderId: row.orderId, detail: `우리 ${o.attribution} vs 아뜨랑스 ${row.attribution}` });
      }
      if (!o.attribution) {
        diffs.push({ kind: "UNATTRIBUTED_OURS", orderId: row.orderId, detail: `우리 원장에 링크 매칭 없음 (아뜨랑스 ${row.attribution})` });
      }
      if (o.status !== row.status) await transitionOrderStatus(ctx, o, row.status);
    }
    // 2) 우리에게만 있는 카운트 주문
    const theirIds = new Set(batch.orders.map((r) => r.orderId));
    for (const o of ours) {
      if (o.attribution && COUNTED_STATUSES.has(o.status) && !theirIds.has(o.attrangsOrderId)) {
        diffs.push({ kind: "MISSING_THEIRS", orderId: o.attrangsOrderId, detail: `우리 원장에만 존재 (${o.commissionableAmount}원)` });
      }
    }
    // 3) 그레이드 확정 → 재계산 → 마감 재구성
    const meta = await ctx.db.query("settlementMonths").withIndex("by_month", (q) => q.eq("month", args.month)).unique();
    const now = Date.now();
    if (meta) await ctx.db.patch(meta._id, { grade: batch.grade, gradeSource: "ATTRANGS", updatedAt: now });
    else await ctx.db.insert("settlementMonths", { month: args.month, grade: batch.grade, gradeSource: "ATTRANGS", computationVersion: 1, updatedAt: now });
    await recomputeMonth(ctx, args.month);
    await closeMonthImpl(ctx, args.month);

    // 4) 운영사 수취 총액 비교 (아뜨랑스가 운영사에 지급하는 금액 = 배치 확정 주문 × 배치 요율)
    const confirmedRows = batch.orders.filter((r) => r.status === "CONFIRMED" && ourById.get(r.orderId)?.attribution);
    const expected = confirmedRows.reduce((s, r) => s + applyRateBps(r.commissionableAmount, batch.rateBps), 0);
    const oursTotal = (await sumEntries(ctx, { month: args.month })).amount;
    const diffAmount = batch.payoutTotal - oursTotal;
    if (expected !== batch.payoutTotal) {
      diffs.push({ kind: "PAYOUT_TOTAL_MISMATCH", orderId: "-", detail: `배치 주문×요율 합계 ${expected} ≠ payout_total ${batch.payoutTotal}` });
    }
    await ctx.db.patch(batch._id, { reconciledAt: now, diffAmount, diffs, ourOperatorTotal: oursTotal });

    const clean = diffs.length === 0 && diffAmount === 0;
    const settlements = await ctx.db.query("settlements").withIndex("by_month", (q) => q.eq("month", args.month)).collect();
    for (const s of settlements) {
      if (s.status === "DRAFT") {
        if (clean) await ctx.db.patch(s._id, { status: "CONFIRMED", confirmedAt: now, updatedAt: now });
        else await ctx.db.patch(s._id, { status: "HELD", heldReason: "RECON_MISMATCH", updatedAt: now });
      }
    }
    await audit(ctx, { actorUserId: actor._id, action: "settlement.reconcile", metadata: { month: args.month, clean, diffAmount, diffs: diffs.length } });
    return { clean, diffAmount, diffs, oursTotal, payoutTotal: batch.payoutTotal };
  },
});

// ─────────────────────────────── 승인 · 지급 파일 · 지급 완료 ───────────────────────────────

export const approve = mutation({
  args: { month: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    assertMonth(args.month);
    const rows = await ctx.db.query("settlements").withIndex("by_month", (q) => q.eq("month", args.month)).collect();
    const confirmed = rows.filter((s) => s.status === "CONFIRMED");
    if (confirmed.length === 0) fail("CONFLICT", "확정(CONFIRMED) 상태의 정산이 없습니다. 리컨실을 먼저 완료하세요.");
    const now = Date.now();
    for (const s of confirmed) await ctx.db.patch(s._id, { status: "APPROVED", approvedAt: now, updatedAt: now });
    await audit(ctx, { actorUserId: actor._id, action: "settlement.approve", metadata: { month: args.month, count: confirmed.length } });
    return { approved: confirmed.length };
  },
});

export const payoutRows = internalQuery({
  args: { month: v.string(), actorId: v.id("users") },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorId);
    if (!actor || roleOf(actor) !== "SUPER_ADMIN") fail("FORBIDDEN", "권한이 없습니다.");
    const rows = await ctx.db.query("settlements").withIndex("by_month", (q) => q.eq("month", args.month)).collect();
    const out = [];
    for (const s of rows) {
      if (s.status !== "APPROVED" || !s.beneficiaryUserId || s.grossAmount <= 0) continue;
      const kyc = await ctx.db.query("kycProfiles").withIndex("by_user", (q) => q.eq("userId", s.beneficiaryUserId!)).unique();
      const user = await ctx.db.get(s.beneficiaryUserId);
      if (!kyc || kyc.status !== "APPROVED") continue;
      out.push({
        settlementId: s._id,
        beneficiaryType: s.beneficiaryType,
        email: user?.email ?? "",
        legalName: kyc.legalName,
        bankCode: kyc.bankCode,
        bankName: kyc.bankName,
        accountNoEnc: kyc.accountNoEnc,
        accountHolder: kyc.accountHolder,
        amount: s.grossAmount,
      });
    }
    return out;
  },
});

export const recordPayoutFile = internalMutation({
  args: { month: v.string(), actorId: v.id("users"), storageId: v.id("_storage"), settlementIds: v.array(v.id("settlements")), total: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const id of args.settlementIds) await ctx.db.patch(id, { payoutFileGeneratedAt: now, updatedAt: now });
    await audit(ctx, { actorUserId: args.actorId, action: "settlement.exportPayout", metadata: { month: args.month, count: args.settlementIds.length, total: args.total, storageId: args.storageId } });
    return await ctx.storage.getUrl(args.storageId);
  },
});

/** 아뜨랑스 전달용 지급 파일 (CSV, 계좌 복호화). 세금 공제 없음 — 원천징수·지급은 아뜨랑스가 수행. */
export const exportPayout = action({
  args: { month: v.string() },
  handler: async (ctx, args): Promise<{ url: string | null; count: number; total: number }> => {
    const actorId = await getAuthUserId(ctx);
    if (!actorId) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
    const key = process.env.KYC_ENC_KEY;
    if (!key) fail("CONFIG_MISSING", "KYC_ENC_KEY 가 설정되지 않았습니다.");
    const rows = await ctx.runQuery(internal.settlements.payoutRows, { month: args.month, actorId });
    const lines = ["settlement_month,beneficiary_type,email,legal_name,bank_code,bank_name,account_no,account_holder,amount_krw"];
    let total = 0;
    for (const r of rows) {
      const accountNo = await decryptField(key, r.accountNoEnc);
      lines.push([args.month, r.beneficiaryType, r.email, r.legalName, r.bankCode, r.bankName, accountNo, r.accountHolder, String(r.amount)].map(csvCell).join(","));
      total += r.amount;
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
    const storageId = await ctx.storage.store(blob);
    const url = await ctx.runMutation(internal.settlements.recordPayoutFile, {
      month: args.month,
      actorId,
      storageId,
      settlementIds: rows.map((r) => r.settlementId),
      total,
    });
    return { url, count: rows.length, total };
  },
});

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const markPaid = mutation({
  args: { month: v.string(), paidRef: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const rows = await ctx.db.query("settlements").withIndex("by_month", (q) => q.eq("month", args.month)).collect();
    const approved = rows.filter((s) => s.status === "APPROVED");
    if (approved.length === 0) fail("CONFLICT", "승인(APPROVED) 상태의 정산이 없습니다.");
    const now = Date.now();
    for (const s of approved) await ctx.db.patch(s._id, { status: "PAID", paidAt: now, paidRef: args.paidRef.trim(), updatedAt: now });
    await audit(ctx, { actorUserId: actor._id, action: "settlement.markPaid", metadata: { month: args.month, count: approved.length, paidRef: args.paidRef } });
    return { paid: approved.length };
  },
});

// ─────────────────────────────── 조회 ───────────────────────────────

const settlementView = (s: Doc<"settlements">) => ({
  _id: s._id,
  month: s.month,
  beneficiaryType: s.beneficiaryType,
  status: s.status,
  grossAmount: s.grossAmount,
  entryCount: s.entryCount,
  heldReason: s.heldReason ?? null,
  confirmedAt: s.confirmedAt ?? null,
  approvedAt: s.approvedAt ?? null,
  paidAt: s.paidAt ?? null,
  paidRef: s.paidRef ?? null,
});

/** 유저: 본인 정산 히스토리 (USER 항목만; 총판 계정이면 ADMIN 차액 정산도 함께) */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const rows = await ctx.db.query("settlements").withIndex("by_beneficiary", (q) => q.eq("beneficiaryUserId", user._id)).collect();
    return rows.sort((a, b) => b.month.localeCompare(a.month)).map(settlementView);
  },
});

async function loadStatement(ctx: QueryCtx, id: Id<"settlements">) {
  const s = await ctx.db.get(id);
  if (!s) fail("NOT_FOUND", "정산을 찾을 수 없습니다.");
  const entries = await ctx.db.query("commissionEntries").withIndex("by_settlement", (q) => q.eq("settlementId", id)).collect();
  const lines = [];
  for (const e of entries) {
    const o = await ctx.db.get(e.orderId);
    lines.push({
      entryId: e._id,
      attrangsOrderId: o?.attrangsOrderId ?? "-",
      orderedAt: o?.orderedAt ?? e.createdAt,
      attribution: e.attribution,
      baseAmount: e.baseAmount,
      rateBps: e.rateBps,
      amount: e.sign * e.amount,
      month: e.month,
    });
  }
  return { settlement: settlementView(s), beneficiaryUserId: s.beneficiaryUserId ?? null, lines: lines.sort((a, b) => a.orderedAt - b.orderedAt) };
}

/** 명세서: 본인, 소속 총판(하부 유저 것), 수퍼어드민 열람 가능 */
export const getStatement = query({
  args: { id: v.id("settlements") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const st = await loadStatement(ctx, args.id);
    if (st.settlement.beneficiaryType === "OPERATOR") {
      if (roleOf(actor) !== "SUPER_ADMIN") fail("FORBIDDEN", "권한이 없습니다.");
    } else {
      const target = st.beneficiaryUserId ? await ctx.db.get(st.beneficiaryUserId) : null;
      if (!target || !canViewUser(actor, target)) fail("FORBIDDEN", "해당 명세서에 접근할 수 없습니다.");
    }
    const beneficiary = st.beneficiaryUserId ? await ctx.db.get(st.beneficiaryUserId) : null;
    const kyc = st.beneficiaryUserId ? await ctx.db.query("kycProfiles").withIndex("by_user", (q) => q.eq("userId", st.beneficiaryUserId!)).unique() : null;
    return {
      ...st,
      beneficiary: beneficiary ? { name: beneficiary.name ?? "", email: beneficiary.email ?? "" } : null,
      payee: kyc ? { legalName: kyc.legalName, bankName: kyc.bankName, accountNoMasked: `****${kyc.accountNoLast4}` } : null,
    };
  },
});

/** 총판: 월별 본인 차액 + 하부 유저별 유저 수당. 간접구매는 총판 차액 총액에만 합산(건수 비노출). */
export const adminMonth = query({
  args: { month: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireAdminOrSuper(ctx);
    const month = args.month ?? kstMonth(Date.now());
    const team = await ctx.db.query("users").withIndex("by_parentAdmin", (q) => q.eq("parentAdminId", actor._id)).collect();
    const mine = await sumEntries(ctx, { beneficiaryUserId: actor._id, beneficiaryType: "ADMIN", month });
    const rows = [];
    for (const u of team) {
      const s = await sumEntries(ctx, { beneficiaryUserId: u._id, beneficiaryType: "USER", month });
      rows.push({ userId: u._id, name: u.name ?? "", email: u.email ?? "", userCommission: s.direct, orders: s.count });
    }
    const settlement = (await ctx.db.query("settlements").withIndex("by_beneficiary", (q) => q.eq("beneficiaryUserId", actor._id).eq("month", month)).collect()).find(
      (s) => s.beneficiaryType === "ADMIN",
    );
    return { month, adminMargin: mine.amount, adminMarginDirect: mine.direct, memberCount: team.length, rows, settlement: settlement ? settlementView(settlement) : null };
  },
});

/** 수퍼어드민: 월 전체 현황 */
export const superMonth = query({
  args: { month: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const month = args.month ?? previousMonth(kstMonth(Date.now()));
    const [user, admin, operator, meta, batch, settlements] = await Promise.all([
      sumEntries(ctx, { beneficiaryType: "USER", month }),
      sumEntries(ctx, { beneficiaryType: "ADMIN", month }),
      sumEntries(ctx, { beneficiaryType: "OPERATOR", month }),
      ctx.db.query("settlementMonths").withIndex("by_month", (q) => q.eq("month", month)).unique(),
      ctx.db.query("attrangsSettlementBatches").withIndex("by_month", (q) => q.eq("month", month)).order("desc").first(),
      ctx.db.query("settlements").withIndex("by_month", (q) => q.eq("month", month)).collect(),
    ]);
    const { tiers } = await loadRules(ctx);
    const live = await getMonthMeta(ctx, month, tiers);
    const rows = [];
    for (const s of settlements) {
      const u = s.beneficiaryUserId ? await ctx.db.get(s.beneficiaryUserId) : null;
      rows.push({ ...settlementView(s), beneficiary: u ? u.name || u.email || "" : "운영사" });
    }
    return {
      month,
      grade: live.grade,
      gradeSource: live.gradeSource,
      computationVersion: meta?.computationVersion ?? 1,
      closedAt: meta?.closedAt ?? null,
      totals: {
        user: user.amount,
        admin: admin.amount,
        operator: operator.amount,
        total: user.amount + admin.amount + operator.amount,
        directTotal: user.direct + admin.direct + operator.direct,
        indirectTotal: user.indirect + admin.indirect + operator.indirect,
      },
      batch: batch
        ? { grade: batch.grade, rateBps: batch.rateBps, payoutTotal: batch.payoutTotal, orders: batch.orders.length, reconciledAt: batch.reconciledAt ?? null, diffAmount: batch.diffAmount ?? null, diffs: batch.diffs ?? [], ourTotal: batch.ourOperatorTotal ?? null }
        : null,
      settlements: rows.sort((a, b) => a.beneficiaryType.localeCompare(b.beneficiaryType)),
    };
  },
});

export const listMonths = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const months = await ctx.db.query("settlementMonths").collect();
    const set = new Set(months.map((m) => m.month));
    const cur = kstMonth(Date.now());
    set.add(cur);
    set.add(previousMonth(cur));
    return [...set].sort().reverse();
  },
});
