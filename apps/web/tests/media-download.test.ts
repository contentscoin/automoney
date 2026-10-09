// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createMediaDownloader, isPublicMediaAddress, sniffSnapshotMediaType, validateMediaSnapshotUrls,
  type MediaDownloadResponse, type MediaDownloadTransport, type ResolvedMediaAddress,
} from "../convex/lib/mediaDownload";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const PUBLIC = { address: "93.184.216.34", family: 4 as const };
function response(options: { status?: number; mime?: string; chunks?: Uint8Array[]; headers?: Record<string, string>; body?: AsyncIterable<Uint8Array> } = {}): MediaDownloadResponse {
  return {
    status: options.status ?? 200,
    headers: { "content-type": options.mime ?? "image/png", ...options.headers },
    body: options.body ?? (async function* () { for (const chunk of options.chunks ?? [PNG]) yield chunk; })(),
    close: vi.fn(),
  };
}
function fixture(responses: MediaDownloadResponse[] = [response()], addresses: ResolvedMediaAddress[] = [PUBLIC]) {
  const resolve = vi.fn(async () => addresses);
  const open = vi.fn(async () => responses.shift()!);
  return { download: createMediaDownloader({ resolve, open }), resolve, open };
}

describe("immutable media safe downloader", () => {
  it("streams a public image, records exact bytes and hash, and pins the checked address", async () => {
    const res = response({ chunks: [PNG.subarray(0, 10), PNG.subarray(10)], headers: { "content-length": String(PNG.length) } });
    const { download, resolve, open } = fixture([res]);
    const result = await download("https://assets.example.com/image.png?version=1", { expectedKind: "image" });
    expect(result).toMatchObject({ mimeType: "image/png", extension: "png", sizeBytes: PNG.length,
      contentHash: createHash("sha256").update(PNG).digest("hex"), sourceUrl: "https://assets.example.com/image.png?version=1", finalUrl: "https://assets.example.com/image.png?version=1" });
    expect(Buffer.from(result.bytes)).toEqual(PNG);
    expect(resolve).toHaveBeenCalledExactlyOnceWith("assets.example.com");
    expect(open.mock.calls[0]).toEqual([new URL(result.sourceUrl), PUBLIC, expect.any(AbortSignal)]);
    expect(res.close).toHaveBeenCalledOnce();
  });

  it.each(["http://example.com/a.png", "https://user:password@example.com/a.png", "https://example.com:8443/a.png", "https://localhost./a.png", "https://host.local/a.png", "https://example.com/a.png#fragment", "file:///etc/passwd"])("blocks URL before any DNS/request: %s", async (url) => {
    const { download, open, resolve } = fixture();
    await expect(download(url)).rejects.toMatchObject({ code: "MEDIA_URL_BLOCKED" });
    expect(open).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "10.1.1.1", "0.0.0.0", "169.254.169.254", "172.16.1.1", "192.168.1.1", "100.100.100.200", "198.18.0.1", "192.0.2.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "168.63.129.16", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "fd00::1", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::", "3fff::1"])("rejects nonpublic, transition and metadata address %s", (address) => {
    expect(isPublicMediaAddress(address)).toBe(false);
  });

  it("blocks a mixed public/private DNS answer and encoded literal loopback", async () => {
    const mixed = fixture([response()], [PUBLIC, { address: "127.0.0.1", family: 4 }]);
    await expect(mixed.download("https://assets.example.com/a.png")).rejects.toMatchObject({ code: "MEDIA_URL_BLOCKED" });
    expect(mixed.open).not.toHaveBeenCalled();
    for (const url of ["https://2130706433/a.png", "https://0x7f000001/a.png", "https://[::ffff:7f00:1]/a.png"]) {
      const test = fixture();
      await expect(test.download(url)).rejects.toMatchObject({ code: "MEDIA_URL_BLOCKED" });
      expect(test.open).not.toHaveBeenCalled();
    }
    expect(isPublicMediaAddress("8.8.8.8")).toBe(true);
    expect(isPublicMediaAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("revalidates every redirect and closes redirect bodies without reading them", async () => {
    const redirect = response({ status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    const { download, open } = fixture([redirect]);
    await expect(download("https://assets.example.com/image.png")).rejects.toMatchObject({ code: "MEDIA_URL_BLOCKED" });
    expect(open).toHaveBeenCalledOnce();
    expect(redirect.close).toHaveBeenCalledOnce();
    const moved = fixture([response({ status: 307, headers: { location: "/immutable/image.png" } }), response()]);
    expect((await moved.download("https://assets.example.com/image.png")).finalUrl).toBe("https://assets.example.com/immutable/image.png");
    expect(moved.resolve).toHaveBeenCalledTimes(2);
    const loop = fixture(Array.from({ length: 4 }, () => response({ status: 302, headers: { location: "/loop" } })));
    await expect(loop.download("https://assets.example.com/image.png")).rejects.toMatchObject({ code: "MEDIA_REDIRECT" });
    expect(loop.open).toHaveBeenCalledTimes(4);
  });

  it("blocks MIME spoofing, compressed bodies, unsupported types and partial responses", async () => {
    for (const res of [response({ chunks: [Buffer.from("<html>not an image</html>")] }), response({ mime: "video/mp4" })]) {
      await expect(fixture([res]).download("https://assets.example.com/image.png")).rejects.toMatchObject({ code: "MEDIA_TYPE_MISMATCH" });
      expect(res.close).toHaveBeenCalledOnce();
    }
    await expect(fixture([response({ headers: { "content-encoding": "gzip" } })]).download("https://assets.example.com/a.png")).rejects.toMatchObject({ code: "MEDIA_ENCODING_UNSUPPORTED" });
    await expect(fixture([response({ mime: "image/svg+xml" })]).download("https://assets.example.com/a.svg")).rejects.toMatchObject({ code: "MEDIA_TYPE_UNSUPPORTED" });
    await expect(fixture().download("https://assets.example.com/a.png", { expectedKind: "video" })).rejects.toMatchObject({ code: "MEDIA_TYPE_MISMATCH" });
    await expect(fixture([response({ status: 206 })]).download("https://assets.example.com/a.png")).rejects.toMatchObject({ code: "MEDIA_DOWNLOAD_FAILED" });
  });

  it("enforces declared and actual image/video byte limits before buffering an oversized body", async () => {
    for (const [mime, maxBytes] of [["image/png", 10 * 1024 * 1024], ["video/mp4", 20 * 1024 * 1024]] as const) {
      const res = response({ mime, headers: { "content-length": String(maxBytes + 1) } });
      await expect(fixture([res]).download("https://assets.example.com/asset")).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
      expect(res.close).toHaveBeenCalledOnce();
    }
    let readChunks = 0;
    const body = (async function* () { for (let index = 0; index < 12; index++) { readChunks++; yield new Uint8Array(1024 * 1024); } })();
    await expect(fixture([response({ body })]).download("https://assets.example.com/a.png")).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
    expect(readChunks).toBe(11);
    await expect(fixture([response({ chunks: [] })]).download("https://assets.example.com/a.png")).rejects.toMatchObject({ code: "MEDIA_RESPONSE_INVALID" });
    await expect(fixture([response({ headers: { "content-length": "1000" } })]).download("https://assets.example.com/a.png")).rejects.toMatchObject({ code: "MEDIA_RESPONSE_INVALID" });
  });

  it("times out DNS and a stalled response body under one total deadline", async () => {
    const resolve = vi.fn(() => new Promise<ResolvedMediaAddress[]>(() => {}));
    const open = vi.fn();
    await expect(createMediaDownloader({ resolve, open })("https://assets.example.com/a.png", { timeoutMs: 10 })).rejects.toMatchObject({ code: "MEDIA_TIMEOUT" });
    expect(open).not.toHaveBeenCalled();
    const stalled = response({ body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } });
    await expect(fixture([stalled]).download("https://assets.example.com/a.png", { timeoutMs: 10 })).rejects.toMatchObject({ code: "MEDIA_TIMEOUT" });
    expect(stalled.close).toHaveBeenCalledOnce();
  });

  it("does not expose signed URL or certificate error details and respects cancellation", async () => {
    const transport: MediaDownloadTransport = { resolve: async () => [PUBLIC], open: async () => { throw new Error("CERTIFICATE_FAILED https://assets.example.com/?token=secret"); } };
    const failure = await createMediaDownloader(transport)("https://assets.example.com/a.png").catch((error) => error);
    expect(failure.code).toBe("MEDIA_DOWNLOAD_FAILED");
    expect(failure.message).not.toMatch(/secret|token|CERTIFICATE/);
    const controller = new AbortController();
    controller.abort();
    const cancelled = fixture();
    await expect(cancelled.download("https://assets.example.com/a.png", { signal: controller.signal })).rejects.toMatchObject({ code: "MEDIA_CANCELLED" });
    expect(cancelled.resolve).not.toHaveBeenCalled();
    expect(cancelled.open).not.toHaveBeenCalled();
  });

  it("identifies permitted signatures and bounds URL batches without reordering", () => {
    const mp4 = Buffer.alloc(16); mp4.writeUInt32BE(16); mp4.write("ftyp", 4); mp4.write("isom", 8);
    const mov = Buffer.from(mp4); mov.write("qt  ", 8);
    expect(sniffSnapshotMediaType(mp4)).toBe("video/mp4");
    expect(sniffSnapshotMediaType(mov)).toBe("video/quicktime");
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    expect(sniffSnapshotMediaType(webm)).toBe("video/webm");
    expect(sniffSnapshotMediaType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffSnapshotMediaType(Buffer.from([255, 216, 255]))).toBe("image/jpeg");
    expect(sniffSnapshotMediaType(Buffer.from("RIFF0000WEBP"))).toBe("image/webp");
    const urls = Array.from({ length: 30 }, (_, index) => `https://assets.example.com/${index}.png`);
    expect(validateMediaSnapshotUrls(urls)).toEqual(urls);
    expect(() => validateMediaSnapshotUrls([...urls, urls[0]!])).toThrow(/최대 30개/);
  });
});
