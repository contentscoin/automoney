import {
  applyRateBps,
  pickGrade,
  resolveRates,
  splitThreeLevel,
  type CommissionRule,
  type GradeTier,
} from "@automoney/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { kstMonth } from "./time";

export const COUNTED_STATUSES = new Set(["PAID", "CONFIRMED"]);
type Beneficiary = "USER" | "ADMIN" | "OPERATOR";

export function monthRange(month: string): { start: number; end: number } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  // KST 기준 월 경계 → UTC ms
  const start = Date.UTC(y, m - 1, 1) - 9 * 3600_000;
  const end = Date.UTC(y, m, 1) - 9 * 3600_000;
  return { start, end };
}

export async function loadRules(ctx: QueryCtx | MutationCtx): Promise<{ rules: CommissionRule[]; tiers: GradeTier[] }> {
  const [ruleDocs, tierDocs] = await Promise.all([ctx.db.query("commissionRules").order("asc").collect(), ctx.db.query("gradeTiers").collect()]);
  const rules: CommissionRule[] = ruleDocs.map((r) => ({
    level: r.level,
    attribution: r.attribution,
    grade: r.grade ?? null,
    rateBps: r.rateBps,
    validFrom: r.validFrom,
    validTo: r.validTo ?? null,
    scopeUserId: r.scopeUserId ?? null,
    scopeAdminId: r.scopeAdminId ?? null,
    active: r.active,
  }));
  const tiers: GradeTier[] = tierDocs.map((t) => ({ grade: t.grade, minMonthlySales: t.minMonthlySales, attrangsRateBps: t.attrangsRateBps, active: t.active }));
  return { rules, tiers };
}

/** 해당 월의 운영사 전체 수당 기준금액(직접+간접, 카운트 상태) — 그레이드 잠정 판정용 */
export async function monthlyCommissionable(ctx: QueryCtx | MutationCtx, month: string): Promise<number> {
  const stats = await ctx.db.query("userMonthlyStats").withIndex("by_month", (q) => q.eq("month", month)).collect();
  return stats.reduce((s, r) => s + r.directCommissionable + r.indirectCommissionable, 0);
}

export interface MonthMeta {
  grade: string;
  gradeSource: "PROVISIONAL" | "ATTRANGS";
  computationVersion: number;
  attrangsRateOverride: number | null;
}

/** 월 메타: 아뜨랑스 확정 그레이드가 있으면 그것, 없으면 누계 기준 잠정 그레이드 */
export async function getMonthMeta(ctx: QueryCtx | MutationCtx, month: string, tiers: GradeTier[]): Promise<MonthMeta> {
  const row = await ctx.db.query("settlementMonths").withIndex("by_month", (q) => q.eq("month", month)).unique();
  if (row && row.gradeSource === "ATTRANGS") {
    const batch = await ctx.db.query("attrangsSettlementBatches").withIndex("by_month", (q) => q.eq("month", month)).order("desc").first();
    return { grade: row.grade, gradeSource: "ATTRANGS", computationVersion: row.computationVersion, attrangsRateOverride: batch?.rateBps ?? null };
  }
  const sales = await monthlyCommissionable(ctx, month);
  const tier = pickGrade(tiers, sales);
  return { grade: tier?.grade ?? "G1", gradeSource: "PROVISIONAL", computationVersion: row?.computationVersion ?? 1, attrangsRateOverride: null };
}

interface Desired {
  beneficiaryType: Beneficiary;
  beneficiaryUserId?: Id<"users">;
  rateBps: number;
  amount: number;
}

async function desiredSplit(ctx: MutationCtx, order: Doc<"orders">, rules: CommissionRule[], tiers: GradeTier[], meta: MonthMeta): Promise<Desired[]> {
  if (!order.userId || !order.attribution || !COUNTED_STATUSES.has(order.status)) return [];
  const user = await ctx.db.get(order.userId);
  if (!user) return [];
  const adminId = user.parentAdminId ?? null;
  const rates = resolveRates(rules, tiers, {
    at: order.orderedAt,
    attribution: order.attribution,
    userId: order.userId,
    adminId,
    grade: meta.grade,
  });
  const attrangsRateBps = meta.attrangsRateOverride ?? rates.attrangsRateBps;
  const split = splitThreeLevel({
    baseAmount: order.commissionableAmount,
    attrangsRateBps,
    adminRateBps: rates.adminRateBps,
    userRateBps: rates.userRateBps,
  });
  const out: Desired[] = [
    { beneficiaryType: "USER", beneficiaryUserId: order.userId, rateBps: rates.userRateBps, amount: split.user },
    { beneficiaryType: "OPERATOR", rateBps: attrangsRateBps, amount: split.operator },
  ];
  if (adminId) out.push({ beneficiaryType: "ADMIN", beneficiaryUserId: adminId, rateBps: rates.adminRateBps ?? 0, amount: split.admin });
  return out;
}

/**
 * 주문 하나의 수수료 항목을 "원하는 상태"로 동기화한다.
 * - 미정산 항목은 삭제 후 재생성, 이미 정산에 묶인 항목은 불변.
 * - 정산된 합계와 원하는 금액의 차이만큼 델타 항목(+/−)을 남긴다 → 취소·요율 변경·그레이드 확정 모두 같은 경로.
 */
