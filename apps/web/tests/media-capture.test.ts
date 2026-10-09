// @vitest-environment node
import { createHash } from "node:crypto";
import { getFunctionName, type FunctionArgs, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { ActionCtx } from "../convex/_generated/server";
import { captureNext as registeredCaptureNext } from "../convex/mediaCapture";
import { downloadMediaSnapshot, MediaDownloadError } from "../convex/lib/mediaDownload";
import { mediaRevisionHash } from "../convex/lib/mediaIntegrity";
import { makeT, signup, type T } from "./helpers";

// Convex exposes this runtime test hook but omits it from the action's public type.
// Keep the assertion local to tests; no new server entrypoint is needed.
const captureNext = registeredCaptureNext as unknown as {
  _handler: (ctx: ActionCtx, args: FunctionArgs<typeof internal.mediaCapture.captureNext>) => Promise<void>;
};

vi.mock("../convex/lib/mediaDownload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../convex/lib/mediaDownload")>();
  return { ...actual, downloadMediaSnapshot: vi.fn() };
});

const remote = "https://images.example.com/photo.png?signed=private-value";
const caption = "가을 데일리 코디를 위한 원피스 스타일을 소개합니다. 소재와 핏 정보를 확인하고 다음 코디에 활용해 보세요.";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const downloaded = {
  bytes: new Uint8Array(PNG), mimeType: "image/png" as const, extension: "png", sizeBytes: PNG.length,
  contentHash: createHash("sha256").update(PNG).digest("hex"), sourceUrl: remote, finalUrl: remote,
};
const download = vi.mocked(downloadMediaSnapshot);

