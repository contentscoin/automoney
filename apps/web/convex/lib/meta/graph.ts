import { LONG_LIVED_TTL_MS, META_SCOPES, MetaApiError, type MetaAdapter, type MetaInsights, type MetaPlatform, type MetaProfile, type MetaPublishInput, type MetaPublishResult, type MetaTokens } from "./adapter";

/**
 * 실 Graph API 어댑터. Threads API(graph.threads.net) · Instagram API with Instagram Login(graph.instagram.com).
 * 앱 리뷰 승인 전에는 테스터 계정만 동작한다(docs/04 §2.4). 미디어 URL 은 공개 접근 가능해야 한다.
 */
const THREADS = "https://graph.threads.net/v1.0";
const IG = "https://graph.instagram.com/v21.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; type?: string; message?: string; error_subcode?: number } } & T;
  if (!res.ok || body.error) {
    const e = body.error ?? {};
    const msg = `${e.type ?? res.status}: ${e.message ?? "graph api error"}`;
    if (e.code === 190 || e.error_subcode === 463 || e.error_subcode === 467) throw new MetaApiError("META_TOKEN_EXPIRED", msg);
    if (e.code === 10 || e.code === 200 || e.code === 299) throw new MetaApiError("META_PERMISSION", msg);
    if (e.code === 4 || e.code === 17 || e.code === 32 || res.status === 429) throw new MetaApiError("META_RATE_LIMITED", msg, true);
    throw new MetaApiError("META_PUBLISH_FAILED", msg, res.status >= 500);
  }
  return body;
}

const form = (data: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() });

export function createGraphAdapter(cfg: { appId: string; appSecret: string }): MetaAdapter {
  return {
    mode: "graph",
    authorizeUrl(platform, redirectUri, state) {
      const base = platform === "THREADS" ? "https://threads.net/oauth/authorize" : "https://www.instagram.com/oauth/authorize";
      const u = new URL(base);
      u.searchParams.set("client_id", cfg.appId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("scope", META_SCOPES[platform].join(","));
      u.searchParams.set("response_type", "code");
      u.searchParams.set("state", state);
      return u.toString();
    },
    async exchangeCode(platform, code, redirectUri): Promise<MetaTokens> {
      const tokenUrl = platform === "THREADS" ? `${THREADS}/oauth/access_token` : "https://api.instagram.com/oauth/access_token";
      const short = await call<{ access_token: string }>(tokenUrl, form({ client_id: cfg.appId, client_secret: cfg.appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code }));
      const exchangeUrl = platform === "THREADS" ? `${THREADS}/access_token?grant_type=th_exchange_token&client_secret=${cfg.appSecret}&access_token=${short.access_token}` : `${IG}/access_token?grant_type=ig_exchange_token&client_secret=${cfg.appSecret}&access_token=${short.access_token}`;
      const long = await call<{ access_token: string; expires_in?: number }>(exchangeUrl);
      return { accessToken: long.access_token, expiresAt: Date.now() + (long.expires_in ? long.expires_in * 1000 : LONG_LIVED_TTL_MS), scopes: META_SCOPES[platform] };
    },
    async refreshLongLived(platform, accessToken) {
      const url = platform === "THREADS" ? `${THREADS}/refresh_access_token?grant_type=th_refresh_token&access_token=${accessToken}` : `${IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${accessToken}`;
      const r = await call<{ access_token: string; expires_in?: number }>(url);
      return { accessToken: r.access_token, expiresAt: Date.now() + (r.expires_in ? r.expires_in * 1000 : LONG_LIVED_TTL_MS), scopes: META_SCOPES[platform] };
    },
    async me(platform, accessToken): Promise<MetaProfile> {
      const url = platform === "THREADS" ? `${THREADS}/me?fields=id,username&access_token=${accessToken}` : `${IG}/me?fields=user_id,username&access_token=${accessToken}`;
      const r = await call<{ id?: string; user_id?: string; username?: string }>(url);
      return { providerUserId: String(r.id ?? r.user_id), username: r.username ?? null };
    },
    async publish(accessToken, profile, input): Promise<MetaPublishResult> {
      const text = input.linkUrl && !input.text.includes(input.linkUrl) ? `${input.text}\n${input.linkUrl}` : input.text;
      if (input.platform === "THREADS") {
        const media = input.mediaUrls[0];
        const kind = media ? (/\.(mp4|mov)(\?|$)/i.test(media) ? "VIDEO" : "IMAGE") : "TEXT";
        const params: Record<string, string> = { media_type: kind, text, access_token: accessToken };
        if (kind === "IMAGE") params.image_url = media!;
        if (kind === "VIDEO") params.video_url = media!;
        const c = await call<{ id: string }>(`${THREADS}/${profile.providerUserId}/threads`, form(params));
        if (kind === "VIDEO") await sleep(15_000);
        const p = await call<{ id: string }>(`${THREADS}/${profile.providerUserId}/threads_publish`, form({ creation_id: c.id, access_token: accessToken }));
        const info = await call<{ permalink?: string }>(`${THREADS}/${p.id}?fields=permalink&access_token=${accessToken}`).catch(() => ({ permalink: undefined }));
        return { externalPostId: p.id, postUrl: info.permalink ?? `https://www.threads.net/@${profile.username ?? ""}/post/${p.id}` };
      }
      if (input.mediaUrls.length === 0) throw new MetaApiError("META_PUBLISH_FAILED", "instagram requires media");
      const media = input.mediaUrls[0]!;
      const isVideo = /\.(mp4|mov)(\?|$)/i.test(media);
      const params: Record<string, string> = { caption: text, access_token: accessToken };
      if (isVideo) {
        params.media_type = "REELS";
        params.video_url = media;
      } else params.image_url = media;
      const c = await call<{ id: string }>(`${IG}/${profile.providerUserId}/media`, form(params));
      if (isVideo) {
        for (let i = 0; i < 20; i++) {
          const st = await call<{ status_code?: string }>(`${IG}/${c.id}?fields=status_code&access_token=${accessToken}`);
          if (st.status_code === "FINISHED") break;
          if (st.status_code === "ERROR") throw new MetaApiError("META_PUBLISH_FAILED", "reel processing failed");
          await sleep(5000);
        }
      }
      const p = await call<{ id: string }>(`${IG}/${profile.providerUserId}/media_publish`, form({ creation_id: c.id, access_token: accessToken }));
      const info = await call<{ permalink?: string }>(`${IG}/${p.id}?fields=permalink&access_token=${accessToken}`).catch(() => ({ permalink: undefined }));
      return { externalPostId: p.id, postUrl: info.permalink ?? `https://www.instagram.com/p/${p.id}/` };
    },
    async insights(platform, accessToken, externalPostId): Promise<MetaInsights> {
      const metrics = platform === "THREADS" ? "views,likes,replies,reposts,shares" : "impressions,reach,likes,comments,saved,shares";
      const url = `${platform === "THREADS" ? THREADS : IG}/${externalPostId}/insights?metric=${metrics}&access_token=${accessToken}`;
      const r = await call<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(url);
      const get = (n: string) => {
        const m = r.data?.find((d) => d.name === n);
        return m?.total_value?.value ?? m?.values?.[0]?.value;
      };
      return platform === "THREADS"
        ? { impressions: get("views"), reach: get("views"), likes: get("likes"), comments: get("replies"), shares: (get("reposts") ?? 0) + (get("shares") ?? 0) }
        : { impressions: get("impressions"), reach: get("reach"), likes: get("likes"), comments: get("comments"), saves: get("saved"), shares: get("shares") };
    },
  };
}
