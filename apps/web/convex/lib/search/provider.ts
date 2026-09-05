/** 외부 검색 추상화 (docs/06 §4). 키가 있으면 Brave/SerpAPI, 없으면 none. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  imageUrl?: string | null;
  source: string;
}

export interface SearchProvider {
  name: string;
  available: boolean;
  search(query: string, opts?: { limit?: number; lang?: string }): Promise<SearchResult[]>;
}

export const noneProvider: SearchProvider = {
  name: "none",
  available: false,
  async search() {
    return [];
  },
};

export function braveProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "brave",
    available: true,
    async search(query, opts = {}) {
      const u = new URL("https://api.search.brave.com/res/v1/web/search");
      u.searchParams.set("q", query);
      u.searchParams.set("count", String(opts.limit ?? 8));
      u.searchParams.set("country", "KR");
      u.searchParams.set("search_lang", opts.lang ?? "ko");
      const res = await fetchImpl(u, { headers: { "X-Subscription-Token": apiKey, accept: "application/json" } });
      if (!res.ok) throw new Error(`brave ${res.status}`);
      const j = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string; thumbnail?: { src?: string } }[] } };
      return (j.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "", imageUrl: r.thumbnail?.src ?? null, source: "brave" }));
    },
  };
}

export function serpapiProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "serpapi",
    available: true,
    async search(query, opts = {}) {
      const u = new URL("https://serpapi.com/search.json");
      u.searchParams.set("engine", "google");
      u.searchParams.set("q", query);
      u.searchParams.set("hl", opts.lang ?? "ko");
      u.searchParams.set("gl", "kr");
      u.searchParams.set("num", String(opts.limit ?? 8));
      u.searchParams.set("api_key", apiKey);
      const res = await fetchImpl(u);
      if (!res.ok) throw new Error(`serpapi ${res.status}`);
      const j = (await res.json()) as { organic_results?: { title: string; link: string; snippet?: string; thumbnail?: string }[] };
      return (j.organic_results ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? "", imageUrl: r.thumbnail ?? null, source: "serpapi" }));
    },
  };
}

export function getSearchProvider(fetchImpl: typeof fetch = fetch): SearchProvider {
  if (process.env.BRAVE_API_KEY) return braveProvider(process.env.BRAVE_API_KEY, fetchImpl);
  if (process.env.SERPAPI_KEY) return serpapiProvider(process.env.SERPAPI_KEY, fetchImpl);
  return noneProvider;
}

/** 구글 트렌드 RSS(일간 급상승) 파싱 — 라이브러리 없이 최소 XML 처리 */
export function parseTrendsRss(xml: string): { title: string; traffic: string | null; link: string | null; newsTitle: string | null; newsUrl: string | null; pubDate: string | null }[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
  const pick = (block: string, tag: string) => {
    const m = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`).exec(block);
    return m?.[1]?.trim() ?? null;
  };
  return items
    .map((b) => ({
      title: pick(b, "title") ?? "",
      traffic: pick(b, "ht:approx_traffic"),
      link: pick(b, "link"),
      newsTitle: pick(b, "ht:news_item_title"),
      newsUrl: pick(b, "ht:news_item_url"),
      pubDate: pick(b, "pubDate"),
    }))
    .filter((t) => t.title.length > 0);
}

export const GOOGLE_TRENDS_KR_RSS = "https://trends.google.com/trending/rss?geo=KR";
