"use node";

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

// Import only from a `"use node"` action. Store each result before downloading
// the next file; returning 30 buffers from an action can exceed its memory and
// argument limits. This module never reads credentials or allow-private flags.
const MIB = 1024 * 1024;
export const MEDIA_SNAPSHOT_MAX_URLS = 30;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MEDIA = {
  "image/jpeg": { extension: "jpg", maxBytes: 10 * MIB },
  "image/png": { extension: "png", maxBytes: 10 * MIB },
  "image/webp": { extension: "webp", maxBytes: 10 * MIB },
  "image/gif": { extension: "gif", maxBytes: 10 * MIB },
  "video/mp4": { extension: "mp4", maxBytes: 20 * MIB },
  "video/quicktime": { extension: "mov", maxBytes: 20 * MIB },
  "video/webm": { extension: "webm", maxBytes: 20 * MIB },
} as const;
export type SnapshotMediaType = keyof typeof MEDIA;
export class MediaDownloadError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MediaDownloadError";
  }
}
const reject = (code: string, message: string): never => { throw new MediaDownloadError(code, message); };

export interface DownloadedMediaSnapshot {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: SnapshotMediaType;
  extension: string;
  sizeBytes: number;
  contentHash: string;
  sourceUrl: string;
  finalUrl: string;
}
export interface MediaDownloadOptions {
  expectedKind?: "image" | "video";
  signal?: AbortSignal;
  /** May shorten, but never lengthen, the server-owned total download deadline. */
  timeoutMs?: number;
}
export interface ResolvedMediaAddress { address: string; family: 4 | 6 }
export interface MediaDownloadResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
/** Explicit transport injection for tests, never controlled by action arguments. */
export interface MediaDownloadTransport {
  resolve(hostname: string): Promise<ResolvedMediaAddress[]>;
  open(url: URL, address: ResolvedMediaAddress, signal: AbortSignal): Promise<MediaDownloadResponse>;
}

function checkedUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return reject("MEDIA_URL_BLOCKED", "올바른 HTTPS 미디어 주소가 필요합니다."); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (raw.length > 8_192 || url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || hostname === "localhost" || /\.(?:localhost|local|internal|lan|home)$/.test(hostname)
    || (!isIP(hostname) && !hostname.includes(".")))
    reject("MEDIA_URL_BLOCKED", "인증 정보가 없는 공개 HTTPS 미디어 주소만 사용할 수 있습니다.");
  return url;
}

/** Reject non-global ranges, including mapped/transition IPv6 and metadata IPs. */
export function isPublicMediaAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113) || address === "168.63.129.16");
  }
  if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return false;
  const parts = address.toLowerCase().split(":");
  const first = parseInt(parts[0] || "0", 16);
  const second = parseInt(parts[1] || "0", 16);
  // Permit native global unicast only. Everything else (loopback, ULA,
  // link-local, multicast, mapped IPv4, NAT64) fails closed.
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
    && first !== 0x2002 && first !== 0x3fff;
}

export function validateMediaSnapshotUrls(urls: readonly string[]): string[] {
  if (urls.length > MEDIA_SNAPSHOT_MAX_URLS)
    reject("MEDIA_COUNT_EXCEEDED", `미디어는 최대 ${MEDIA_SNAPSHOT_MAX_URLS}개까지 저장할 수 있습니다.`);
  return urls.map((url) => checkedUrl(url).toString());
}

const productionTransport: MediaDownloadTransport = {
  async resolve(hostname) {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  },
  open(url, address, signal) {
    return new Promise((resolve, rejectRequest) => {
      // Keep the original Host and TLS certificate identity while pinning the
      // TCP peer to an address checked above. No second DNS lookup or pooled
      // connection can move the request onto an unchecked address.
      const req = request(url, {
        method: "GET", agent: false, signal, family: address.family,
        rejectUnauthorized: true, maxHeaderSize: 16 * 1024, joinDuplicateHeaders: true,
        headers: { accept: "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm", "accept-encoding": "identity" },
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      }, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, close: () => res.destroy() }));
      req.on("error", rejectRequest);
      req.end();
    });
  },
};

function header(response: MediaDownloadResponse, name: string): string | undefined {
  const value = response.headers[name];
  if (Array.isArray(value)) return reject("MEDIA_RESPONSE_INVALID", "미디어 응답 헤더가 올바르지 않습니다.");
  return value?.trim();
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, rejectWork) => {
    const aborted = () => rejectWork(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, rejectWork).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Signature sniffing is an additional type check, not a full codec decoder. */
export function sniffSnapshotMediaType(bytes: Uint8Array): SnapshotMediaType | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return "image/gif";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 16 && b.toString("ascii", 4, 8) === "ftyp") {
    const boxSize = b.readUInt32BE(0);
    if (boxSize < 16 || boxSize > b.length) return null;
    const brand = b.toString("ascii", 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "hvc1", "hev1", "M4V ", "M4VH", "dash", "msdh", "msix"].includes(brand)) return "video/mp4";
  }
  if (b.length >= 12 && b.readUInt32BE(0) === 0x1a45dfa3) {
    // A WebM EBML header contains the DocType element (0x4282, size=4,
    // "webm"). A generic Matroska/EBML magic alone is not sufficient.
    if (b.subarray(4, Math.min(b.length, 4096)).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return "video/webm";
  }
  return null;
}

