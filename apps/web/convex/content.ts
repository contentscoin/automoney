import { v } from "convex/values";
import {
  CHANNELS,
  evaluatePiece,
  isAutoApprovable,
  type Channel,
  type ContentGeneratePayload,
  type GeneratedPiece,
  type ProductBrief,
} from "@automoney/shared";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireSuperAdmin, requireUser, roleOf } from "./lib/rbac";
import { enqueueJob } from "./jobs";

const channelValidator = v.union(
  v.literal("INSTAGRAM_FEED"),
  v.literal("INSTAGRAM_REEL"),
  v.literal("THREADS"),
  v.literal("X"),
  v.literal("TIKTOK"),
  v.literal("BLOG"),
);

/** 유저: 매거진 또는 상품 기준으로 채널별 콘텐츠 생성 요청 → 내 PC 의 Codex 가 수행 */
export const requestGenerate = mutation({
  args: {
    magazineId: v.optional(v.id("magazines")),
    productId: v.optional(v.id("products")),
    channels: v.array(channelValidator),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.channels.length === 0)
      fail("INVALID_ARGUMENT", "채널을 하나 이상 선택하세요.");
    if (!args.magazineId && !args.productId)
      fail("INVALID_ARGUMENT", "매거진 또는 상품을 선택하세요.");
    const device = (
      await ctx.db
        .query("devices")
        .withIndex("by_user", (q) =>
          q.eq("userId", user._id).eq("status", "ACTIVE"),
        )
        .collect()
    )[0];
    if (!device)
      fail(
        "CONFLICT",
        "콘텐츠 생성은 내 PC 의 에이전트(Codex)가 수행합니다. 먼저 데스크톱 에이전트를 페어링하세요.",
      );

    const atoms: ContentGeneratePayload["atoms"] = [];
    const products: ProductBrief[] = [];
    let magazineTitle: string | null = null;
    if (args.magazineId) {
      const m = await ctx.db.get(args.magazineId);
      if (!m || m.status !== "ACTIVE")
        fail("NOT_FOUND", "매거진을 찾을 수 없습니다.");
      magazineTitle = m.title;
      for (const a of await ctx.db
        .query("contentAtoms")
        .withIndex("by_magazine", (q) => q.eq("magazineId", m._id))
        .collect())
        atoms.push({
          atomType: a.atomType,
          text: a.text,
          productId: a.attrangsProductId ?? null,
          rank: a.rank,
        });
      for (const pid of m.productIds.slice(0, 5)) {
        const p = await ctx.db.get(pid);
        if (p) products.push(brief(p));
      }
    }
    if (args.productId) {
      const p = await ctx.db.get(args.productId);
      if (!p) fail("NOT_FOUND", "상품을 찾을 수 없습니다.");
      if (!products.some((b) => b.attrangsProductId === p.attrangsProductId))
        products.unshift(brief(p));
      // 상품만 있는 경우 큐레이션 제품 정보를 원자로 보강
      const facts = await ctx.db
        .query("curationItems")
        .withIndex("by_product", (q) =>
          q.eq("productId", p._id).eq("kind", "PRODUCT_FACT"),
        )
        .collect();
      for (const f of facts)
        if (f.body)
          atoms.push({
            atomType: "PRODUCT_POINT",
            text: f.body,
            productId: p.attrangsProductId,
            rank: atoms.length + 1,
          });
    }
    const payload: ContentGeneratePayload = {
      channels: args.channels,
      atoms: atoms.slice(0, 20),
      products,
      magazineId: args.magazineId ?? null,
      magazineTitle,
      brand: "아뜨랑스",
    };
    const jobId = await enqueueJob(ctx, {
      userId: user._id,
      jobType: "content.generate",
      payload: payload as unknown as Record<string, unknown>,
      source: "WEB",
    });
    await audit(ctx, {
      actorUserId: user._id,
      action: "content.requestGenerate",
      metadata: {
        jobId,
        channels: args.channels,
        magazineId: args.magazineId ?? null,
        productId: args.productId ?? null,
      },
    });
    return jobId;
  },
});

function brief(p: Doc<"products">): ProductBrief {
  return {
    attrangsProductId: p.attrangsProductId,
    name: p.name,
    price: p.price,
    salePrice: p.salePrice ?? null,
    category: p.category ?? null,
  };
}

