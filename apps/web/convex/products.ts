import { v, type ObjectType } from "convex/values";
import { parseProductCsv } from "@automoney/shared";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { audit } from "./lib/audit";
import type { AttrangsProduct } from "./lib/attrangs/adapter";
import { getAttrangsAdapter } from "./lib/attrangs/mock";
import { fail } from "./lib/errors";
import { requireSuperAdmin, requireUser } from "./lib/rbac";
import { productStatusValidator } from "./schema";

const productInput = v.object({
  attrangsProductId: v.number(),
  name: v.string(),
  price: v.number(),
  salePrice: v.union(v.number(), v.null()),
  category: v.union(v.string(), v.null()),
  imageUrls: v.array(v.string()),
  detailUrl: v.string(),
  status: productStatusValidator,
});

const searchArgs = { term: v.optional(v.string()), limit: v.optional(v.number()) };

export async function searchProducts(ctx: QueryCtx, args: ObjectType<typeof searchArgs>) {
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
  const term = args.term?.trim();
  if (term) {
    return await ctx.db
      .query("products")
      .withSearchIndex("search_name", (q) => q.search("name", term).eq("status", "ACTIVE"))
      .take(limit);
  }
  return await ctx.db
    .query("products")
    .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
    .order("desc")
    .take(limit);
}

export const search = query({
  args: searchArgs,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await searchProducts(ctx, args);
  },
});

export const get = query({
  args: { productId: v.id("products") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.productId);
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    return await ctx.db.query("products").order("desc").take(500);
  },
});

/** 수퍼어드민 CSV 임포트 (docs/04 §1.7 폴백). */
export const importCsv = mutation({
  args: { csv: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (args.csv.length > 2_000_000) fail("INVALID_ARGUMENT", "CSV 는 2MB 이하여야 합니다.");
    const { rows, errors } = parseProductCsv(args.csv);
    if (rows.length === 0) fail("INVALID_ARGUMENT", `유효한 행이 없습니다. ${errors[0] ?? ""}`);
    const result = await upsertProducts(ctx, rows, "CSV");
    await audit(ctx, { actorUserId: actor._id, action: "products.importCsv", metadata: { ...result, errors: errors.length } });
    return { ...result, errors };
  },
});

/** 어댑터(Mock/API) 동기화. */
export const syncFromAttrangs = action({
  args: {},
  handler: async (ctx): Promise<{ inserted: number; updated: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
    const products = await getAttrangsAdapter().listProducts({});
    return await ctx.runMutation(internal.products.upsertMany, { userId, products, source: "MOCK" });
  },
});

export const upsertMany = internalMutation({
  args: {
    userId: v.id("users"),
    products: v.array(productInput),
    source: v.union(v.literal("CSV"), v.literal("MOCK"), v.literal("API")),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.userId);
    if (!actor || actor.role !== "SUPER_ADMIN") fail("FORBIDDEN", "권한이 없습니다.");
    const result = await upsertProducts(ctx, args.products, args.source);
    await audit(ctx, { actorUserId: actor._id, action: "products.sync", metadata: { source: args.source, ...result } });
    return result;
  },
});

async function upsertProducts(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  rows: AttrangsProduct[],
  source: "CSV" | "MOCK" | "API",
) {
  let inserted = 0;
  let updated = 0;
  const now = Date.now();
  for (const p of rows) {
    const existing = await ctx.db
      .query("products")
      .withIndex("by_attrangsProductId", (q) => q.eq("attrangsProductId", p.attrangsProductId))
      .unique();
    const doc = {
      attrangsProductId: p.attrangsProductId,
      name: p.name,
      price: p.price,
      salePrice: p.salePrice ?? undefined,
      category: p.category ?? undefined,
      imageUrls: p.imageUrls,
      detailUrl: p.detailUrl,
      status: p.status,
      syncedAt: now,
      source,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      updated++;
    } else {
      await ctx.db.insert("products", doc);
      inserted++;
    }
  }
  return { inserted, updated };
}
