import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireSuperAdmin } from "./lib/rbac";

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    return await ctx.db.query("auditEvents").withIndex("by_createdAt").order("desc").take(Math.min(args.limit ?? 100, 500));
  },
});