/** 에이전트 결과 수신(agent.completeJob 훅): 품질 게이트 → 라이브러리 저장 */
export const ingestGenerated = internalMutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => ingestGeneratedJob(ctx, args.jobId),
});

/** content.generate 잡 성공 결과 → 품질 게이트 → 라이브러리 저장 (agent.completeJob 에서 직접 호출) */
export async function ingestGeneratedJob(
  ctx: MutationCtx,
  jobId: Id<"agentJobs">,
): Promise<{ saved: number; approved: number; duplicate?: boolean }> {
  const job = await ctx.db.get(jobId);
  if (!job || job.jobType !== "content.generate" || job.status !== "SUCCEEDED")
    return { saved: 0, approved: 0 };
  const dup = await ctx.db
    .query("contentPieces")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .first();
  if (dup) return { saved: 0, approved: 0, duplicate: true };
  const data = (
    job.result as
      | { data?: { pieces?: GeneratedPiece[]; generatedBy?: string } }
      | undefined
  )?.data;
  const pieces = Array.isArray(data?.pieces) ? data!.pieces! : [];
  const payload = job.payload as ContentGeneratePayload;
  const generatedBy = data?.generatedBy === "codex" ? "codex" : "template";
  const magazine = payload.magazineId
    ? await ctx.db.get(payload.magazineId as Id<"magazines">)
    : null;
  const firstProduct = payload.products[0]
    ? await ctx.db
        .query("products")
        .withIndex("by_attrangsProductId", (q) =>
          q.eq("attrangsProductId", payload.products[0]!.attrangsProductId),
        )
        .unique()
    : null;
  let saved = 0;
  let approved = 0;
  for (const raw of pieces) {
    if (!CHANNELS.includes(raw.channel)) continue;
    const report = evaluatePiece(raw, { linkExpected: true });
    const ok = isAutoApprovable(report);
    await ctx.db.insert("contentPieces", {
      ownerUserId: job.userId,
      visibility: "PRIVATE",
      magazineId: magazine?._id,
      productId: firstProduct?._id,
      channel: raw.channel,
      caption: report.caption,
      hashtags: report.hashtags,
      script: raw.script ?? undefined,
      mediaUrls: magazine?.imageUrls.slice(0, 4) ?? [],
      qualityScore: report.score,
      qualityReport: { violations: report.violations, fixed: report.fixed },
      status: ok ? "APPROVED" : "DRAFT",
      generatedBy,
      jobId: job._id,
      usageCount: 0,
      createdAt: Date.now(),
    });
    saved++;
    if (ok) approved++;
  }
  return { saved, approved };
}

const pieceView = (
  p: Doc<"contentPieces">,
  extra: { magazineTitle?: string | null; productName?: string | null },
) => ({
  _id: p._id,
  channel: p.channel,
  caption: p.caption,
  hashtags: p.hashtags,
  script: p.script ?? null,
  mediaUrls: p.mediaUrls,
  qualityScore: p.qualityScore,
  qualityReport: p.qualityReport as {
    violations: { code: string; message: string; severity: string }[];
    fixed: string[];
  },
  status: p.status,
  visibility: p.visibility,
  generatedBy: p.generatedBy,
  usageCount: p.usageCount,
  createdAt: p.createdAt,
  mine: false,
  magazineTitle: extra.magazineTitle ?? null,
  productName: extra.productName ?? null,
  productId: p.productId ?? null,
});

async function decorate(
  ctx: QueryCtx | MutationCtx,
  rows: Doc<"contentPieces">[],
  viewerId: Id<"users">,
) {
  const out = [];
  for (const p of rows) {
    const m = p.magazineId ? await ctx.db.get(p.magazineId) : null;
    const pr = p.productId ? await ctx.db.get(p.productId) : null;
    out.push({
      ...pieceView(p, {
        magazineTitle: m?.title ?? null,
        productName: pr?.name ?? null,
      }),
      mine: p.ownerUserId === viewerId,
    });
  }
  return out;
}

