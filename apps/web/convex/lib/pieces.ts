import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { stripMatchingTrailingHashtagBlock } from "@automoney/shared";
import { fail } from "./errors";

/** 라이브러리 조각을 발행/예약 본문으로 읽는다. 사용 횟수는 실제 게시 성공 때만 증가한다. */
export async function consumePiece(
  ctx: MutationCtx,
  userId: Id<"users">,
  pieceId: Id<"contentPieces">,
  role: string,
): Promise<{ text: string; mediaUrls: string[]; channel: string; productId?: Id<"products"> }> {
  const p = await ctx.db.get(pieceId);
  if (!p || p.status !== "APPROVED")
    fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
  if (
    p.ownerUserId !== userId &&
    !(p.visibility === "SHARED" && p.status === "APPROVED") &&
    role !== "SUPER_ADMIN"
  )
    fail("FORBIDDEN", "접근할 수 없는 콘텐츠입니다.");
  const caption = stripMatchingTrailingHashtagBlock(p.caption, p.hashtags);
  const text = p.hashtags.length
    ? `${caption}\n\n${p.hashtags.map((h) => `#${h}`).join(" ")}`
    : caption;
  return { text, mediaUrls: p.mediaUrls, channel: p.channel, productId: p.productId };
}
