import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MediaIntegrity, MAX_PUBLISH_MEDIA_BYTES } from "@automoney/shared";
import { downloadMedia, handlePublish } from "../src/agent/jobs/handlers";
import type { JobContext } from "../src/agent/jobs/context";
import * as spaces from "../src/agent/spaces/manager";

const url = "http://127.0.0.1/reviewed.jpg";
const bytes = Buffer.from("reviewed bytes");
const manifest: MediaIntegrity = {
  url, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, mimeType: "image/jpeg",
};
const createdDirs = new Set<string>();

beforeEach(() => {
  vi.stubEnv("AUTOMONEY_ALLOW_PRIVATE_MEDIA", "1");
  vi.stubEnv("AUTOMONEY_DRY_RUN", "0");
  const makeTemp = fs.mkdtempSync;
  vi.spyOn(fs, "mkdtempSync").mockImplementation(((...args: Parameters<typeof fs.mkdtempSync>) => {
    const dir = makeTemp(...args);
    createdDirs.add(String(dir));
    return dir;
  }) as typeof fs.mkdtempSync);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
  createdDirs.clear();
});

function response(body: BodyInit = bytes, mime = "image/jpeg", headers: Record<string, string> = {}) {
  return new Response(body, { headers: { "content-type": mime, ...headers } });
}

function publishContext(mediaIntegrity?: unknown, dryRun = false): JobContext {
  return {
    cfg: {}, api: {},
    job: { payload: { platform: "X", text: "reviewed", mediaUrls: [url], dryRun, ...(mediaIntegrity !== undefined ? { mediaIntegrity } : {}) } },
    checkpoint: vi.fn(async () => {}),
  } as unknown as JobContext;
}

describe("reviewed media byte verification", () => {
  it("writes only matching bytes and retains the legacy dry-run downloader signature", async () => {
    const fetchMock = vi.fn(async () => response()) as unknown as typeof fetch;
    const verified = await downloadMedia([url], fetchMock, [manifest]);
    expect(verified).toHaveLength(1);
    expect(fs.readFileSync(verified[0]!)).toEqual(bytes);
    expect(path.extname(verified[0]!)).toBe(".jpg");
    expect(await downloadMedia([url], fetchMock)).toHaveLength(1);
    expect(await downloadMedia([], fetchMock, [])).toEqual([]);
  });

  it("rejects changed bytes at the same URL before writing any file", async () => {
    const write = vi.spyOn(fs, "writeFileSync");
    const fetchMock = vi.fn(async () => response(Buffer.from("tampered bytes"))) as unknown as typeof fetch;
    await expect(downloadMedia([url], fetchMock, [manifest])).rejects.toMatchObject({ code: "MEDIA_INTEGRITY_MISMATCH" });
    expect(write).not.toHaveBeenCalled();
    for (const dir of createdDirs) expect(fs.existsSync(dir)).toBe(false);
  });

  it("rejects changed MIME and both declared and streamed byte sizes", async () => {
    for (const makeResponse of [
      () => response(bytes, "image/png"),
      () => response(bytes, "image/jpeg", { "content-length": String(bytes.length + 1) }),
      () => response(Buffer.from("short")),
      () => response(Buffer.concat([bytes, Buffer.from("extra")])),
    ]) {
      await expect(downloadMedia([url], vi.fn(async () => makeResponse()) as unknown as typeof fetch, [manifest]))
        .rejects.toMatchObject({ code: "MEDIA_INTEGRITY_MISMATCH" });
    }
    for (const dir of createdDirs) expect(fs.existsSync(dir)).toBe(false);
  });

  it("rejects malformed and missing live manifests before opening a browser or fetching", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    const ctx = publishContext();
    await expect(handlePublish(ctx)).rejects.toMatchObject({ code: "MEDIA_INTEGRITY_REQUIRED" });
    expect(ctx.checkpoint).not.toHaveBeenCalled();
    for (const invalid of [[], null, [{ ...manifest, sha256: "invalid" }]]) {
      await expect(handlePublish(publishContext(invalid, true))).rejects.toMatchObject({ code: "MEDIA_INTEGRITY_INVALID" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createdDirs.size).toBe(0);
  });

  it("rejects same-URL tampering before recipe or autopilot can upload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(Buffer.from("tampered bytes"))));
    const ctx = publishContext([manifest]);
    await expect(handlePublish(ctx)).rejects.toMatchObject({ code: "MEDIA_INTEGRITY_MISMATCH" });
    expect(ctx.checkpoint).toHaveBeenCalledExactlyOnceWith("preparing", 5);
  });

  it("removes a partially downloaded batch on a later mismatch", async () => {
    const second = { ...manifest, url: "http://127.0.0.1/second.jpg" };
    let count = 0;
    const fetchMock = vi.fn(async () => response(++count === 1 ? bytes : Buffer.from("tampered bytes"))) as unknown as typeof fetch;
    await expect(downloadMedia([url, second.url], fetchMock, [manifest, second])).rejects.toMatchObject({ code: "MEDIA_INTEGRITY_MISMATCH" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const dir of createdDirs) expect(fs.existsSync(dir)).toBe(false);
  });

  it("cleans verified files if opening the browser fails and keeps legacy dry-run compatible", async () => {
    const open = vi.spyOn(spaces, "openSpace").mockRejectedValue(new Error("browser failed before upload"));
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await expect(handlePublish(publishContext([manifest]))).rejects.toThrow("browser failed before upload");
    await expect(handlePublish(publishContext(undefined, true))).rejects.toThrow("browser failed before upload");
    expect(open).toHaveBeenCalledTimes(2);
    for (const dir of createdDirs) expect(fs.existsSync(dir)).toBe(false);
  });

  it("bounds a stalled body even when the injected fetch ignores abort", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const body = new ReadableStream({ cancel: cancelled });
    const fetchMock = vi.fn(async () => response(body)) as unknown as typeof fetch;
    const pending = expect(downloadMedia([url], fetchMock, [manifest])).rejects.toMatchObject({ code: "MEDIA_DOWNLOAD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    expect(cancelled).toHaveBeenCalled();
    for (const dir of createdDirs) expect(fs.existsSync(dir)).toBe(false);
  });

  it("limits a chunked body before allocating the complete response", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PUBLISH_MEDIA_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel: cancelled,
    });
    await expect(downloadMedia([url], vi.fn(async () => response(body)) as unknown as typeof fetch))
      .rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
    expect(cancelled).toHaveBeenCalled();
    for (const dir of createdDirs) expect(fs.existsSync(dir)).toBe(false);
  });
});
