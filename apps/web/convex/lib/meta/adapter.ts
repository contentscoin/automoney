/**
 * Meta(Threads · Instagram Graph API) 어댑터 인터페이스 (docs/04 §2, ADR-0004).
 * 실 구현(graph.ts)과 Mock(mock.ts)이 동일 계약을 지킨다. 토큰은 호출자가 복호화해 넘긴다.
 */
export type MetaPlatform = "THREADS" | "INSTAGRAM";

export interface MetaTokens {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
  scopes: string[];
}

export interface MetaProfile {
  providerUserId: string;
  username: string | null;
}

export interface MetaPublishInput {
  platform: MetaPlatform;
  text: string;
  mediaUrls: string[];
  linkUrl?: string | null;
}

export interface MetaPublishResult {
  externalPostId: string;
  postUrl: string;
}

export interface MetaInsights {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
}

export class MetaApiError extends Error {
  constructor(
    public code: "META_TOKEN_EXPIRED" | "META_PERMISSION" | "META_RATE_LIMITED" | "META_PUBLISH_FAILED" | "META_CONFIG",
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export interface MetaAdapter {
  readonly mode: "mock" | "graph";
  authorizeUrl(platform: MetaPlatform, redirectUri: string, state: string): string;
  exchangeCode(platform: MetaPlatform, code: string, redirectUri: string): Promise<MetaTokens>;
  refreshLongLived(platform: MetaPlatform, accessToken: string): Promise<MetaTokens>;
  me(platform: MetaPlatform, accessToken: string): Promise<MetaProfile>;
  publish(accessToken: string, profile: MetaProfile, input: MetaPublishInput): Promise<MetaPublishResult>;
  insights(platform: MetaPlatform, accessToken: string, externalPostId: string): Promise<MetaInsights>;
}

export const META_SCOPES: Record<MetaPlatform, string[]> = {
  THREADS: ["threads_basic", "threads_content_publish", "threads_manage_insights"],
  INSTAGRAM: ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"],
};

export const LONG_LIVED_TTL_MS = 60 * 24 * 60 * 60 * 1000;
