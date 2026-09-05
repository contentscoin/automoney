import { v, type ObjectType } from "convex/values";
import {
  extractAtoms,
  extractMagazine,
  type ProductBrief,
} from "@automoney/shared";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireSuperAdmin, requireUser } from "./lib/rbac";

/** 수퍼어드민: URL 또는 HTML 로 매거진 등록 → 본문·이미지·상품 링크 추출 → 원자 생성 */
export const register = action({
  args: {
    url: v.optional(v.string()),
    html: v.optional(v.string()),
    title: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    magazineId: Id<"magazines">;
    atomCount: number;
    productCount: number;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
    let html = args.html ?? "";
    if (!html && args.url) {
      if (!/^https?:\/\//.test(args.url))
        fail("INVALID_ARGUMENT", "URL 형식이 올바르지 않습니다.");
      const res = await fetch(args.url, {
        headers: { "user-agent": "Mozilla/5.0 automoney-magazine-ingest" },
      });
      if (!res.ok)
        fail(
          "INVALID_ARGUMENT",
          `매거진 페이지를 가져오지 못했습니다 (${res.status})`,
        );
      html = await res.text();
    }
    if (!html) fail("INVALID_ARGUMENT", "url 또는 html 이 필요합니다.");
    if (html.length > 3_000_000)
      fail("INVALID_ARGUMENT", "HTML 이 너무 큽니다.");
    const extracted = extractMagazine(
      html,
      args.url ?? "https://attrangs.co.kr/",
    );
    if (args.title) extracted.title = args.title;
    if (!extracted.title)
      fail(
        "INVALID_ARGUMENT",
        "제목을 추출하지 못했습니다. title 을 지정하세요.",
      );
    return await ctx.runMutation(internal.magazines.saveExtracted, {
      userId,
      sourceUrl: args.url,
      extracted,
    });
  },
});

export const saveExtracted = internalMutation({
  args: {
    userId: v.id("users"),
    sourceUrl: v.optional(v.string()),
    extracted: v.any(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.userId);
    if (!actor || actor.role !== "SUPER_ADMIN")
      fail("FORBIDDEN", "권한이 없습니다.");
    const ex = args.extracted as ReturnType<typeof extractMagazine>;
    // 상품 매칭
    const products: Doc<"products">[] = [];
    for (const id of ex.productIds.slice(0, 50)) {
      const p = await ctx.db
        .query("products")
        .withIndex("by_attrangsProductId", (q) => q.eq("attrangsProductId", id))
        .unique();
      if (p) products.push(p);
    }
    const briefs: ProductBrief[] = products.map((p) => ({
      attrangsProductId: p.attrangsProductId,
      name: p.name,
      price: p.price,
      salePrice: p.salePrice ?? null,
      category: p.category ?? null,
    }));
    const atoms = extractAtoms(ex.bodyText, briefs);
    // 같은 sourceUrl 재등록 시 갱신
    const existing = args.sourceUrl
      ? await ctx.db
          .query("magazines")
          .withIndex("by_sourceUrl", (q) => q.eq("sourceUrl", args.sourceUrl))
          .unique()
      : null;
    const doc = {
      sourceUrl: args.sourceUrl,
      title: ex.title,
      description: ex.description ?? undefined,
      heroImage: ex.heroImage ?? undefined,
      imageUrls: ex.imageUrls,
      bodyText: ex.bodyText,
      attrangsProductIds: ex.productIds,
      productIds: products.map((p) => p._id),
      publishedAt: ex.publishedAt
        ? Date.parse(ex.publishedAt) || undefined
        : undefined,
      ingestedAt: Date.now(),
      createdBy: args.userId,
      atomCount: atoms.length,
      status: "ACTIVE" as const,
    };
    let magazineId: Id<"magazines">;
    if (existing) {
      magazineId = existing._id;
      await ctx.db.patch(magazineId, doc);
      for (const a of await ctx.db
        .query("contentAtoms")
        .withIndex("by_magazine", (q) => q.eq("magazineId", magazineId))
        .collect())
        await ctx.db.delete(a._id);
    } else magazineId = await ctx.db.insert("magazines", doc);
    for (const a of atoms)
      await ctx.db.insert("contentAtoms", {
        magazineId,
        atomType: a.atomType,
        text: a.text,
        attrangsProductId: a.productId ?? undefined,
        rank: a.rank,
      });
    await audit(ctx, {
      actorUserId: args.userId,
      action: "magazine.register",
      metadata: { magazineId, atoms: atoms.length, products: products.length },
    });
    return {
      magazineId,
      atomCount: atoms.length,
      productCount: products.length,
    };
  },
});

const listArgs = { limit: v.optional(v.number()) };

export async function listMagazines(ctx: QueryCtx, args: ObjectType<typeof listArgs>) {
  const rows = await ctx.db
    .query("magazines")
    .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
    .order("desc")
    .take(Math.min(args.limit ?? 30, 100));
  return rows.map((m) => ({
    _id: m._id,
    title: m.title,
    description: m.description ?? null,
    heroImage: m.heroImage ?? null,
    publishedAt: m.publishedAt ?? null,
    ingestedAt: m.ingestedAt,
    atomCount: m.atomCount,
    productCount: m.productIds.length,
    sourceUrl: m.sourceUrl ?? null,
  }));
}

export const list = query({
  args: listArgs,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await listMagazines(ctx, args);
  },
});

export const get = query({
  args: { magazineId: v.id("magazines") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const m = await ctx.db.get(args.magazineId);
    if (!m) fail("NOT_FOUND", "매거진을 찾을 수 없습니다.");
    const atoms = await ctx.db
      .query("contentAtoms")
      .withIndex("by_magazine", (q) => q.eq("magazineId", m._id))
      .collect();
    const products = [];
    for (const pid of m.productIds) {
      const p = await ctx.db.get(pid);
      if (p)
        products.push({
          _id: p._id,
          attrangsProductId: p.attrangsProductId,
          name: p.name,
          price: p.price,
          salePrice: p.salePrice ?? null,
          category: p.category ?? null,
          imageUrl: p.imageUrls[0] ?? null,
        });
    }
    return { ...m, atoms: atoms.sort((a, b) => a.rank - b.rank), products };
  },
});

export const archive = mutation({
  args: { magazineId: v.id("magazines") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    await ctx.db.patch(args.magazineId, { status: "ARCHIVED" });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "magazine.archive",
      metadata: { magazineId: args.magazineId },
    });
  },
});
