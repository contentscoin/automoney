import type { Page } from "playwright";
import { resolveAllowedNavigationUrl } from "./actions";

export interface PublishReceiptBaseline {
  pageUrl: string | null;
  urls: string[];
  capturedAt: number;
  expectedHandle: string | null;
}

export interface PublishReceipt {
  verified: boolean;
  postUrl: string | null;
  source: "current-url" | "dom-link" | null;
  reason?: string;
}

interface CanonicalPost {
  url: string;
  handle: string | null;
}

const RECEIPT_MAX_AGE_MS = 2 * 60_000;
const ACCOUNT_BOUND_PLATFORMS = new Set(["X", "THREADS", "TIKTOK", "NAVER_BLOG"]);

export function normalizePublishHandle(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  let value = raw.trim();
  try {
    if (/^https?:\/\//i.test(value)) value = new URL(value).pathname;
  } catch {
    return null;
  }
  value = value.replace(/^\/+/, "").replace(/^@/, "").split(/[/?#]/, 1)[0] ?? "";
  try { value = decodeURIComponent(value); } catch { return null; }
  return value ? value.toLocaleLowerCase("en-US") : null;
}

function canonicalPost(raw: string, platform: string, baseUrl: string): CanonicalPost | null {
  const allowed = resolveAllowedNavigationUrl(raw, platform, baseUrl);
  if (!allowed) return null;
  try {
    const url = new URL(allowed);
    const kind = platform.toUpperCase();
    let match: RegExpMatchArray | null;
    switch (kind) {
      case "X":
        match = url.pathname.match(/^\/([^/?#]+)\/status\/(\d+)(?:[/?#]|$)/i);
        return match ? { url: `https://x.com/${match[1]}/status/${match[2]}`, handle: normalizePublishHandle(match[1]) } : null;
      case "THREADS":
        match = url.pathname.match(/^\/(@?[^/?#]+)\/post\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i);
        return match ? { url: `https://www.threads.net/${match[1]}/post/${match[2]}`, handle: normalizePublishHandle(match[1]) } : null;
      case "INSTAGRAM":
        match = url.pathname.match(/^\/(p|reel)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i);
        return match ? { url: `https://www.instagram.com/${match[1]!.toLowerCase()}/${match[2]}`, handle: null } : null;
      case "TIKTOK":
        match = url.pathname.match(/^\/(@?[^/?#]+)\/video\/(\d+)(?:[/?#]|$)/i);
        return match ? { url: `https://www.tiktok.com/${match[1]}/video/${match[2]}`, handle: normalizePublishHandle(match[1]) } : null;
      case "NAVER_BLOG": {
        match = url.pathname.match(/^\/([^/?#]+)\/(\d{5,})(?:[/?#]|$)/i);
        if (match) return { url: `https://blog.naver.com/${match[1]}/${match[2]}`, handle: normalizePublishHandle(match[1]) };
        if (!/^\/PostView\.naver$/i.test(url.pathname)) return null;
        const logNo = url.searchParams.get("logNo");
        if (!logNo || !/^\d+$/.test(logNo)) return null;
        const blogId = url.searchParams.get("blogId");
        return {
          url: `https://blog.naver.com/PostView.naver?${blogId ? `blogId=${encodeURIComponent(blogId)}&` : ""}logNo=${logNo}`,
          handle: normalizePublishHandle(blogId),
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function belongsToExpectedAccount(candidate: CanonicalPost | null, platform: string, expectedHandle: string | null): candidate is CanonicalPost {
  if (!candidate) return false;
  const kind = platform.toUpperCase();
  if (!ACCOUNT_BOUND_PLATFORMS.has(kind)) return true;
  return !!expectedHandle && candidate.handle === expectedHandle;
}

async function receiptCandidates(page: Page, platform: string, expectedHandle: string | null): Promise<{ pageUrl: string | null; urls: string[] }> {
  const baseUrl = page.url();
  const pageCandidate = canonicalPost(baseUrl, platform, baseUrl);
  const pageUrl = belongsToExpectedAccount(pageCandidate, platform, expectedHandle) ? pageCandidate.url : null;
  const hrefs = await page.locator('a[href], [data-automoney="post-link"][href]').evaluateAll((nodes) =>
    nodes.slice(0, 500).map((node) => (node as HTMLAnchorElement).href || node.getAttribute("href") || ""),
  ).catch(() => [] as string[]);
  const urls = [...new Set(hrefs
    .map((href) => canonicalPost(href, platform, baseUrl))
    .filter((candidate) => belongsToExpectedAccount(candidate, platform, expectedHandle))
    .map((candidate) => candidate.url))];
  return { pageUrl, urls };
}

/** Snapshot existing receipts immediately before the one approved publish click. */
export async function capturePublishReceiptBaseline(page: Page, platform: string, expectedHandle: string | null): Promise<PublishReceiptBaseline> {
  const normalizedHandle = normalizePublishHandle(expectedHandle);
  return { ...await receiptCandidates(page, platform, normalizedHandle), capturedAt: Date.now(), expectedHandle: normalizedHandle };
}

/**
 * A model-provided URL is never trusted. Success requires a new platform URL in
 * the browser URL or DOM that did not exist before the approved publish click.
 */
export async function verifyPublishReceipt(page: Page, platform: string, baseline: PublishReceiptBaseline): Promise<PublishReceipt> {
  const age = Date.now() - baseline.capturedAt;
  if (age < 0 || age > RECEIPT_MAX_AGE_MS) {
    return { verified: false, postUrl: null, source: null, reason: "publish receipt verification window expired" };
  }
  if (ACCOUNT_BOUND_PLATFORMS.has(platform.toUpperCase()) && !baseline.expectedHandle) {
    return { verified: false, postUrl: null, source: null, reason: "expected account handle unavailable" };
  }
  const current = await receiptCandidates(page, platform, baseline.expectedHandle);
  if (current.pageUrl && current.pageUrl !== baseline.pageUrl) {
    return { verified: true, postUrl: current.pageUrl, source: "current-url" };
  }
  const before = new Set(baseline.urls);
  const fresh = current.urls.find((url) => !before.has(url));
  if (fresh) return { verified: true, postUrl: fresh, source: "dom-link" };
  return { verified: false, postUrl: null, source: null, reason: "no new canonical post receipt in URL or DOM" };
}