/** 라이브러리: 내 조각 + 공유(SHARED) 조각. RETIRED 제외 */
export const listLibrary = query({
  args: {
    channel: v.optional(channelValidator),
    status: v.optional(v.union(v.literal("DRAFT"), v.literal("APPROVED"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const mine = await ctx.db
      .query("contentPieces")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .order("desc")
      .take(200);
    const shared = await ctx.db
      .query("contentPieces")
      .withIndex("by_visibility", (q) =>
        q.eq("visibility", "SHARED").eq("status", "APPROVED"),
      )
      .order("desc")
      .take(200);
    const merged = [
      ...mine,
      ...shared.filter((s) => s.ownerUserId !== user._id),
    ]
      .filter((p) => p.status !== "RETIRED")
      .filter((p) => !args.channel || p.channel === args.channel)
      .filter((p) => !args.status || p.status === args.status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(args.limit ?? 100, 300));
    return await decorate(ctx, merged, user._id);
  },
});

export const getPiece = query({
  args: { pieceId: v.id("contentPieces") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p) fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    if (
      p.ownerUserId !== user._id &&
      !(p.visibility === "SHARED" && p.status === "APPROVED") &&
      roleOf(user) !== "SUPER_ADMIN"
    )
      fail("FORBIDDEN", "접근할 수 없는 콘텐츠입니다.");
    return (await decorate(ctx, [p], user._id))[0]!;
  },
});

/** 발행/예약에서 조각을 사용할 때 호출: 접근 검사 + 사용 횟수 증가 후 본문·미디어 반환 */
export const approve = mutation({
  args: { pieceId: v.id("contentPieces") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p || (p.ownerUserId !== user._id && roleOf(user) !== "SUPER_ADMIN"))
      fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    const blocks = (
      (p.qualityReport as { violations?: { severity: string }[] })
        ?.violations ?? []
    ).filter((v) => v.severity === "block");
    if (blocks.length > 0 && roleOf(user) !== "SUPER_ADMIN")
      fail("CONFLICT", "금칙 위반이 있는 콘텐츠는 수정 후 승인할 수 있습니다.");
    await ctx.db.patch(p._id, { status: "APPROVED" });
  },
});

export const edit = mutation({
  args: {
    pieceId: v.id("contentPieces"),
    caption: v.string(),
    hashtags: v.array(v.string()),
    script: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p || (p.ownerUserId !== user._id && roleOf(user) !== "SUPER_ADMIN"))
      fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    const report = evaluatePiece(
      {
        channel: p.channel as Channel,
        caption: args.caption,
        hashtags: args.hashtags,
        script: args.script ?? null,
      },
      { linkExpected: true },
    );
    await ctx.db.patch(p._id, {
      caption: report.caption,
      hashtags: report.hashtags,
      script: args.script,
      qualityScore: report.score,
      qualityReport: { violations: report.violations, fixed: report.fixed },
      status: isAutoApprovable(report) ? "APPROVED" : "DRAFT",
      generatedBy: "manual",
    });
    return { score: report.score, violations: report.violations };
  },
});

export const reject = mutation({
  args: { pieceId: v.id("contentPieces"), reason: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p || (p.ownerUserId !== user._id && roleOf(user) !== "SUPER_ADMIN"))
      fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    await ctx.db.patch(p._id, { status: "RETIRED" });
    await ctx.db.insert("contentRejections", {
      userId: user._id,
      pieceId: p._id,
      channel: p.channel,
      reason: args.reason.trim().slice(0, 300),
      snippet: p.caption.slice(0, 200),
      createdAt: Date.now(),
    });
  },
});

/** 수퍼어드민: 공유 라이브러리 관리 */
export const setVisibility = mutation({
  args: {
    pieceId: v.id("contentPieces"),
    visibility: v.union(v.literal("PRIVATE"), v.literal("SHARED")),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p) fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    if (args.visibility === "SHARED" && p.status !== "APPROVED")
      fail("CONFLICT", "승인된 콘텐츠만 공유할 수 있습니다.");
    await ctx.db.patch(p._id, { visibility: args.visibility });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "content.setVisibility",
      metadata: { pieceId: p._id, visibility: args.visibility },
    });
  },
});

export const listAll = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const rows = await ctx.db
      .query("contentPieces")
      .order("desc")
      .take(Math.min(args.limit ?? 100, 500));
    return await decorate(ctx, rows, actor._id);
  },
});

export const rejectionStats = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const rows = await ctx.db
      .query("contentRejections")
      .withIndex("by_createdAt")
      .order("desc")
      .take(200);
    const byReason = new Map<string, number>();
    for (const r of rows)
      byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    return {
      total: rows.length,
      top: [...byReason.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count })),
      recent: rows.slice(0, 20),
    };
  },
});
