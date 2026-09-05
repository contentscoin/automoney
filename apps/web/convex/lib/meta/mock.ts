import { LONG_LIVED_TTL_MS, META_SCOPES, MetaApiError, type MetaAdapter, type MetaInsights, type MetaPlatform, type MetaProfile, type MetaPublishInput, type MetaPublishResult, type MetaTokens } from "./adapter";

/**
 * Mock 어댑터: 앱 자격증명·앱 리뷰 없이 전체 플로우(연결 → 발행 → 인사이트)를 검증한다.
 * - code "mock" / "mock:<이름>" 으로 연결. 토큰은 "mock-<platform>-<이름>".
 * - 토큰이 "expired-" 로 시작하면 META_TOKEN_EXPIRED, 본문에 "[meta-fail]" 이 있으면 META_PUBLISH_FAILED (폴백 테스트용).
 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h >>> 0);
}

function assertToken(token: string) {
  if (token.startsWith("expired-")) throw new MetaApiError("META_TOKEN_EXPIRED", "mock: token expired");
  if (!token.startsWith("mock-")) throw new MetaApiError("META_PERMISSION", "mock: unknown token");
}

export const mockMetaAdapter: MetaAdapter = {
  mode: "mock",
  authorizeUrl(platform, redirectUri, state) {
    const u = new URL(redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("code", `mock:${platform.toLowerCase()}_user`);
    return u.toString();
  },
  async exchangeCode(platform, code) {
    if (!code.startsWith("mock")) throw new MetaApiError("META_CONFIG", "mock: code must start with 'mock'");
    const name = code.includes(":") ? code.split(":")[1]! : `${platform.toLowerCase()}_user`;
    return { accessToken: `mock-${platform}-${name}`, expiresAt: Date.now() + LONG_LIVED_TTL_MS, scopes: META_SCOPES[platform] };
  },
  async refreshLongLived(platform, accessToken) {
    assertToken(accessToken);
    return { accessToken, expiresAt: Date.now() + LONG_LIVED_TTL_MS, scopes: META_SCOPES[platform] };
  },
  async me(platform, accessToken) {
    assertToken(accessToken);
    const name = accessToken.split("-").slice(2).join("-") || `${platform.toLowerCase()}_user`;
    return { providerUserId: `mock_${platform}_${hash(name)}`, username: name };
  },
  async publish(accessToken, profile, input): Promise<MetaPublishResult> {
    assertToken(accessToken);
    if (input.text.includes("[meta-fail]")) throw new MetaApiError("META_PUBLISH_FAILED", "mock: forced publish failure");
    if (input.platform === "INSTAGRAM" && input.mediaUrls.length === 0) throw new MetaApiError("META_PUBLISH_FAILED", "instagram requires media");
    const id = `MOCK${hash(`${profile.providerUserId}:${input.text}:${Date.now()}`).toString(36).toUpperCase()}`;
    const user = profile.username ?? "mock";
    return { externalPostId: id, postUrl: input.platform === "THREADS" ? `https://www.threads.net/@${user}/post/${id}` : `https://www.instagram.com/p/${id}/` };
  },
  async insights(platform: MetaPlatform, accessToken, externalPostId): Promise<MetaInsights> {
    assertToken(accessToken);
    const h = hash(externalPostId);
    const base = 100 + (h % 900);
    return { impressions: base * 3, reach: base * 2, likes: Math.round(base * 0.12), comments: Math.round(base * 0.02), saves: platform === "INSTAGRAM" ? Math.round(base * 0.03) : undefined, shares: Math.round(base * 0.01) };
  },
};

export type { MetaProfile, MetaPublishInput };
