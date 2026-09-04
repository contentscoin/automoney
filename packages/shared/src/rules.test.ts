import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMISSION_RULES,
  DEFAULT_GRADE_TIERS,
  buildAttrangsSettlementCsv,
  parseAttrangsSettlementCsv,
  pickGrade,
  resolveRates,
  splitThreeLevel,
  type CommissionRule,
} from "./index";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const rules: CommissionRule[] = DEFAULT_COMMISSION_RULES.map((r) => ({ ...r, validFrom: T0 }));
const base = { at: Date.parse("2026-09-04T00:00:00Z"), userId: "u1", adminId: "a1", grade: "G1" } as const;

describe("resolveRates", () => {
  it("uses defaults: direct 5%/8%/15%, indirect user 0", () => {
    const d = resolveRates(rules, DEFAULT_GRADE_TIERS, { ...base, attribution: "DIRECT" });
    expect([d.attrangsRateBps, d.adminRateBps, d.userRateBps]).toEqual([1500, 800, 500]);
    const i = resolveRates(rules, DEFAULT_GRADE_TIERS, { ...base, attribution: "INDIRECT" });
    expect([i.attrangsRateBps, i.adminRateBps, i.userRateBps]).toEqual([1500, 300, 0]);
  });
  it("prefers user-scoped over admin-scoped over global, respects validity", () => {
    const extra: CommissionRule[] = [
      ...rules,
      { level: "ADMIN_TO_USER", attribution: "ANY", rateBps: 600, validFrom: T0, scopeAdminId: "a1", active: true },
      { level: "ADMIN_TO_USER", attribution: "DIRECT", rateBps: 700, validFrom: T0, scopeUserId: "u1", active: true },
      { level: "ADMIN_TO_USER", attribution: "DIRECT", rateBps: 900, validFrom: T0, validTo: T0 + 1, scopeUserId: "u1", active: true },
      { level: "ADMIN_TO_USER", attribution: "DIRECT", rateBps: 950, validFrom: T0, scopeUserId: "u1", active: false },
    ];
    expect(resolveRates(extra, DEFAULT_GRADE_TIERS, { ...base, attribution: "DIRECT" }).userRateBps).toBe(700);
    expect(resolveRates(extra, DEFAULT_GRADE_TIERS, { ...base, attribution: "INDIRECT" }).userRateBps).toBe(600);
    expect(resolveRates(extra, DEFAULT_GRADE_TIERS, { ...base, userId: "u2", adminId: "a2", attribution: "DIRECT" }).userRateBps).toBe(500);
  });
  it("returns null admin rate when the user has no admin, and grade drives attrangs rate", () => {
    const r = resolveRates(rules, DEFAULT_GRADE_TIERS, { ...base, adminId: null, attribution: "DIRECT", grade: "G3" });
    expect(r.adminRateBps).toBeNull();
    expect(r.attrangsRateBps).toBe(2000);
    const s = splitThreeLevel({ baseAmount: 100000, attrangsRateBps: r.attrangsRateBps, adminRateBps: r.adminRateBps, userRateBps: r.userRateBps });
    expect(s).toEqual({ user: 5000, admin: 0, operator: 15000, total: 20000 });
  });
});

describe("pickGrade", () => {
  it("selects by threshold", () => {
    expect(pickGrade(DEFAULT_GRADE_TIERS, 0)?.grade).toBe("G1");
    expect(pickGrade(DEFAULT_GRADE_TIERS, 30_000_000)?.grade).toBe("G2");
    expect(pickGrade(DEFAULT_GRADE_TIERS, 250_000_000)?.grade).toBe("G3");
  });
});

describe("settlement csv", () => {
  it("round-trips", () => {
    const csv = buildAttrangsSettlementCsv({
      month: "2026-08",
      grade: "G2",
      rateBps: 1800,
      payoutTotal: 12600,
      orders: [
        { orderId: "A1", commissionableAmount: 35000, attribution: "DIRECT", status: "CONFIRMED" },
        { orderId: "A2", commissionableAmount: 35000, attribution: "INDIRECT", status: "CONFIRMED" },
      ],
    });
    const p = parseAttrangsSettlementCsv(csv);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.batch.grade).toBe("G2");
      expect(p.batch.orders).toHaveLength(2);
    }
    expect(parseAttrangsSettlementCsv("month,grade\n2026-08,G1").ok).toBe(false);
  });
});
