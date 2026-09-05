import { v, type ObjectType } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireSuperAdmin, requireUser } from "./lib/rbac";
import {
  GOOGLE_TRENDS_KR_RSS,
  getSearchProvider,
  parseTrendsRss,
} from "./lib/search/provider";

const kindValidator = v.union(
  v.literal("MEME"),
  v.literal("TREND"),
  v.literal("PRODUCT_FACT"),
  v.literal("CELEB_MATCH"),
);
const DAY = 86_400_000;

const listArgs = {
    kind: v.optional(kindValidator),
    productId: v.optional(v.id("products")),
    limit: v.optional(v.number()),
  };

export async function listCuration(ctx: QueryCtx, args: ObjectType<typeof listArgs>) {
  let rows;
  if (args.productId)
    rows = await ctx.db
      .query("curationItems")
      .withIndex("by_product", (q) =>
        args.kind
          ? q.eq("productId", args.productId).eq("kind", args.kind)
          : q.eq("productId", args.productId),
      )
      .collect();
  else if (args.kind)
    rows = await ctx.db
      .query("curationItems")
      .withIndex("by_kind", (q) =>
        q.eq("kind", args.kind!).eq("status", "ACTIVE"),
      )
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
  else
    rows = await ctx.db
      .query("curationItems")
      .order("desc")
      .take(Math.min(args.limit ?? 100, 300));
  const now = Date.now();
  return rows
    .filter(
      (r) => r.status === "ACTIVE" && (!r.expiresAt || r.expiresAt > now),
    )
    .sort((a, b) => b.score - a.score || b.fetchedAt - a.fetchedAt);
}

export const list = query({
  args: listArgs,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await listCuration(ctx, args);
  },
});

const itemValidator = v.object({
  kind: kindValidator,
  title: v.string(),
  body: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  mediaUrl: v.optional(v.string()),
  productId: v.optional(v.id("products")),
  licenseNote: v.optional(v.string()),
  score: v.number(),
  source: v.string(),
  dedupeKey: v.string(),
  ttlDays: v.optional(v.number()),
});
type UpsertItem = typeof itemValidator.type;

export async function upsertCuration(
  ctx: MutationCtx,
  items: UpsertItem[],
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  const now = Date.now();
  for (const it of items) {
    const { ttlDays, ...rest } = it;
    const doc = {
      ...rest,
      fetchedAt: now,
      expiresAt: ttlDays ? now + ttlDays * DAY : undefined,
      status: "ACTIVE" as const,
    };
    const existing = await ctx.db
      .query("curationItems")
      .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", it.dedupeKey))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      updated++;
    } else {
      await ctx.db.insert("curationItems", doc);
      inserted++;
    }
  }
  return { inserted, updated };
}

export const upsertItems = internalMutation({
  args: { items: v.array(itemValidator) },
  handler: async (ctx, args) => upsertCuration(ctx, args.items),
});

/** 구글 트렌드(KR) RSS → TREND 항목. 크론 6시간 + 수퍼어드민 수동 */
export const refreshTrends = internalAction({
  args: { xml: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ inserted: number; updated: number; count: number }> => {
    let xml = args.xml;
    if (!xml) {
      const res = await fetch(GOOGLE_TRENDS_KR_RSS, {
        headers: { "user-agent": "Mozilla/5.0 automoney-trends" },
      });
      if (!res.ok) throw new Error(`trends rss ${res.status}`);
      xml = await res.text();
    }
    const items = parseTrendsRss(xml).slice(0, 30);
    const r = await ctx.runMutation(internal.curation.upsertItems, {
      items: items.map((t, i) => ({
        kind: "TREND" as const,
        title: t.title,
        body:
          [t.newsTitle, t.traffic ? `검색량 ${t.traffic}` : null]
            .filter(Boolean)
            .join(" · ") || undefined,
        sourceUrl: t.newsUrl ?? t.link ?? undefined,
        score: Math.max(1, 100 - i * 3),
        source: "google-trends-kr",
        dedupeKey: `trend:${t.title.toLowerCase()}`,
        ttlDays: 2,
      })),
    });
    return { ...r, count: items.length };
  },
});

export const refreshTrendsNow = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ inserted: number; updated: number; count: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
    const ok = await ctx.runQuery(internal.curation.isSuper, { userId });
    if (!ok) fail("FORBIDDEN", "권한이 없습니다.");
    return await ctx.runAction(internal.curation.refreshTrends, {});
  },
});

export const isSuper = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) =>
    (await ctx.db.get(args.userId))?.role === "SUPER_ADMIN",
});

