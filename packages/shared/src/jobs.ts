import type { Channel, ContentAtom, ProductBrief } from "./content";
/** 데스크톱 에이전트 ↔ 클라우드 잡 계약 (docs/01-architecture.md §2.2) */
export const JOB_TYPES = ["post.publish", "space.create", "space.login", "space.verify", "codex.login", "content.generate"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["NEEDS_APPROVAL", "QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const SNS_PLATFORMS = ["THREADS", "X", "INSTAGRAM", "TIKTOK", "NAVER_BLOG"] as const;
export type SnsPlatform = (typeof SNS_PLATFORMS)[number];

export const SPACE_STATES = ["CREATED", "LOGIN_REQUIRED", "HEALTHY", "RUNNING", "EXPIRED", "RESTRICTED", "PAUSED"] as const;
export type SpaceState = (typeof SPACE_STATES)[number];

export const AGENT_ERROR_CODES = [
  "SPACE_LOCKED",
  "SPACE_SESSION_EXPIRED",
  "SPACE_ACCOUNT_RESTRICTED",
  "SPACE_NOT_FOUND",
  "CODEX_LOGIN_REQUIRED",
  "RECIPE_FAILED",
  "RECIPE_UNSUPPORTED",
  "RATE_LIMIT_DAILY_REACHED",
  "AGENT_OFFLINE",
  "AGENT_LOST",
  "AGENT_LOST_UNCERTAIN",
  "APP_UPDATE_REQUIRED",
  "JOB_CANCELLED",
  "INTERNAL",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export const JOB_LEASE_MS = 120_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const DEVICE_ONLINE_MS = 90_000;
export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;

/** 결과 봉투 (blogautomcp job-result/v1 계승) */
export interface JobResultEnvelope {
  schema: "automoney.job-result/v1";
  jobType: JobType;
  kind: "ok" | "error" | "needs_action";
  summary: string;
  data: Record<string, unknown>;
  warnings: string[];
  nextAction?: string;
  errorCode?: AgentErrorCode | null;
}

export function okResult(jobType: JobType, summary: string, data: Record<string, unknown> = {}, warnings: string[] = []): JobResultEnvelope {
  return { schema: "automoney.job-result/v1", jobType, kind: "ok", summary, data, warnings, errorCode: null };
}

export function errorResult(jobType: JobType, errorCode: AgentErrorCode, summary: string, data: Record<string, unknown> = {}, nextAction?: string): JobResultEnvelope {
  return { schema: "automoney.job-result/v1", jobType, kind: "error", summary, data, warnings: [], nextAction, errorCode };
}

/** 발행 잡 페이로드 */
export interface PublishPayload {
  spaceId: string;
  platform: SnsPlatform;
  text: string;
  mediaUrls: string[];
  linkUrl?: string | null;
  dryRun?: boolean;
}

/** 플랫폼별 발행 텍스트 규격 (docs/06 §2) */
export const PLATFORM_LIMITS: Record<SnsPlatform, { maxChars: number; maxMedia: number; dailyDefault: number; mediaRequired: boolean; mediaKinds: ("image" | "video")[] }> = {
  THREADS: { maxChars: 500, maxMedia: 10, dailyDefault: 5, mediaRequired: false, mediaKinds: ["image", "video"] },
  X: { maxChars: 280, maxMedia: 4, dailyDefault: 5, mediaRequired: false, mediaKinds: ["image", "video"] },
  INSTAGRAM: { maxChars: 2200, maxMedia: 10, dailyDefault: 3, mediaRequired: true, mediaKinds: ["image", "video"] },
  TIKTOK: { maxChars: 2200, maxMedia: 1, dailyDefault: 2, mediaRequired: true, mediaKinds: ["video"] },
  NAVER_BLOG: { maxChars: 20000, maxMedia: 30, dailyDefault: 1, mediaRequired: false, mediaKinds: ["image"] },
};

/** URL 확장자로 미디어 종류 추정 (다운로드 전 사전 검증용) */
export function guessMediaKind(url: string): "image" | "video" | "unknown" {
  const path = url.split("?")[0]!.toLowerCase();
  if (/\.(jpe?g|png|webp|gif|heic)$/.test(path)) return "image";
  if (/\.(mp4|mov|m4v|webm)$/.test(path)) return "video";
  return "unknown";
}

export function validatePublishPayload(p: PublishPayload): string | null {
  const lim = PLATFORM_LIMITS[p.platform];
  if (!lim) return "unsupported platform";
  const text = (p.text ?? "").trim();
  if (!text && p.mediaUrls.length === 0) return "text or media required";
  const full = p.linkUrl ? `${text}\n${p.linkUrl}` : text;
  if ([...full].length > lim.maxChars) return `text exceeds ${lim.maxChars} chars`;
  if (p.mediaUrls.length > lim.maxMedia) return `too many media (max ${lim.maxMedia})`;
  if (lim.mediaRequired && p.mediaUrls.length === 0) return `${p.platform} requires media`;
  for (const u of p.mediaUrls) {
    if (!/^https?:\/\//.test(u)) return "media url must be http(s)";
    const kind = guessMediaKind(u);
    if (kind !== "unknown" && !lim.mediaKinds.includes(kind)) return `${p.platform} does not accept ${kind}`;
  }
  return null;
}

/** 콘텐츠 생성 잡 페이로드 (유저 PC 의 Codex 가 수행) */
export interface ContentGeneratePayload {
  channels: Channel[];
  atoms: ContentAtom[];
  products: ProductBrief[];
  magazineId?: string | null;
  magazineTitle?: string | null;
  brand?: string;
}
