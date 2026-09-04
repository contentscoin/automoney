import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function audit(
  ctx: MutationCtx,
  input: { actorUserId?: Id<"users">; targetUserId?: Id<"users">; action: string; metadata?: unknown },
) {
  await ctx.db.insert("auditEvents", {
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId,
    action: input.action,
    metadata: input.metadata,
    createdAt: Date.now(),
  });
}