/** 제품 정보 팩: 카탈로그 필드로 규칙 기반 핵심 포인트·FAQ 생성 */
export const buildProductFacts = mutation({
  args: { productId: v.id("products") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get(args.productId);
    if (!p) fail("NOT_FOUND", "상품을 찾을 수 없습니다.");
    const discount =
      p.salePrice && p.salePrice < p.price
        ? Math.round((1 - p.salePrice / p.price) * 100)
        : 0;
    const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
    const facts = [
      {
        key: "price",
        title: "가격",
        body: p.salePrice
          ? `${won(p.salePrice)} (정가 ${won(p.price)}${discount ? `, ${discount}% 할인` : ""})`
          : won(p.price),
      },
      {
        key: "category",
        title: "카테고리",
        body: `${p.category ?? "의류"} · 아뜨랑스 자체제작 라인`,
      },
      {
        key: "delivery",
        title: "배송·교환",
        body: "오늘출발 대상 상품은 당일 출고, 사이즈 교환 무료(아뜨랑스 정책 기준)",
      },
      {
        key: "faq",
        title: "자주 묻는 질문",
        body: `Q. 어떤 사이즈가 맞을까요? → 상세 페이지의 실측 사이즈표를 확인하세요.\nQ. 세탁은? → 상품 상세의 소재·세탁 안내를 따르세요.`,
      },
      {
        key: "link",
        title: "구매 안내",
        body: `상세 정보와 구매는 링크에서: ${p.detailUrl}`,
      },
    ];
    const r = await upsertCuration(
      ctx,
      facts.map((f, i) => ({
        kind: "PRODUCT_FACT" as const,
        title: `${p.name} · ${f.title}`,
        body: f.body,
        sourceUrl: p.detailUrl,
        productId: p._id,
        score: 100 - i,
        source: "catalog",
        dedupeKey: `fact:${p._id}:${f.key}`,
      })),
    );
    await audit(ctx, {
      actorUserId: user._id,
      action: "curation.productFacts",
      metadata: { productId: p._id, ...r },
    });
    return r;
  },
});

/** 연예인 착용·이슈 검색: SearchProvider 가 있으면 출처 링크만 저장(이미지 재게시 금지 라벨) */
export const celebMatch = action({
  args: { productId: v.id("products") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    provider: string;
    found: number;
    inserted: number;
    updated: number;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
    const product = await ctx.runQuery(internal.curation.productBrief, {
      productId: args.productId,
    });
    if (!product) fail("NOT_FOUND", "상품을 찾을 수 없습니다.");
    const provider = getSearchProvider();
    if (!provider.available)
      return { provider: provider.name, found: 0, inserted: 0, updated: 0 };
    const results = await provider.search(
      `${product.name} 착용 연예인 공항패션`,
      { limit: 8 },
    );
    const r = await ctx.runMutation(internal.curation.upsertItems, {
      items: results.map((s, i) => ({
        kind: "CELEB_MATCH" as const,
        title: s.title.slice(0, 120),
        body: s.snippet.slice(0, 300),
        sourceUrl: s.url,
        mediaUrl: undefined,
        productId: args.productId,
        licenseNote:
          "출처 링크·텍스트 인용만 허용. 이미지 재게시 금지(초상권·저작권)",
        score: 90 - i * 5,
        source: provider.name,
        dedupeKey: `celeb:${args.productId}:${s.url}`,
        ttlDays: 30,
      })),
    });
    return { provider: provider.name, found: results.length, ...r };
  },
});

export const productBrief = internalQuery({
  args: { productId: v.id("products") },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.productId);
    return p ? { name: p.name, detailUrl: p.detailUrl } : null;
  },
});

/** 수퍼어드민: 짤·트렌드·연예인 수동 등록 (라이선스 라벨 필수) */
export const addManual = mutation({
  args: {
    kind: kindValidator,
    title: v.string(),
    body: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    productId: v.optional(v.id("products")),
    licenseNote: v.string(),
    ttlDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (!args.title.trim()) fail("INVALID_ARGUMENT", "제목을 입력하세요.");
    if (!args.licenseNote.trim())
      fail("INVALID_ARGUMENT", "라이선스/출처 메모를 입력하세요.");
    if (args.mediaUrl && !/^https?:\/\//.test(args.mediaUrl))
      fail("INVALID_ARGUMENT", "미디어 URL 형식이 올바르지 않습니다.");
    const r = await upsertCuration(ctx, [
      {
        kind: args.kind,
        title: args.title.trim(),
        body: args.body?.trim() || undefined,
        sourceUrl: args.sourceUrl || undefined,
        mediaUrl: args.mediaUrl || undefined,
        productId: args.productId,
        licenseNote: args.licenseNote.trim(),
        score: 80,
        source: "manual",
        dedupeKey: `manual:${args.kind}:${args.title.trim().toLowerCase()}`,
        ttlDays: args.ttlDays,
      },
    ]);
    await audit(ctx, {
      actorUserId: actor._id,
      action: "curation.addManual",
      metadata: { kind: args.kind, title: args.title },
    });
    return r;
  },
});

export const hide = mutation({
  args: { id: v.id("curationItems") },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    await ctx.db.patch(args.id, { status: "HIDDEN" });
  },
});

export const providerStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const p = getSearchProvider();
    return {
      name: p.name,
      available: p.available,
      trendsSource: GOOGLE_TRENDS_KR_RSS,
    };
  },
});

export type CurationId = Id<"curationItems">;
