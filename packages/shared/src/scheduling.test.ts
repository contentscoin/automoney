import { describe, expect, it } from "vitest";
import { computeNextRunAt, jitterFor, kstDayKey, validateContentMedia, validatePublishPayload } from "./index";

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
    expect(validatePublishPayload({ spaceId: "s", platform: "X", text: "x", mediaUrls: ["http://a/1.jpg"] })).toMatch(/https/);
    expect(validatePublishPayload({ spaceId: "s", platform: "INSTAGRAM", text: "x", mediaUrls: [] })).toMatch(/requires media/);
    expect(validatePublishPayload({ spaceId: "s", platform: "TIKTOK", text: "x", mediaUrls: ["https://a/1.jpg"] })).toMatch(/requires a verifiable video/);
    expect(validatePublishPayload({ spaceId: "s", platform: "TIKTOK", text: "x", mediaUrls: ["https://a/media"] })).toMatch(/requires a verifiable video/);
    expect(validatePublishPayload({ spaceId: "s", platform: "TIKTOK", text: "x", mediaUrls: ["https://a/1.mp4"] })).toBeNull();
    expect(validatePublishPayload({ spaceId: "s", platform: "INSTAGRAM", contentChannel: "INSTAGRAM_REEL", text: "x", mediaUrls: ["https://a/1.jpg"] })).toMatch(/requires a verifiable video/);
    expect(validatePublishPayload({ spaceId: "s", platform: "INSTAGRAM", contentChannel: "INSTAGRAM_REEL", text: "x", mediaUrls: ["https://a/1.mp4"] })).toBeNull();
  });
});

describe("validateContentMedia", () => {
  const images = (count: number) => Array.from({ length: count }, (_, index) => `https://cdn.example.com/${index}.jpg`);
  const videos = (count: number) => Array.from({ length: count }, (_, index) => `https://cdn.example.com/${index}.mp4`);

  it("requires one to ten verifiable images for an Instagram feed", () => {
    expect(validateContentMedia("INSTAGRAM_FEED", [])).toMatch(/1 and 10 images/);
    expect(validateContentMedia("INSTAGRAM_FEED", images(1))).toBeNull();
    expect(validateContentMedia("INSTAGRAM_FEED", images(10))).toBeNull();
    expect(validateContentMedia("INSTAGRAM_FEED", images(11))).toMatch(/at most 10/);
    expect(validateContentMedia("INSTAGRAM_FEED", videos(1))).toMatch(/image URLs/);
    expect(validateContentMedia("INSTAGRAM_FEED", ["https://cdn.example.com/media"])).toMatch(/image URLs/);
  });

  it("applies the X and Threads platform media limits", () => {
    expect(validateContentMedia("X", [])).toBeNull();
    expect(validateContentMedia("X", [...images(2), ...videos(2)])).toBeNull();
    expect(validateContentMedia("X", images(5))).toMatch(/at most 4/);
    expect(validateContentMedia("THREADS", [...images(5), ...videos(5)])).toBeNull();
    expect(validateContentMedia("THREADS", images(11))).toMatch(/at most 10/);
    expect(validateContentMedia("THREADS", ["http://cdn.example.com/1.jpg"])).toMatch(/https/);
    expect(validateContentMedia("X", ["https://cdn.example.com/media"])).toMatch(/verifiable/);
  });

  it("requires exactly one verifiable video for Reels and TikTok", () => {
    for (const channel of ["INSTAGRAM_REEL", "TIKTOK"] as const) {
      expect(validateContentMedia(channel, [])).toMatch(/exactly one video/);
      expect(validateContentMedia(channel, videos(1))).toBeNull();
      expect(validateContentMedia(channel, videos(2))).toMatch(/exactly one video/);
      expect(validateContentMedia(channel, images(1))).toMatch(/verifiable video/);
      expect(validateContentMedia(channel, ["https://cdn.example.com/media"])).toMatch(/verifiable video/);
    }
  });

  it("matches the Naver Blog limit and accepts images only", () => {
    expect(validateContentMedia("BLOG", [])).toBeNull();
    expect(validateContentMedia("BLOG", images(30))).toBeNull();
    expect(validateContentMedia("BLOG", images(31))).toMatch(/at most 30/);
    expect(validateContentMedia("BLOG", videos(1))).toMatch(/does not accept video/);
    expect(validateContentMedia("BLOG", ["https://cdn.example.com/media"])).toMatch(/verifiable/);
  });
});
