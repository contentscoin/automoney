import { ConvexError } from "convex/values";
import { generateCode, INVITE_CODE_LENGTH, PARTNER_CODE_LENGTH } from "@automoney/shared";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export function superAdminEmails(): Set<string> {
  return new Set(
    (process.env.SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function uniquePartnerCode(ctx: MutationCtx): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = generateCode(PARTNER_CODE_LENGTH);
    const dup = await ctx.db
      .query("users")
      .withIndex("by_partnerCode", (q) => q.eq("partnerCode", code))
      .unique();
    if (!dup) return code;
  }
  throw new ConvexError({ code: "CONFLICT", message: "파트너 코드 생성에 실패했습니다." });
}

/**
 * 신규 가입 직후 호출: 역할 결정(SUPER_ADMIN_EMAILS), 파트너 코드 발급, 초대 코드 소비 → 총판 연결.
 * 초대 코드가 무효하면 throw 하여 가입 트랜잭션 전체를 롤백한다.
 */
export async function provisionNewUser(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) return;
  const email = (user.email ?? "").toLowerCase();
  const isSuper = superAdminEmails().has(email);

  let parentAdminId: Id<"users"> | undefined;
  if (user.inviteCode) {
    const inviteCode = user.inviteCode;
    if (inviteCode.length !== INVITE_CODE_LENGTH) {
      throw new ConvexError({ code: "INVITE_INVALID", message: "초대 코드가 올바르지 않습니다." });
    }
    const invite = await ctx.db
      .query("inviteCodes")
      .withIndex("by_code", (q) => q.eq("code", inviteCode))
      .unique();
    const now = Date.now();
    const valid =
      invite && invite.active && invite.usedCount < invite.maxUses && (!invite.expiresAt || invite.expiresAt > now);
    if (!invite || !valid) {
      throw new ConvexError({ code: "INVITE_INVALID", message: "초대 코드가 만료되었거나 유효하지 않습니다." });
    }
    parentAdminId = invite.adminId;
    await ctx.db.patch(invite._id, { usedCount: invite.usedCount + 1 });
  }

  await ctx.db.patch(userId, {
    role: isSuper ? "SUPER_ADMIN" : "USER",
    status: "ACTIVE",
    partnerCode: await uniquePartnerCode(ctx),
    parentAdminId: isSuper ? undefined : parentAdminId,
    inviteCode: undefined,
  });
  await ctx.db.insert("auditEvents", {
    actorUserId: userId,
    targetUserId: userId,
    action: "user.signup",
    metadata: { role: isSuper ? "SUPER_ADMIN" : "USER", viaInvite: Boolean(parentAdminId) },
    createdAt: Date.now(),
  });
}