export function createMediaDownloader(transport: MediaDownloadTransport) {
  return async function download(rawUrl: string, options: MediaDownloadOptions = {}): Promise<DownloadedMediaSnapshot> {
    const source = checkedUrl(rawUrl);
    const timeoutMs = options.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) reject("MEDIA_OPTIONS_INVALID", "미디어 다운로드 제한 시간이 올바르지 않습니다.");
    const controller = new AbortController();
    const cancelled = () => controller.abort(new MediaDownloadError("MEDIA_CANCELLED", "미디어 저장이 취소되었습니다."));
    options.signal?.addEventListener("abort", cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
    const timer = setTimeout(() => controller.abort(new MediaDownloadError("MEDIA_TIMEOUT", "미디어 응답 시간이 초과되었습니다.")), Math.min(timeoutMs, MEDIA_DOWNLOAD_TIMEOUT_MS));
    let response: MediaDownloadResponse | undefined;
    try {
      let url = source;
      for (let redirects = 0; ; redirects++) {
        controller.signal.throwIfAborted();
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const literalFamily = isIP(hostname);
        const addresses = literalFamily
          ? [{ address: hostname, family: literalFamily as 4 | 6 }]
          : await abortable(transport.resolve(hostname), controller.signal);
        if (addresses.length === 0 || addresses.some((entry) => isIP(entry.address) !== entry.family || !isPublicMediaAddress(entry.address)))
          reject("MEDIA_URL_BLOCKED", "공개 인터넷에서 확인 가능한 미디어 주소만 저장할 수 있습니다.");
        const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
        controller.signal.throwIfAborted();
        response = await abortable(transport.open(url, address, controller.signal), controller.signal);
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = header(response, "location");
        response.close();
        response = undefined;
        if (!location || redirects >= MAX_REDIRECTS) reject("MEDIA_REDIRECT", "미디어 주소 이동 횟수가 초과되었거나 이동 주소가 없습니다.");
        let next: URL;
        try { next = new URL(location!, url); } catch { return reject("MEDIA_URL_BLOCKED", "미디어 이동 주소가 올바르지 않습니다."); }
        url = checkedUrl(next.toString());
      }
      if (response.status !== 200) reject("MEDIA_DOWNLOAD_FAILED", `미디어를 가져올 수 없습니다. (HTTP ${response.status})`);
      const encoding = header(response, "content-encoding")?.toLowerCase();
      if (encoding && encoding !== "identity") reject("MEDIA_ENCODING_UNSUPPORTED", "압축 전송된 미디어는 저장할 수 없습니다.");
      const declaredType = header(response, "content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!declaredType || !(declaredType in MEDIA)) reject("MEDIA_TYPE_UNSUPPORTED", "지원하는 이미지 또는 영상 형식이 아닙니다.");
      const mimeType = declaredType as SnapshotMediaType;
      if (options.expectedKind && !mimeType.startsWith(`${options.expectedKind}/`)) reject("MEDIA_TYPE_MISMATCH", "선택한 미디어 종류와 원본 파일 형식이 다릅니다.");
      const policy = MEDIA[mimeType];
      const lengthHeader = header(response, "content-length");
      if (lengthHeader !== undefined && !/^\d+$/.test(lengthHeader)) reject("MEDIA_RESPONSE_INVALID", "미디어 크기 응답이 올바르지 않습니다.");
      const declaredLength = lengthHeader === undefined ? undefined : Number(lengthHeader);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength > policy.maxBytes)) reject("MEDIA_TOO_LARGE", `미디어는 최대 ${policy.maxBytes / MIB}MB까지 저장할 수 있습니다.`);
      // A fixed-size buffer also bounds allocation overhead if a hostile peer
      // streams millions of tiny chunks instead of ordinary network buffers.
      const collected = Buffer.allocUnsafe(policy.maxBytes);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const part = await abortable(iterator.next(), controller.signal);
        if (part.done) break;
        sizeBytes += part.value.byteLength;
        if (sizeBytes > policy.maxBytes) reject("MEDIA_TOO_LARGE", `미디어는 최대 ${policy.maxBytes / MIB}MB까지 저장할 수 있습니다.`);
        hash.update(part.value);
        collected.set(part.value, sizeBytes - part.value.byteLength);
      }
      if (!sizeBytes || (declaredLength !== undefined && sizeBytes !== declaredLength)) reject("MEDIA_RESPONSE_INVALID", "미디어가 비어 있거나 다운로드가 완료되지 않았습니다.");
      const bytes = new Uint8Array(collected.subarray(0, sizeBytes));
      if (sniffSnapshotMediaType(bytes) !== mimeType) reject("MEDIA_TYPE_MISMATCH", "미디어의 실제 파일 형식과 응답 형식이 다릅니다.");
      return { bytes, mimeType, extension: policy.extension, sizeBytes, contentHash: hash.digest("hex"), sourceUrl: source.toString(), finalUrl: url.toString() };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof MediaDownloadError) throw error;
      // Avoid reflecting signed URLs, credentials, DNS details or raw network
      // errors into public action error messages. Certificate errors fail closed.
      throw new MediaDownloadError("MEDIA_DOWNLOAD_FAILED", "미디어 연결 또는 다운로드에 실패했습니다. 공개 원본 주소를 확인하세요.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancelled);
      response?.close();
    }
  };
}

export const downloadMediaSnapshot = createMediaDownloader(productionTransport);
