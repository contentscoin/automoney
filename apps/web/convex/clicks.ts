import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { timingSafeEqual } from "./lib/crypto";
import { fail } from "./lib/errors";
import { bumpMonthlyStats } from "./lib/stats";
import { kstMonth } from "./lib/time";

/**
 * 단축 링크 리다이렉터(Next route handler)가 서버 간 호출로 사용한다.
 * 브라우저가 직접 호출하지 못하도록 공유 시크릿을 요구한다.
 */
export const record = mutation({
  args: {
    shortCode: v.string(),
    secret: v.string(),
    ipHash: v.optional(v.string()),
    uaHash: v.optional(v.string()),
    referrerDomain: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const expected = process.env.REDIRECT_SHARED_SECRET;
    if (!expected) fail("CONFIG_MISSING", "REDIRECT_SHARED_SECRET 가 설정되지 않았습니다.");
    if (!timingSafeEqual(expected, args.secret)) fail("FORBIDDEN", "잘못된 호출입니다.");
    const link = await ctx.db
      .query("marketingLinks")
      .withIndex("by_shortCode", (q) => q.eq("shortCode", args.shortCode))
      .unique();
    if (!link || link.status !== "ACTIVE") return { found: false as const };
    const now = Date.now();
    await ctx.db.insert("clickEvents", {
      linkId: link._id,
      userId: link.userId,
      clickedAt: now,
      ipHash: args.ipHash,
      uaHash: args.uaHash,
      referrerDomain: args.referrerDomain,
      channel: args.channel,
    });
    await ctx.db.patch(link._id, { clickCount: link.clickCount + 1 });
    await bumpMonthlyStats(ctx, link.userId, kstMonth(now), { clicks: 1 });
    const url = new URL(link.targetUrl);
    url.searchParams.set("am_tc", link.trackingCode);
    return { found: true as const, redirectUrl: url.toString() };
  },
});
