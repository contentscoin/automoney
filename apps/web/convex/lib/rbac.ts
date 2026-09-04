import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fail } from "./errors";

export type Role = "USER" | "ADMIN" | "SUPER_ADMIN";
type Ctx = QueryCtx | MutationCtx;

export function roleOf(user: Doc<"users">): Role {
  return user.role ?? "USER";
}

export async function getViewer(ctx: Ctx): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  return await ctx.db.get(userId);
}

/** 로그인 + 계정 활성 상태를 요구한다. */
export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const user = await getViewer(ctx);
  if (!user) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
  if ((user.status ?? "ACTIVE") === "SUSPENDED") fail("FORBIDDEN", "정지된 계정입니다.");
  return user;
}

export async function requireRole(ctx: Ctx, roles: Role[]): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!roles.includes(roleOf(user))) fail("FORBIDDEN", "권한이 없습니다.");
  return user;
}

export const requireSuperAdmin = (ctx: Ctx) => requireRole(ctx, ["SUPER_ADMIN"]);
export const requireAdminOrSuper = (ctx: Ctx) => requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]);

/**
 * 총판은 자기 하부 유저만, 수퍼어드민은 전체를 볼 수 있다.
 * 대상 유저 접근 가능 여부를 판정한다.
 */
export function canViewUser(actor: Doc<"users">, target: Doc<"users">): boolean {
  const role = roleOf(actor);
  if (role === "SUPER_ADMIN") return true;
  if (actor._id === target._id) return true;
  if (role === "ADMIN") return target.parentAdminId === actor._id;
  return false;
}

export async function requireViewableUser(ctx: Ctx, actor: Doc<"users">, targetId: Id<"users">) {
  const target = await ctx.db.get(targetId);
  if (!target) fail("NOT_FOUND", "유저를 찾을 수 없습니다.");
  if (!canViewUser(actor, target)) fail("FORBIDDEN", "해당 유저에 접근할 수 없습니다.");
  return target;
}
