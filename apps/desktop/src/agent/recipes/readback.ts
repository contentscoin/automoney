import type { Page } from "playwright";

export interface PostMetrics {
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  views?: number;
}

/** "1.2만", "3,456", "12K", "1.5M" → 정수 */
export function parseCount(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/,/g, "").trim();
  const m = /(\d+(?:\.\d+)?)\s*(만|천|k|m|K|M)?/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "만" ? 10_000 : unit === "천" ? 1_000 : unit === "k" || unit === "K" ? 1_000 : unit === "m" || unit === "M" ? 1_000_000 : 1;
  return Math.round(n * mult);
}

/**
 * 플랫폼 공통 지표 읽기: 픽스처 훅(data-automoney="likes|comments|shares|saves|views") 우선,
 * 없으면 플랫폼별 aria-label / testid 후보를 순서대로 시도한다. 읽지 못한 지표는 undefined.
 */
const SELECTORS: Record<string, Record<keyof PostMetrics, string[]>> = {
  X: {
    likes: ['[data-testid="like"] span', '[data-testid="unlike"] span', '[aria-label*="Like"]', '[aria-label*="마음에 들어요"]'],
    comments: ['[data-testid="reply"] span', '[aria-label*="Repl"]', '[aria-label*="답글"]'],
    shares: ['[data-testid="retweet"] span', '[aria-label*="Repost"]', '[aria-label*="재게시"]'],
    saves: ['[data-testid="bookmark"] span'],
    views: ['a[href$="/analytics"] span', '[aria-label*="View"]', '[aria-label*="조회"]'],
  },
  THREADS: {
    likes: ['[aria-label*="좋아요"]', '[aria-label*="Like"]'],
    comments: ['[aria-label*="답글"]', '[aria-label*="Repl"]'],
    shares: ['[aria-label*="리포스트"]', '[aria-label*="Repost"]'],
    saves: [],
    views: ['[aria-label*="조회"]', '[aria-label*="view"]'],
  },
  INSTAGRAM: {
    likes: ['section span a span', 'a[href$="/liked_by/"] span', '[aria-label*="좋아요"]'],
    comments: ['ul li span', '[aria-label*="댓글"]'],
    shares: [],
    saves: [],
    views: ['span:has-text("조회")', 'span:has-text("views")'],
  },
  TIKTOK: {
    likes: ['[data-e2e="like-count"]', '[data-e2e="browse-like-count"]'],
    comments: ['[data-e2e="comment-count"]', '[data-e2e="browse-comment-count"]'],
    shares: ['[data-e2e="share-count"]'],
    saves: ['[data-e2e="undefined-count"]'],
    views: ['[data-e2e="video-views"]'],
  },
  NAVER_BLOG: {
    likes: ['.u_cnt._count', '.sympathy_cnt'],
    comments: ['.btn_comment .num', '#commentCount'],
    shares: [],
    saves: [],
    views: ['.se_view_count', '.count_cnt'],
  },
};

export async function readPostMetrics(page: Page, platform: string): Promise<PostMetrics> {
  const out: PostMetrics = {};
  const keys: (keyof PostMetrics)[] = ["likes", "comments", "shares", "saves", "views"];
  for (const k of keys) {
    const hook = page.locator(`[data-automoney="${k}"]`).first();
    if (await hook.count().catch(() => 0)) {
      const v = parseCount(await hook.getAttribute("data-value").catch(() => null)) ?? parseCount(await hook.innerText().catch(() => null));
      if (v !== undefined) out[k] = v;
      continue;
    }
    for (const sel of SELECTORS[platform]?.[k] ?? []) {
      const loc = page.locator(sel).first();
      if (!(await loc.count().catch(() => 0))) continue;
      const v = parseCount(await loc.getAttribute("aria-label").catch(() => null)) ?? parseCount(await loc.innerText().catch(() => null));
      if (v !== undefined) {
        out[k] = v;
        break;
      }
    }
  }
  return out;
}
