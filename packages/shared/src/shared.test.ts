import { describe, expect, it } from "vitest";
import {
  applyRateBps,
  estimateUserCommission,
  generateCode,
  isValidCode,
  normalizeCode,
  parseAttrangsOrderWebhook,
  parseCsv,
  parseProductCsv,
  resolveAttribution,
  splitThreeLevel,
} from "./index";

describe("shortcode", () => {
  it("generates codes from the safe alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const c = generateCode(7);
      expect(isValidCode(c, 7)).toBe(true);
    }
  });
  it("normalizes confusable characters", () => {
    expect(normalizeCode(" ab-0l1 ")).toBe("ABL");
  });
});

describe("commission", () => {
  it("floors to won", () => {
    expect(applyRateBps(35000, 500)).toBe(1750);
    expect(applyRateBps(33333, 333)).toBe(1109);
    expect(estimateUserCommission(0, 500)).toBe(0);
  });
  it("rejects invalid rates", () => {
    expect(() => applyRateBps(100, 10001)).toThrow();
    expect(() => applyRateBps(100, -1)).toThrow();
    expect(() => applyRateBps(100, 1.5)).toThrow();
  });
  it("splits three levels with remainder to operator", () => {
    const s = splitThreeLevel({ baseAmount: 100000, attrangsRateBps: 2000, adminRateBps: 1200, userRateBps: 800 });
    expect(s).toEqual({ user: 8000, admin: 4000, operator: 8000, total: 20000 });
    const direct = splitThreeLevel({ baseAmount: 100000, attrangsRateBps: 2000, adminRateBps: null, userRateBps: 800 });
    expect(direct).toEqual({ user: 8000, admin: 0, operator: 12000, total: 20000 });
  });
});

describe("attrangs webhook", () => {
  const valid = {
    event_id: "evt_1",
    event_type: "order.created",
    occurred_at: "2026-09-04T12:00:00+09:00",
    order: {
      order_id: "A1",
      ordered_at: "2026-09-04T12:00:00+09:00",
      tracking_code: "tc_x",
      attribution: "direct",
      clicked_at: "2026-09-04T11:00:00+09:00",
      landing_product_id: 12345,
      items: [{ product_id: 12345, qty: 1, amount: 39000, commissionable_amount: 35000 }],
      order_amount: 39000,
      commissionable_amount: 35000,
      status: "paid",
    },
  };
  it("parses a valid payload", () => {
    const r = parseAttrangsOrderWebhook(valid);
    expect(r.ok).toBe(true);
  });
  it("rejects malformed payloads", () => {
    expect(parseAttrangsOrderWebhook({ ...valid, event_type: "x" }).ok).toBe(false);
    expect(parseAttrangsOrderWebhook({ ...valid, order: { ...valid.order, items: [] } }).ok).toBe(false);
    expect(parseAttrangsOrderWebhook(null).ok).toBe(false);
  });
  it("re-validates the 24h window", () => {
    expect(
      resolveAttribution({ attribution: "indirect", clickedAt: "2026-09-04T00:00:00Z", orderedAt: "2026-09-04T23:59:00Z" }),
    ).toBe("INDIRECT");
    expect(
      resolveAttribution({ attribution: "direct", clickedAt: "2026-09-03T00:00:00Z", orderedAt: "2026-09-04T23:59:00Z" }),
    ).toBeNull();
    expect(resolveAttribution({ attribution: "direct", clickedAt: null, orderedAt: "2026-09-04T00:00:00Z" })).toBeNull();
  });
});

describe("csv", () => {
  it("parses quoted fields and CRLF", () => {
    expect(parseCsv('a,"b,c","d""e"\r\n1,2,3\n')).toEqual([
      ["a", "b,c", 'd"e'],
      ["1", "2", "3"],
    ]);
  });
  it("parses product csv with errors", () => {
    const text = [
      "product_id,name,price,sale_price,category,image_urls,detail_url,status",
      '12345,"플라워 원피스",39000,35000,원피스,https://a/1.jpg|https://a/2.jpg,https://attrangs.co.kr/shop/view.php?index_no=12345,active',
      "x,bad,1,,,,https://attrangs.co.kr/,",
    ].join("\n");
    const { rows, errors } = parseProductCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.imageUrls).toHaveLength(2);
    expect(rows[0]?.status).toBe("ACTIVE");
    expect(errors).toHaveLength(1);
  });
});
