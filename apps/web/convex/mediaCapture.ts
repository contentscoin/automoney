"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { downloadMediaSnapshot, MediaDownloadError } from "./lib/mediaDownload";

/** One file per scheduled invocation bounds memory, runtime and retriable work. */
export const captureNext = internalAction({
  args: { requestId: v.id("contentMediaFreezes") },
  handler: async (ctx, args): Promise<void> => {
    let unboundStorageId: Id<"_storage"> | undefined;
    let expectedIndex: number | undefined;
    try {
      const next: { index: number; sourceUrl: string; reusable: boolean } | null = await ctx.runQuery(internal.media.nextFile, args);
      if (!next) return;
      expectedIndex = next.index;
      if (next.reusable) { await ctx.runMutation(internal.media.appendFile, { ...args, index: next.index }); return; }
      const downloaded = await downloadMediaSnapshot(next.sourceUrl);
      unboundStorageId = await ctx.storage.store(new Blob([downloaded.bytes], { type: downloaded.mimeType }));
      const accepted: boolean = await ctx.runMutation(internal.media.appendFile, { ...args, index: next.index, file: { storageId: unboundStorageId, contentHash: downloaded.contentHash, mimeType: downloaded.mimeType, extension: downloaded.extension, sizeBytes: downloaded.sizeBytes } });
      if (!accepted) await ctx.runMutation(internal.media.cleanupUnbound, { storageId: unboundStorageId });
      unboundStorageId = undefined;
    } catch (error) {
      if (unboundStorageId) await ctx.runMutation(internal.media.cleanupUnbound, { storageId: unboundStorageId }).catch(() => undefined);
      // Never expose signed source URLs or arbitrary remote server messages.
      const message = error instanceof MediaDownloadError ? error.message : "미디어를 저장하지 못했습니다. 콘텐츠 변경 여부와 파일 주소·사용 권한을 확인한 뒤 다시 준비하세요.";
      await ctx.runMutation(internal.media.recordFailure, { ...args, error: message, expectedIndex });
    }
  },
});
