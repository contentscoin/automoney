import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";

/** 라이브러리 조각을 발행/예약 본문으로 소비(usageCount 증가). 내 것 또는 SHARED+APPROVED 만 허용 */
export async function consumePiece(
  ctx: MutationCtx,
  userId: Id<"users">,
  pieceId: Id<"contentPieces">,
  role: string,
): Promise<{ text: string; mediaUrls: string[]; channel: string }> {
  const p = await ctx.db.get(pieceId);
  if (!p || p.status === "RETIRED")
    fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
  if (
    p.ownerUserId !== userId &&
    !(p.visibility === "SHARED" && p.status === "APPROVED") &&
    role !== "SUPER_ADMIN"
  )
    fail("FORBIDDEN", "접근할 수 없는 콘텐츠입니다.");
  await ctx.db.patch(p._id, { usageCount: p.usageCount + 1 });
  const text = p.hashtags.length
    ? `${p.caption}\n\n${p.hashtags.map((h) => `#${h}`).join(" ")}`
    : p.caption;
  return { text, mediaUrls: p.mediaUrls, channel: p.channel };
}
