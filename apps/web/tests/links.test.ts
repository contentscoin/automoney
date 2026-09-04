import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT, seedProduct, signup } from "./helpers";

describe("links & clicks", () => {
  it("issues one link per user×product and records clicks", async () => {
    const t = makeT();
    const user = await signup(t, "l1@test.com");
    const productId = await seedProduct(t);

    const first = await user.as.action(api.links.issue, { productId });
    const second = await user.as.action(api.links.issue, { productId });
    expect(first.existed).toBe(false);
    expect(second.existed).toBe(true);
    expect(second.shortCode).toBe(first.shortCode);
    expect(first.trackingCode).toMatch(/^tc_[0-9a-f]{20}$/);

    // 잘못된 시크릿은 거부
    await expect(t.mutation(api.clicks.record, { shortCode: first.shortCode, secret: "nope" })).rejects.toThrow(/잘못된/);

    const rec = await t.mutation(api.clicks.record, {
      shortCode: first.shortCode,
      secret: "redirect-secret",
      channel: "instagram",
    });
    expect(rec.found).toBe(true);
    if (rec.found) expect(rec.redirectUrl).toContain(`am_tc=${first.trackingCode}`);

    const mine = await user.as.query(api.links.listMine, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]?.clickCount).toBe(1);

    const summary = await user.as.query(api.dashboard.userSummary, {});
    expect(summary.current.clicks).toBe(1);
    expect(summary.linkCount).toBe(1);

    // 비활성 링크는 리다이렉트하지 않는다
    await user.as.mutation(api.links.setStatus, { linkId: mine[0]!._id, status: "DISABLED" });
    const gone = await t.mutation(api.clicks.record, { shortCode: first.shortCode, secret: "redirect-secret" });
    expect(gone.found).toBe(false);
  });

  it("unknown short codes are not found", async () => {
    const t = makeT();
    const r = await t.mutation(api.clicks.record, { shortCode: "NOPE123", secret: "redirect-secret" });
    expect(r.found).toBe(false);
  });
});
