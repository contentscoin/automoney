import type { SnsPlatform } from "@automoney/shared";

function normalizeHandle(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^@/, "").toLowerCase();
  return normalized || null;
}

function canonicalReceiptUrl(platform: SnsPlatform, raw: unknown, expectedHandle?: string): string | null {
  if (typeof raw !== "string" || raw.length > 2_000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const handle = normalizeHandle(expectedHandle);
    const pathHandle = url.pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "").toLowerCase() ?? null;
    switch (platform) {
      case "X":
        return host === "x.com" && /^\/[^/?#]+\/status\/\d+\/?$/i.test(url.pathname) && (!handle || pathHandle === handle) ? url.toString() : null;
      case "THREADS":
        return host === "threads.net" && /^\/@?[^/?#]+\/post\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname) && (!handle || pathHandle === handle) ? url.toString() : null;
      case "INSTAGRAM":
        return host === "instagram.com" && /^\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname) ? url.toString() : null;
      case "TIKTOK":
        return host === "tiktok.com" && /^\/@?[^/?#]+\/video\/\d+\/?$/i.test(url.pathname) && (!handle || pathHandle === handle) ? url.toString() : null;
      case "NAVER_BLOG":
        return host === "blog.naver.com" && (
          (/^\/[^/?#]+\/\d{5,}\/?$/i.test(url.pathname) && (!handle || pathHandle === handle))
          || (/^\/PostView\.naver$/i.test(url.pathname)
            && /^\d+$/.test(url.searchParams.get("logNo") ?? "")
            && (!handle || normalizeHandle(url.searchParams.get("blogId") ?? undefined) === handle))
        ) ? url.toString() : null;
    }
  } catch {
    return null;
  }
}

/** A live success is accepted only with a canonical receipt owned by the target platform. */
export function publishReceiptUrl(platform: SnsPlatform, result: unknown, expectedHandle?: string): string | null {
  const data = result && typeof result === "object"
    ? (result as { data?: unknown }).data
    : null;
  const postUrl = data && typeof data === "object"
    ? (data as { postUrl?: unknown }).postUrl
    : null;
  return canonicalReceiptUrl(platform, postUrl, expectedHandle);
}
