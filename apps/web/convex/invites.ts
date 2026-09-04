import { v } from "convex/values";
import { generateCode, INVITE_CODE_LENGTH, normalizeCode } from "@automoney/shared";
import { mutation, query } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireAdminOrSuper } from "./lib/rbac";

export const create = mutation({
  args: { maxUses: v.optional(v.number()), expiresInDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const actor = await requireAdminOrSuper(ctx);
    const maxUses = Math.min(Math.max(Math.floor(args.maxUses ?? 10), 1), 1000);
    const expiresAt = args.expiresInDays ? Date.now() + args.expiresInDays * 86_400_000 : undefined;
    let code = "";
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode(INVITE_CODE_LENGTH);
      const dup = await ctx.db
        .query("inviteCodes")
        .withIndex("by_code", (q) => q.eq("code", candidate))
        .unique();
      if (!dup) {
        code = candidate;
        break;
      }
    }
    if (!code) fail("CONFLICT", "초대 코드 생성에 실패했습니다.");
    const id = await ctx.db.insert("inviteCodes", {
      code,
      adminId: actor._id,
      maxUses,
      usedCount: 0,
      expiresAt,
      active: true,
    });
    await audit(ctx, { actorUserId: actor._id, action: "invite.create", metadata: { code, maxUses } });
    return { id, code };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireAdminOrSuper(ctx);
    const rows = await ctx.db
      .query("inviteCodes")
      .withIndex("by_admin", (q) => q.eq("adminId", actor._id))
      .collect();
    return rows.sort((a, b) => b._creationTime - a._creationTime);
  },
});

export const deactivate = mutation({
  args: { id: v.id("inviteCodes") },
  handler: async (ctx, args) => {
    const actor = await requireAdminOrSuper(ctx);
    const invite = await ctx.db.get(args.id);
    if (!invite || invite.adminId !== actor._id) fail("NOT_FOUND", "초대 코드를 찾을 수 없습니다.");
    await ctx.db.patch(args.id, { active: false });
  },
});

/** 가입 화면에서 사전 검증. 존재 여부만 알려주고 총판 정보는 노출하지 않는다. */
export const validate = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (code.length !== INVITE_CODE_LENGTH) return { valid: false as const };
    const invite = await ctx.db
      .query("inviteCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    const now = Date.now();
    const valid = Boolean(
      invite && invite.active && invite.usedCount < invite.maxUses && (!invite.expiresAt || invite.expiresAt > now),
    );
    return { valid };
  },
});
