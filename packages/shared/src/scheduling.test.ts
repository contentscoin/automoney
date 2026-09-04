import { describe, expect, it } from "vitest";
import { computeNextRunAt, jitterFor, kstDayKey, validatePublishPayload } from "./index";

const KST = 9 * 3600_000;
const at = (iso: string) => Date.parse(iso);

describe("computeNextRunAt", () => {
  it("daily: next slot today if later, else tomorrow (KST)", () => {
    const from = at("2026-09-04T00:00:00Z"); // 09:00 KST
    const next = computeNextRunAt({ kind: "DAILY", timeOfDay: "10:30", daysOfWeek: [], jitterMinutes: 0 }, from, "s");
    expect(new Date(next! + KST).toISOString()).toBe("2026-09-04T10:30:00.000Z");
    const later = computeNextRunAt({ kind: "DAILY", timeOfDay: "08:00", daysOfWeek: [], jitterMinutes: 0 }, from, "s");
    expect(new Date(later! + KST).toISOString()).toBe("2026-09-05T08:00:00.000Z");
  });
  it("weekly respects days of week", () => {
    const from = at("2026-09-04T00:00:00Z"); // 금요일(KST)
    const next = computeNextRunAt({ kind: "WEEKLY", timeOfDay: "12:00", daysOfWeek: [1], jitterMinutes: 0 }, from, "s");
    expect(new Date(next! + KST).getUTCDay()).toBe(1);
    expect(new Date(next! + KST).toISOString()).toBe("2026-09-07T12:00:00.000Z");
  });
  it("one shot expires", () => {
    const from = at("2026-09-04T00:00:00Z");
    expect(computeNextRunAt({ kind: "ONE_SHOT", timeOfDay: "10:00", daysOfWeek: [], jitterMinutes: 0, runDate: "2026-09-04" }, from, "s")).not.toBeNull();
    expect(computeNextRunAt({ kind: "ONE_SHOT", timeOfDay: "10:00", daysOfWeek: [], jitterMinutes: 0, runDate: "2026-09-01" }, from, "s")).toBeNull();
  });
  it("jitter is deterministic and bounded", () => {
    const a = jitterFor("space1", 1000, 15);
    expect(a).toBe(jitterFor("space1", 1000, 15));
    expect(Math.abs(a)).toBeLessThanOrEqual(15 * 60_000);
    expect(jitterFor("x", 1, 0)).toBe(0);
  });
  it("kst day key", () => {
    expect(kstDayKey(at("2026-09-04T16:00:00Z"))).toBe("2026-09-05");
  });
});

describe("validatePublishPayload", () => {
  it("enforces platform limits", () => {
    expect(validatePublishPayload({ spaceId: "s", platform: "X", text: "a".repeat(281), mediaUrls: [] })).toMatch(/exceeds/);
    expect(validatePublishPayload({ spaceId: "s", platform: "THREADS", text: "hi", mediaUrls: ["https://a/1.jpg"] })).toBeNull();
    expect(validatePublishPayload({ spaceId: "s", platform: "THREADS", text: "", mediaUrls: [] })).toMatch(/required/);
    expect(validatePublishPayload({ spaceId: "s", platform: "X", text: "x", mediaUrls: ["ftp://a"] })).toMatch(/http/);
  });
});
