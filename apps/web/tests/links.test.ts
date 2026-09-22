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
    expect(mine[0]?.origin).toBe("MOCK");
    expect(mine[0]?.targetUrl).toContain("attrangs.co.kr");

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

  it("issues up to ten product links as one workflow batch", async () => {
    const t = makeT();
    const user = await signup(t, "batch-links@test.com");
    const first = await seedProduct(t, 210001);
    const second = await seedProduct(t, 210002);
    const result = await user.as.action(api.links.issueMany, { productIds: [first, second] });
    expect(result).toMatchObject({ total: 2, issued: 2, existed: 0 });
    expect((await user.as.query(api.links.listMine, {}))).toHaveLength(2);
    expect(await user.as.action(api.links.issueMany, { productIds: [first, second] })).toMatchObject({ total: 2, issued: 0, existed: 2 });
    const firstLink = (await user.as.query(api.links.listMine, {})).find((link) => link.product?._id === first)!;
    await user.as.mutation(api.links.setStatus, { linkId: firstLink._id, status: "DISABLED" });
    expect(await user.as.action(api.links.issueMany, { productIds: [first] })).toMatchObject({ issued: 0, existed: 1, reactivated: 1 });
    expect((await user.as.query(api.links.listMine, {})).find((link) => link._id === firstLink._id)?.status).toBe("ACTIVE");
    await expect(user.as.action(api.links.issueMany, { productIds: [] })).rejects.toThrow(/하나 이상/);
    await expect(user.as.action(api.links.issueMany, { productIds: Array(11).fill(first) })).rejects.toThrow(/최대 10개/);
  });

  it("previews and resumes link-pool imports; real mode never falls back to mock", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const firstUser = await signup(t, "pool1@test.com");
    const secondUser = await signup(t, "pool2@test.com");
    const emptyUser = await signup(t, "pool3@test.com");
    const productId = await seedProduct(t, 200001);
    const csv = "external_product_id,tracking_code,target_url\n200001,pool-a,https://partner.test/a\n200001,pool-b,https://partner.test/b";
    const preview = await owner.as.mutation(api.imports.previewLinkPool, { csv, sourceVersion: "sample-v1" });
    expect(preview).toMatchObject({ duplicate: false, validRows: 2, errorRows: 0, status: "VALIDATED" });
    expect(await owner.as.mutation(api.imports.applyLinkPool, { batchId: preview.batchId })).toMatchObject({ completed: true, applied: 2 });
    expect(await owner.as.mutation(api.imports.applyLinkPool, { batchId: preview.batchId })).toMatchObject({ completed: true, applied: 0 });
    expect((await owner.as.mutation(api.imports.previewLinkPool, { csv })).duplicate).toBe(true);
    process.env.ATTRANGS_MODE = "pool";
    try {
      expect((await firstUser.as.action(api.links.issue, { productId })).trackingCode).toBe("pool-a");
      expect((await secondUser.as.action(api.links.issue, { productId })).trackingCode).toBe("pool-b");
      expect((await firstUser.as.query(api.links.listMine, {}))[0]?.origin).toBe("POOL");
      await expect(emptyUser.as.action(api.links.issue, { productId })).rejects.toThrow(/소진/);
    } finally {
      delete process.env.ATTRANGS_MODE;
    }
  });
});
