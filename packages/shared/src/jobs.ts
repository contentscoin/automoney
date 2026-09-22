import type {
  Channel,
  ContentAtom,
  ContentProductionBrief,
  ContentProductionStandard,
  ProductBrief,
} from "./content";
/** 데스크톱 에이전트 ↔ 클라우드 잡 계약 (docs/01-architecture.md §2.2) */
export const JOB_TYPES = ["post.publish", "space.create", "space.login", "space.verify", "codex.login", "content.generate", "post.readback", "meta.token_refresh"] as const;
/** 잡 실행 주체: DESKTOP = 유저 PC 에이전트, CLOUD = Convex 액션(Meta API 발행·토큰 갱신) */
export const JOB_EXECUTORS = ["DESKTOP", "CLOUD"] as const;
export type JobExecutor = (typeof JOB_EXECUTORS)[number];
export interface ReadbackPayload {
  spaceId: string;
  platform: SnsPlatform;
  postUrl: string;
  metricsId: string;
  window: "24h" | "72h" | "7d";
}
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["NEEDS_APPROVAL", "QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const SNS_PLATFORMS = ["THREADS", "X", "INSTAGRAM", "TIKTOK", "NAVER_BLOG"] as const;
export type SnsPlatform = (typeof SNS_PLATFORMS)[number];

export const SPACE_STATES = ["CREATED", "LOGIN_REQUIRED", "HEALTHY", "RUNNING", "EXPIRED", "RESTRICTED", "PAUSED"] as const;
export type SpaceState = (typeof SPACE_STATES)[number];

export const AGENT_ERROR_CODES = [
  "META_NOT_CONNECTED",
  "META_TOKEN_EXPIRED",
  "META_PERMISSION",
  "META_RATE_LIMITED",
  "META_PUBLISH_FAILED",
  "META_CONFIG",
  "READBACK_FAILED",
  "SPACE_LOCKED",
  "SPACE_SESSION_EXPIRED",
  "SPACE_ACCOUNT_RESTRICTED",
  "SPACE_NOT_FOUND",
  "BROWSER_NOT_FOUND",
  "CODEX_LOGIN_REQUIRED",
  "RECIPE_FAILED",
  "RECIPE_UNSUPPORTED",
  "RATE_LIMIT_DAILY_REACHED",
  "AGENT_OFFLINE",
  "AGENT_LOST",
  "AGENT_LOST_UNCERTAIN",
  "PUBLISH_RESULT_UNCERTAIN",
  "PUBLISH_RECEIPT_MISSING",
  "LOCAL_DRY_RUN_OVERRIDE",
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
  /** Immutable server-owned external account identity bound into approval. */
  targetPublicationKey?: string;
  /** Human-readable account handle captured with the approval target. */
  targetHandle?: string;
  /** Schedule revision that authorized this occurrence. Server-owned. */
  scheduleRevision?: number;
  /** Original content channel; preserves feed vs reel semantics. */
  contentChannel?: Channel;
  text: string;
  mediaUrls: string[];
  linkUrl?: string | null;
  /** 서버가 실행 직전 링크 상태·상품 연결을 재검증하기 위한 내부 참조 */
  linkId?: string;
  /** 게시 성공 시 콘텐츠 사용 횟수·성과를 연결하기 위한 내부 참조 */
  pieceId?: string;
  /** Workflow piece revision approved by the content gate. Server-owned. */
  pieceOutputHash?: string;
  /** Canonical text/media/link snapshot approved for this publish job. Server-owned. */
  pieceSnapshotHash?: string;
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

/** Content-level media contract, independent of the selected publishing account. */
export function validateContentMedia(channel: Channel, mediaUrls: string[]): string | null {
  if (mediaUrls.length > 10) return "media is limited to 10 items";
  if (mediaUrls.some((url) => !/^https:\/\//i.test(url))) return "media url must use https";
  if (channel === "INSTAGRAM_REEL" || channel === "TIKTOK") {
    if (mediaUrls.length !== 1) return `${channel} requires exactly one video`;
    if (guessMediaKind(mediaUrls[0]!) !== "video") return `${channel} requires a verifiable video URL`;
  }
  if (channel === "INSTAGRAM_FEED" && mediaUrls.some((url) => guessMediaKind(url) !== "image"))
    return "INSTAGRAM_FEED requires verifiable image URLs; videos must use INSTAGRAM_REEL";
  return null;
}

export function validatePublishPayload(p: PublishPayload): string | null {
  const lim = PLATFORM_LIMITS[p.platform];
  if (!lim) return "unsupported platform";
  const text = (p.text ?? "").trim();
  if (!text && p.mediaUrls.length === 0) return "text or media required";
  if (p.linkUrl) {
    try {
      const link = new URL(p.linkUrl);
      if (link.protocol !== "https:" || link.username || link.password) return "link url must be an absolute https URL";
    } catch {
      return "link url must be an absolute https URL";
    }
  }
  const full = p.linkUrl ? `${text}\n${p.linkUrl}` : text;
  if ([...full].length > lim.maxChars) return `text exceeds ${lim.maxChars} chars`;
  if (p.mediaUrls.length > lim.maxMedia) return `too many media (max ${lim.maxMedia})`;
  if (lim.mediaRequired && p.mediaUrls.length === 0) return `${p.platform} requires media`;
  if (p.platform === "INSTAGRAM" && p.contentChannel !== "INSTAGRAM_FEED" && p.contentChannel !== "INSTAGRAM_REEL")
    return "Instagram requires an explicit INSTAGRAM_FEED or INSTAGRAM_REEL channel";
  const videoOnly = p.platform === "TIKTOK" || p.contentChannel === "INSTAGRAM_REEL";
  const contentMediaError = p.contentChannel ? validateContentMedia(p.contentChannel, p.mediaUrls) : null;
  if (contentMediaError) return contentMediaError;
  if (videoOnly && p.mediaUrls.length !== 1) return `${p.contentChannel ?? p.platform} requires exactly one video`;
  for (const u of p.mediaUrls) {
    if (!/^https:\/\//.test(u)) return "media url must use https";
    const kind = guessMediaKind(u);
    if (videoOnly && kind !== "video") return `${p.contentChannel ?? p.platform} requires a verifiable video URL`;
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
  /** 분석 루프 플레이북 힌트(승격된 패턴) */
  playbook?: string[];
  /** 거절 사유 상위 패턴(피해야 할 것) */
  avoid?: string[];
  /** Stable identifier shared by every attempt in one production workflow. */
  runId?: string;
  /** V2 content intent. Optional so queued V1 jobs remain executable. */
  brief?: ContentProductionBrief;
  /** V2 quality contract snapshot. Optional so queued V1 jobs remain executable. */
  standard?: ContentProductionStandard;
}