beforeEach(() => {
  vi.useFakeTimers();
  download.mockReset().mockResolvedValue(downloaded);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Invoke the actual Node action handler, with real Convex mutations/storage behind its RPCs. */
function worker(t: T, appendMode: "normal" | "response-lost" | "reject" = "normal") {
  const runQuery = vi.fn(async (ref: FunctionReference<"query", "internal">, args: Record<string, unknown>) => t.query(ref, args));
  const runMutation = vi.fn(async (ref: FunctionReference<"mutation", "internal">, args: Record<string, unknown>) => {
    const append = getFunctionName(ref) === "media:appendFile";
    if (append && appendMode === "reject") throw new Error(`transport failure ${remote}`);
    const result = await t.mutation(ref, args);
    // Commit first, then lose the response. This must never delete the bound blob.
    if (append && appendMode === "response-lost") throw new Error(`response lost ${remote}`);
    return result;
  });
  const store = vi.fn(async (blob: Blob) => t.run(ctx => ctx.storage.store(blob)));
  const directDelete = vi.fn(async () => { throw new Error("action must use atomic cleanup mutation"); });
  const ctx = { runQuery, runMutation, storage: { store, delete: directDelete } } as unknown as Parameters<typeof captureNext._handler>[0];
  return { ctx, runQuery, runMutation, store, directDelete };
}

async function fixture(count = 1, appendMode: Parameters<typeof worker>[1] = "normal") {
  const t = makeT();
  const owner = await signup(t, "capture-owner@automoney.test");
  const { pieceId } = await owner.as.mutation(api.content.createManual, {
    channel: "THREADS", caption, hashtags: ["광고", "데일리룩"], mediaUrls: Array.from({ length: count }, () => remote),
  });
  const piece = await t.run(ctx => ctx.db.get(pieceId));
  const request = await owner.as.mutation(api.media.requestFreeze, {
    pieceId, expectedMediaRevisionHash: await mediaRevisionHash(piece!), rightsConfirmed: true, rightsNote: "직접 촬영한 이미지의 공개 배포 동의",
  });
  return { t, owner, pieceId, request, ...worker(t, appendMode) };
}

async function competitorFile(t: T) {
  const storageId = await t.run(ctx => ctx.storage.store(new Blob([PNG], { type: "image/png" })));
  return { storageId, contentHash: downloaded.contentHash, mimeType: downloaded.mimeType, extension: "png", sizeBytes: PNG.length };
}

describe("Node media capture action integration (mocked remote downloader)", () => {
  it("stores exact bytes, binds one file, and atomically publishes the immutable draft URL", async () => {
    const f = await fixture();
    await captureNext._handler(f.ctx, f.request);
    expect(download).toHaveBeenCalledExactlyOnceWith(remote);
    expect(f.store).toHaveBeenCalledOnce();
    const assets = await f.t.run(ctx => ctx.db.query("contentMediaAssets").collect());
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ status: "READY", contentHash: downloaded.contentHash, sizeBytes: PNG.length, mimeType: "image/png" });
    const stored = await f.t.run(async ctx => (await ctx.storage.get(assets[0]!.storageId))!.arrayBuffer());
    expect(Buffer.from(stored)).toEqual(PNG);
    expect(await f.t.run(ctx => ctx.db.get(f.request.requestId))).toMatchObject({ status: "SUCCEEDED", completedCount: 1 });
    expect(await f.owner.as.query(api.content.getPiece, { pieceId: f.pieceId })).toMatchObject({ status: "DRAFT", mediaIntegrity: { ready: true } });
    expect(f.directDelete).not.toHaveBeenCalled();
  });

  it("records a safe downloader failure without storing or reflecting a signed URL", async () => {
    const f = await fixture();
    download.mockRejectedValueOnce(new MediaDownloadError("MEDIA_TIMEOUT", "미디어 응답 시간이 초과되었습니다."));
    await captureNext._handler(f.ctx, f.request);
    const request = await f.t.run(ctx => ctx.db.get(f.request.requestId));
    expect(request).toMatchObject({ status: "FAILED", completedCount: 0, error: "미디어 응답 시간이 초과되었습니다." });
    expect(request!.error).not.toContain("private-value");
    expect(f.store).not.toHaveBeenCalled();
    expect(f.runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual(["media:recordFailure"]);
  });

  it("sanitizes a storage failure without attempting deletion with an unknown storage ID", async () => {
    const f = await fixture();
    f.store.mockRejectedValueOnce(new Error(`storage failure ${remote}`));
    await captureNext._handler(f.ctx, f.request);
    const request = await f.t.run(ctx => ctx.db.get(f.request.requestId));
    expect(request?.status).toBe("FAILED");
    expect(request?.error).not.toContain("private-value");
    expect(await f.t.run(ctx => ctx.db.system.query("_storage").collect())).toHaveLength(0);
    expect(f.runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual(["media:recordFailure"]);
    expect(f.directDelete).not.toHaveBeenCalled();
  });

  it("cleans genuinely unbound bytes after append fails before committing", async () => {
    const f = await fixture(1, "reject");
    await captureNext._handler(f.ctx, f.request);
    const storageId = await f.store.mock.results[0]!.value;
    expect(await f.t.run(ctx => ctx.storage.get(storageId))).toBeNull();
    expect(await f.t.run(ctx => ctx.db.query("contentMediaAssets").collect())).toHaveLength(0);
    expect(await f.t.run(ctx => ctx.db.get(f.request.requestId))).toMatchObject({ status: "FAILED", completedCount: 0 });
    expect(f.runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual(["media:appendFile", "media:cleanupUnbound", "media:recordFailure"]);
    expect(f.directDelete).not.toHaveBeenCalled();
  });

  it("preserves a READY file when append committed but the response was lost", async () => {
    const f = await fixture(1, "response-lost");
    await captureNext._handler(f.ctx, f.request);
    const storageId = await f.store.mock.results[0]!.value;
    expect(await f.t.run(async ctx => !!await ctx.storage.get(storageId))).toBe(true);
    expect(await f.t.run(ctx => ctx.db.query("contentMediaAssets").collect())).toEqual([expect.objectContaining({ storageId, status: "READY" })]);
    expect(await f.t.run(ctx => ctx.db.get(f.request.requestId))).toMatchObject({ status: "SUCCEEDED", completedCount: 1 });
    const piece = await f.owner.as.query(api.content.getPiece, { pieceId: f.pieceId });
    expect(piece.mediaIntegrity.ready).toBe(true);
    const response = await f.t.fetch(new URL(piece.mediaUrls[0]!).pathname);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(f.runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual(["media:appendFile", "media:cleanupUnbound", "media:recordFailure"]);
    expect(f.directDelete).not.toHaveBeenCalled();
  });

  it("preserves a STAGED file and next-index progress after an intermediate append response is lost", async () => {
    const f = await fixture(2, "response-lost");
    await captureNext._handler(f.ctx, f.request);
    const storageId = await f.store.mock.results[0]!.value;
    expect(await f.t.run(async ctx => !!await ctx.storage.get(storageId))).toBe(true);
    expect(await f.t.run(ctx => ctx.db.query("contentMediaAssets").collect())).toEqual([expect.objectContaining({ storageId, status: "STAGED" })]);
    expect(await f.t.run(ctx => ctx.db.get(f.request.requestId))).toMatchObject({ status: "RUNNING", completedCount: 1 });
    expect(await f.t.query(internal.media.nextFile, f.request)).toMatchObject({ index: 1 });
  });

  it("does not fail another worker's next index when an older downloader fails", async () => {
    const f = await fixture(2);
    download.mockImplementationOnce(async () => {
      await f.t.mutation(internal.media.appendFile, { ...f.request, index: 0, file: await competitorFile(f.t) });
      throw new MediaDownloadError("MEDIA_TIMEOUT", "미디어 응답 시간이 초과되었습니다.");
    });
    await captureNext._handler(f.ctx, f.request);
    expect(await f.t.run(ctx => ctx.db.get(f.request.requestId))).toMatchObject({ status: "RUNNING", completedCount: 1 });
    expect(f.store).not.toHaveBeenCalled();
    expect(f.runMutation.mock.calls[0]?.[1]).toMatchObject({ expectedIndex: 0 });
  });

  it("cleans only the redundant download if another worker already appended that index", async () => {
    const f = await fixture(2);
    const other = await competitorFile(f.t);
    download.mockImplementationOnce(async () => {
      await f.t.mutation(internal.media.appendFile, { ...f.request, index: 0, file: other });
      return downloaded;
    });
    await captureNext._handler(f.ctx, f.request);
    const redundantId = await f.store.mock.results[0]!.value;
    expect(await f.t.run(ctx => ctx.storage.get(redundantId))).toBeNull();
    expect(await f.t.run(async ctx => !!await ctx.storage.get(other.storageId))).toBe(true);
    expect(await f.t.run(ctx => ctx.db.get(f.request.requestId))).toMatchObject({ status: "RUNNING", completedCount: 1 });
    expect(f.runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual(["media:appendFile", "media:cleanupUnbound"]);
  });

  it("reuses an immutable file without downloading or allocating another blob", async () => {
    const f = await fixture();
    await captureNext._handler(f.ctx, f.request);
    const original = await f.t.run(ctx => ctx.db.get(f.pieceId));
    await f.owner.as.mutation(api.content.edit, { pieceId: f.pieceId, caption, hashtags: ["광고"], mediaUrls: [original!.mediaUrls[0]!, remote] });
    const edited = await f.t.run(ctx => ctx.db.get(f.pieceId));
    const request = await f.owner.as.mutation(api.media.requestFreeze, {
      pieceId: f.pieceId, expectedMediaRevisionHash: await mediaRevisionHash(edited!), rightsConfirmed: true, rightsNote: "직접 촬영한 이미지의 공개 배포 동의",
    });
    download.mockClear();
    const freshWorker = worker(f.t);
    await captureNext._handler(freshWorker.ctx, request);
    expect(download).not.toHaveBeenCalled();
    expect(freshWorker.store).not.toHaveBeenCalled();
    expect(freshWorker.runMutation.mock.calls[0]?.[1]).toEqual({ ...request, index: 0 });
    expect(await f.t.run(ctx => ctx.db.get(request.requestId))).toMatchObject({ status: "RUNNING", completedCount: 1, resultUrls: original!.mediaUrls });
  });

  it("does no work for a finished read and preserves an active request after transient query failure", async () => {
    const f = await fixture();
    f.runQuery.mockResolvedValueOnce(null);
    await captureNext._handler(f.ctx, f.request);
    expect(f.runMutation).not.toHaveBeenCalled();
    f.runQuery.mockRejectedValueOnce(new Error(`query transport failure ${remote}`));
    await captureNext._handler(f.ctx, f.request);
    expect(await f.t.run(ctx => ctx.db.get(f.request.requestId))).toMatchObject({ status: "PENDING", completedCount: 0 });
    expect(download).not.toHaveBeenCalled();
    expect(f.store).not.toHaveBeenCalled();
  });

  it("fails a request invalidated by a concurrent content edit before download", async () => {
    const f = await fixture();
    await f.owner.as.mutation(api.content.edit, { pieceId: f.pieceId, caption: `${caption} 새 코디를 더했습니다.`, hashtags: ["광고"], mediaUrls: [remote] });
    await captureNext._handler(f.ctx, f.request);
    expect(await f.t.run(ctx => ctx.db.get(f.request.requestId))).toMatchObject({ status: "FAILED", completedCount: 0 });
    expect(download).not.toHaveBeenCalled();
    expect(f.store).not.toHaveBeenCalled();
  });
});
