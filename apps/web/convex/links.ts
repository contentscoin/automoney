import { v } from "convex/values";
import { generateCode, SHORT_CODE_LENGTH } from "@automoney/shared";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { getAttrangsAdapter } from "./lib/attrangs/mock";
import { fail } from "./lib/errors";
import { requireUser } from "./lib/rbac";

/** 링크 발급: 어댑터에서 tracking code 를 받아 저장. 상품×유저 1:1. */
export type IssuedLink = { linkId: string; shortCode: string; trackingCode: string; existed: boolean };

/** 링크 발급 본문(액션 컨텍스트): 웹 액션과 MCP `link_issue` 가 공유 */
export async function issueLinkFor(ctx: ActionCtx, userId: Id<"users">, productId: Id<"products">): Promise<IssuedLink> {
  const prep = await ctx.runQuery(internal.links.prepareIssue, { userId, productId });
  if (prep.existing) {
    return { linkId: prep.existing._id, shortCode: prep.existing.shortCode, trackingCode: prep.existing.trackingCode, existed: true };
  }
  let issued;
  try {
    issued = await getAttrangsAdapter().issueLink({
      partnerUserCode: prep.partnerCode,
      attrangsProductId: prep.product.attrangsProductId,
      detailUrl: prep.product.detailUrl,
    });
  } catch (e) {
    fail("ATTRANGS_LINK_UNAVAILABLE", `아뜨랑스 링크 발급에 실패했습니다: ${(e as Error).message}`);
  }
  const saved = await ctx.runMutation(internal.links.saveIssued, { userId, productId, trackingCode: issued.trackingCode, targetUrl: issued.landingUrl });
  return { ...saved, existed: false };
}

/** 링크 발급: 어댑터에서 tracking code 를 받아 저장. 상품×유저 1:1. */
export const issue = action({
  args: { productId: v.id("products") },
  handler: async (ctx, args): Promise<IssuedLink> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
    return await issueLinkFor(ctx, userId, args.productId);
  },
});

export const prepareIssue = internalQuery({
  args: { userId: v.id("users"), productId: v.id("products") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || (user.status ?? "ACTIVE") !== "ACTIVE") fail("FORBIDDEN", "활성 계정만 링크를 발급할 수 있습니다.");
    if (!user.partnerCode) fail("CONFLICT", "파트너 코드가 없습니다. 운영팀에 문의하세요.");
    const product = await ctx.db.get(args.productId);
    if (!product || product.status !== "ACTIVE") fail("NOT_FOUND", "판매 중인 상품이 아닙니다.");
    const existing = await ctx.db
      .query("marketingLinks")
      .withIndex("by_user_product", (q) => q.eq("userId", args.userId).eq("productId", args.productId))
      .unique();
    return { partnerCode: user.partnerCode, product, existing };
  },
});

export const saveIssued = internalMutation({
  args: { userId: v.id("users"), productId: v.id("products"), trackingCode: v.string(), targetUrl: v.string() },
  handler: async (ctx, args) => {
    const dup = await ctx.db
      .query("marketingLinks")
      .withIndex("by_user_product", (q) => q.eq("userId", args.userId).eq("productId", args.productId))
      .unique();
    if (dup) return { linkId: dup._id, shortCode: dup.shortCode, trackingCode: dup.trackingCode };
    let shortCode = "";
    for (let i = 0; i < 8; i++) {
      const candidate = generateCode(SHORT_CODE_LENGTH);
      const taken = await ctx.db
        .query("marketingLinks")
        .withIndex("by_shortCode", (q) => q.eq("shortCode", candidate))
        .unique();
      if (!taken) {
        shortCode = candidate;
        break;
      }
    }
    if (!shortCode) fail("CONFLICT", "단축 코드 생성에 실패했습니다.");
    const linkId = await ctx.db.insert("marketingLinks", {
      userId: args.userId,
      productId: args.productId,
      trackingCode: args.trackingCode,
      shortCode,
      targetUrl: args.targetUrl,
      status: "ACTIVE",
      issuedAt: Date.now(),
      clickCount: 0,
    });
    await audit(ctx, { actorUserId: args.userId, action: "link.issue", metadata: { linkId, productId: args.productId } });
    return { linkId, shortCode, trackingCode: args.trackingCode };
  },
});

export async function listLinksFor(ctx: QueryCtx, user: Doc<"users">) {
  const links = await ctx.db
    .query("marketingLinks")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .order("desc")
    .collect();
  const out = [];
  for (const l of links) {
    const product = await ctx.db.get(l.productId);
    out.push({
      _id: l._id,
      shortCode: l.shortCode,
      trackingCode: l.trackingCode,
      status: l.status,
      issuedAt: l.issuedAt,
      clickCount: l.clickCount,
      product: product
        ? { _id: product._id, name: product.name, price: product.price, salePrice: product.salePrice ?? null, imageUrl: product.imageUrls[0] ?? null }
        : null,
    });
  }
  return out;
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    return await listLinksFor(ctx, await requireUser(ctx));
  },
});

export const setStatus = mutation({
  args: { linkId: v.id("marketingLinks"), status: v.union(v.literal("ACTIVE"), v.literal("DISABLED")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const link = await ctx.db.get(args.linkId);
    if (!link || link.userId !== user._id) fail("NOT_FOUND", "링크를 찾을 수 없습니다.");
    await ctx.db.patch(args.linkId, { status: args.status });
  },
});
