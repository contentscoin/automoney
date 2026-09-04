import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT, signup } from "./helpers";

describe("products", () => {
  it("imports csv (super admin only) and searches", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const user = await signup(t, "p1@test.com");
    const csv = [
      "product_id,name,price,sale_price,category,image_urls,detail_url,status",
      "200001,플라워 원피스,39000,35000,원피스,https://a/1.jpg,https://attrangs.co.kr/shop/view.php?index_no=200001,active",
      "200002,베이직 니트,32000,,니트,,https://attrangs.co.kr/shop/view.php?index_no=200002,inactive",
    ].join("\n");
    await expect(user.as.mutation(api.products.importCsv, { csv })).rejects.toThrow(/권한/);
    const r = await owner.as.mutation(api.products.importCsv, { csv });
    expect(r).toMatchObject({ inserted: 2, updated: 0 });
    const again = await owner.as.mutation(api.products.importCsv, { csv });
    expect(again).toMatchObject({ inserted: 0, updated: 2 });

    const all = await user.as.query(api.products.search, {});
    expect(all.map((p) => p.attrangsProductId)).toEqual([200001]);
    const found = await user.as.query(api.products.search, { term: "플라워" });
    expect(found).toHaveLength(1);
  });

  it("syncs from the mock adapter", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const r = await owner.as.action(api.products.syncFromAttrangs, {});
    expect(r.inserted).toBe(8);
    const user = await signup(t, "p2@test.com");
    await expect(user.as.action(api.products.syncFromAttrangs, {})).rejects.toThrow(/권한/);
  });
});
