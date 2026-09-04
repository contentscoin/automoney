import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { getViewer, requireAdminOrSuper, requireSuperAdmin, roleOf } from "./lib/rbac";
import { roleValidator, userStatusValidator } from "./schema";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getViewer(ctx);
    if (!user) return null;
    const kyc = await ctx.db
      .query("kycProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    return {
      _id: user._id,
      email: user.email ?? "",
      name: user.name ?? "",
      role: roleOf(user),
      status: user.status ?? "ACTIVE",
      partnerCode: user.partnerCode ?? null,
      parentAdminId: user.parentAdminId ?? null,
      kycStatus: kyc?.status ?? null,
    };
  },
});

/** 총판: 자기 하부 유저. 수퍼어드민: 전체(또는 adminId 필터). */
export const listTeam = query({
  args: { adminId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const actor = await requireAdminOrSuper(ctx);
    const scopeAdmin = roleOf(actor) === "SUPER_ADMIN" ? args.adminId : actor._id;
    const users = scopeAdmin
      ? await ctx.db
          .query("users")
          .withIndex("by_parentAdmin", (q) => q.eq("parentAdminId", scopeAdmin))
          .collect()
      : await ctx.db.query("users").collect();
    const rows = [];
    for (const u of users) {
      const kyc = await ctx.db
        .query("kycProfiles")
        .withIndex("by_user", (q) => q.eq("userId", u._id))
        .unique();
      rows.push({
        _id: u._id,
        email: maskEmail(u.email ?? "", roleOf(actor) === "SUPER_ADMIN"),
        name: u.name ?? "",
        role: roleOf(u),
        status: u.status ?? "ACTIVE",
        parentAdminId: u.parentAdminId ?? null,
        kycStatus: kyc?.status ?? null,
        createdAt: u._creationTime,
      });
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const setRole = mutation({
  args: { userId: v.id("users"), role: roleValidator },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const target = await ctx.db.get(args.userId);
    if (!target) fail("NOT_FOUND", "유저를 찾을 수 없습니다.");
    if (target._id === actor._id && args.role !== "SUPER_ADMIN") {
      fail("INVALID_ARGUMENT", "자기 자신의 수퍼어드민 권한은 해제할 수 없습니다.");
    }
    await ctx.db.patch(args.userId, {
      role: args.role,
      parentAdminId: args.role === "USER" ? target.parentAdminId : undefined,
    });
    await audit(ctx, {
      actorUserId: actor._id,
      targetUserId: args.userId,
      action: "user.setRole",
      metadata: { from: roleOf(target), to: args.role },
    });
  },
});

export const setStatus = mutation({
  args: { userId: v.id("users"), status: userStatusValidator },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const target = await ctx.db.get(args.userId);
    if (!target) fail("NOT_FOUND", "유저를 찾을 수 없습니다.");
    if (target._id === actor._id) fail("INVALID_ARGUMENT", "자기 자신의 상태는 변경할 수 없습니다.");
    await ctx.db.patch(args.userId, { status: args.status });
    await audit(ctx, {
      actorUserId: actor._id,
      targetUserId: args.userId,
      action: "user.setStatus",
      metadata: { from: target.status ?? "ACTIVE", to: args.status },
    });
  },
});

export const assignAdmin = mutation({
  args: { userId: v.id("users"), adminId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (args.adminId) {
      const admin = await ctx.db.get(args.adminId);
      if (!admin || roleOf(admin) !== "ADMIN") fail("INVALID_ARGUMENT", "총판 계정이 아닙니다.");
    }
    await ctx.db.patch(args.userId, { parentAdminId: args.adminId });
    await audit(ctx, {
      actorUserId: actor._id,
      targetUserId: args.userId,
      action: "user.assignAdmin",
      metadata: { adminId: args.adminId ?? null },
    });
  },
});

function maskEmail(email: string, full: boolean): string {
  if (full || !email.includes("@")) return email;
  const [local, domain] = email.split("@") as [string, string];
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}