export async function syncOrderEntries(
  ctx: MutationCtx,
  order: Doc<"orders">,
  input: { rules: CommissionRule[]; tiers: GradeTier[]; meta: MonthMeta },
): Promise<void> {
  const existing = await ctx.db.query("commissionEntries").withIndex("by_order", (q) => q.eq("orderId", order._id)).collect();
  const settled = new Map<string, { amount: number; rateBps: number; attribution: Doc<"orders">["attribution"] }>();
  for (const e of existing) {
    if (e.settlementId) {
      const key = `${e.beneficiaryType}:${e.beneficiaryUserId ?? ""}`;
      const cur = settled.get(key) ?? { amount: 0, rateBps: e.rateBps, attribution: e.attribution };
      cur.amount += e.sign * e.amount;
      settled.set(key, cur);
    } else {
      await ctx.db.delete(e._id);
    }
  }
  const desired = await desiredSplit(ctx, order, input.rules, input.tiers, input.meta);
  const keys = new Set<string>([...settled.keys(), ...desired.map((d) => `${d.beneficiaryType}:${d.beneficiaryUserId ?? ""}`)]);
  const month = kstMonth(order.orderedAt);
  const now = Date.now();
  for (const key of keys) {
    const d = desired.find((x) => `${x.beneficiaryType}:${x.beneficiaryUserId ?? ""}` === key);
    const s = settled.get(key);
    const delta = (d?.amount ?? 0) - (s?.amount ?? 0);
    if (delta === 0) continue;
    const [beneficiaryType, uid] = key.split(":") as [Beneficiary, string];
    await ctx.db.insert("commissionEntries", {
      orderId: order._id,
      month,
      beneficiaryType,
      beneficiaryUserId: uid ? (uid as Id<"users">) : undefined,
      attribution: order.attribution ?? s?.attribution ?? "DIRECT",
      rateBps: d?.rateBps ?? s?.rateBps ?? 0,
      baseAmount: order.commissionableAmount,
      amount: Math.abs(delta),
      sign: delta > 0 ? 1 : -1,
      grade: input.meta.grade,
      provisional: input.meta.gradeSource !== "ATTRANGS",
      computationVersion: input.meta.computationVersion,
      createdAt: now,
    });
  }
}

/** ingest 훅용: 규칙·메타를 로드해 한 주문을 동기화 */
export async function syncOrderEntriesStandalone(ctx: MutationCtx, order: Doc<"orders">): Promise<void> {
  const { rules, tiers } = await loadRules(ctx);
  const meta = await getMonthMeta(ctx, kstMonth(order.orderedAt), tiers);
  await syncOrderEntries(ctx, order, { rules, tiers, meta });
}

/** 월 전체 재계산 (그레이드 확정·요율 변경 후). 결정론적. */
export async function recomputeMonth(ctx: MutationCtx, month: string): Promise<{ orders: number; version: number }> {
  const { rules, tiers } = await loadRules(ctx);
  const existingMeta = await ctx.db.query("settlementMonths").withIndex("by_month", (q) => q.eq("month", month)).unique();
  const version = (existingMeta?.computationVersion ?? 1) + 1;
  if (existingMeta) await ctx.db.patch(existingMeta._id, { computationVersion: version, updatedAt: Date.now() });
  else {
    const provisional = await getMonthMeta(ctx, month, tiers);
    await ctx.db.insert("settlementMonths", { month, grade: provisional.grade, gradeSource: "PROVISIONAL", computationVersion: version, updatedAt: Date.now() });
  }
  const meta = await getMonthMeta(ctx, month, tiers);
  const { start, end } = monthRange(month);
  const orders = await ctx.db.query("orders").withIndex("by_orderedAt", (q) => q.gte("orderedAt", start).lt("orderedAt", end)).collect();
  for (const o of orders) await syncOrderEntries(ctx, o, { rules, tiers, meta });
  return { orders: orders.length, version };
}

/** 월·수혜자별 미정산/전체 합계 */
export async function sumEntries(
  ctx: QueryCtx | MutationCtx,
  filter: { beneficiaryUserId?: Id<"users">; beneficiaryType?: Beneficiary; month: string; onlyUnsettled?: boolean },
): Promise<{ amount: number; count: number; direct: number; indirect: number }> {
  let rows: Doc<"commissionEntries">[];
  if (filter.beneficiaryUserId) {
    rows = await ctx.db
      .query("commissionEntries")
      .withIndex("by_beneficiary_month", (q) => q.eq("beneficiaryUserId", filter.beneficiaryUserId!).eq("month", filter.month))
      .collect();
    if (filter.beneficiaryType) rows = rows.filter((r) => r.beneficiaryType === filter.beneficiaryType);
  } else if (filter.beneficiaryType) {
    rows = await ctx.db
      .query("commissionEntries")
      .withIndex("by_type_month", (q) => q.eq("beneficiaryType", filter.beneficiaryType!).eq("month", filter.month))
      .collect();
  } else {
    rows = await ctx.db.query("commissionEntries").withIndex("by_month", (q) => q.eq("month", filter.month)).collect();
  }
  if (filter.onlyUnsettled) rows = rows.filter((r) => !r.settlementId);
  const out = { amount: 0, count: 0, direct: 0, indirect: 0 };
  for (const r of rows) {
    const v = r.sign * r.amount;
    out.amount += v;
    out.count += 1;
    if (r.attribution === "DIRECT") out.direct += v;
    else out.indirect += v;
  }
  return out;
}

export function expectedOperatorTotal(orders: { commissionableAmount: number }[], rateBps: number): number {
  return orders.reduce((s, o) => s + applyRateBps(o.commissionableAmount, rateBps), 0);
}
