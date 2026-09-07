/**
 * Stateless MCP 툴 카탈로그 — 단일 소스(docs/04 §5, ADR-0003).
 * 서버(tools/list·검증), 대시보드(카탈로그 표), 테스트가 이 정의를 공유한다.
 */
export const MCP_SCOPES = ["mcp:read", "mcp:write", "admin:read", "super:read"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_SERVER_INFO = { name: "automoney", version: "0.5.0" } as const;
export const MCP_RATE_LIMITS = { perUserPerMinute: 120, perIpPerMinute: 600 } as const;

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  scope: McpScope;
  /** 위험 툴: `confirmed: true` 없이는 미리보기만 반환 */
  dangerous?: boolean;
  /** write 툴: 잡 id 를 반환하고 job_get 으로 결과를 폴링 */
  returnsJob?: boolean;
  inputSchema: JsonSchema;
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });
const bool = (description: string) => ({ type: "boolean", description });
const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

const CHANNEL_ENUM = ["INSTAGRAM_FEED", "INSTAGRAM_REEL", "THREADS", "X", "TIKTOK", "BLOG"];
const PLATFORM_ENUM = ["THREADS", "X", "INSTAGRAM", "TIKTOK", "NAVER_BLOG"];

export const MCP_TOOLS: McpToolDef[] = [
  { name: "agent_get_status", description: "내 데스크톱 에이전트·스페이스 상태와 최소 앱 버전을 조회합니다.", scope: "mcp:read", inputSchema: obj({}) },
  { name: "product_search", description: "아뜨랑스 상품을 이름으로 검색합니다(판매 중인 상품만).", scope: "mcp:read", inputSchema: obj({ term: str("검색어(비우면 최신순)"), limit: num("최대 개수(1~50)", { minimum: 1, maximum: 50 }) }) },
  { name: "link_issue", description: "상품의 내 마케팅 링크를 발급합니다(이미 있으면 기존 링크 반환).", scope: "mcp:write", inputSchema: obj({ productId: str("product_search 결과의 _id") }, ["productId"]) },
  { name: "link_list", description: "내 마케팅 링크 목록과 클릭 수를 조회합니다.", scope: "mcp:read", inputSchema: obj({}) },
  { name: "earnings_get", description: "이번 달 실적(클릭·주문·매출)과 예상 수당, 차월 정산 예정액을 조회합니다.", scope: "mcp:read", inputSchema: obj({}) },
  { name: "settlement_history", description: "내 정산 히스토리(월별 상태·금액)를 조회합니다.", scope: "mcp:read", inputSchema: obj({}) },
  { name: "magazine_today", description: "최근 등록된 아뜨랑스 매거진(소재 수·상품 수)을 조회합니다.", scope: "mcp:read", inputSchema: obj({ limit: num("최대 개수(1~20)", { minimum: 1, maximum: 20 }) }) },
  { name: "content_generate", description: "매거진 또는 상품 기준으로 채널별 콘텐츠 생성을 요청합니다. 생성은 내 PC 의 Codex 가 수행하며 잡 id 를 반환합니다.", scope: "mcp:write", returnsJob: true, inputSchema: obj({ magazineId: str("magazine_today 결과의 _id"), productId: str("상품 _id"), channels: { type: "array", items: { type: "string", enum: CHANNEL_ENUM }, minItems: 1, description: "생성할 채널" } }, ["channels"]) },
  { name: "content_list", description: "내 콘텐츠 라이브러리(내 조각 + 운영 공유 조각)를 조회합니다.", scope: "mcp:read", inputSchema: obj({ channel: str("채널 필터", { enum: CHANNEL_ENUM }), status: str("상태 필터", { enum: ["DRAFT", "APPROVED"] }), limit: num("최대 개수(1~100)", { minimum: 1, maximum: 100 }) }) },
  { name: "content_get", description: "콘텐츠 조각 하나(본문·해시태그·대본·품질 리포트)를 조회합니다.", scope: "mcp:read", inputSchema: obj({ pieceId: str("조각 _id") }, ["pieceId"]) },
  { name: "curation_fetch", description: "큐레이션(짤·트렌드·제품 정보·연예인 착용·코디 제안)을 조회합니다.", scope: "mcp:read", inputSchema: obj({ kind: str("종류", { enum: ["MEME", "TREND", "PRODUCT_FACT", "CELEB_MATCH", "OUTFIT"] }), productId: str("상품 _id 로 필터"), limit: num("최대 개수(1~100)", { minimum: 1, maximum: 100 }) }) },
  { name: "space_list", description: "내 브라우저 스페이스(계정) 목록과 세션 상태·발행 방식(BROWSER/META_API)을 조회합니다.", scope: "mcp:read", inputSchema: obj({}) },
  { name: "space_create", description: "새 스페이스를 만듭니다(데스크톱 에이전트가 격리 프로필을 생성). 위험 툴: confirmed=true 필요.", scope: "mcp:write", dangerous: true, returnsJob: true, inputSchema: obj({ platform: str("플랫폼", { enum: PLATFORM_ENUM }), name: str("스페이스 이름(40자 이내)"), handle: str("계정 핸들(선택)"), confirmed: bool("true 일 때만 실제 생성") }, ["platform", "name"]) },
  { name: "space_pin", description: "스페이스를 고정/해제합니다.", scope: "mcp:write", inputSchema: obj({ spaceId: str("스페이스 _id"), pinned: bool("고정 여부") }, ["spaceId", "pinned"]) },
  { name: "post_schedule", description: "예약 발행을 등록합니다(KST, 지터). 라이브러리 조각(pieceId)을 지정하면 본문·미디어를 채웁니다.", scope: "mcp:write", inputSchema: obj({ spaceId: str("스페이스 _id"), kind: str("주기", { enum: ["ONE_SHOT", "DAILY", "WEEKLY"] }), timeOfDay: str("HH:MM (KST)"), daysOfWeek: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "WEEKLY 요일(0=일)" }, runDate: str("ONE_SHOT 실행 일자 YYYY-MM-DD"), jitterMinutes: num("지터(0~120분)", { minimum: 0, maximum: 120 }), text: str("본문(pieceId 지정 시 생략 가능)"), mediaUrls: { type: "array", items: { type: "string" }, description: "미디어 URL" }, linkId: str("마케팅 링크 _id"), pieceId: str("라이브러리 조각 _id"), autoApprove: bool("실행 직전 승인 없이 게시") }, ["spaceId", "kind", "timeOfDay"]) },
  { name: "post_publish", description: "즉시 발행 잡을 등록합니다. 위험 툴: confirmed=true 없이는 미리보기만 반환합니다. 잡 id 를 반환하고 job_get 으로 결과를 조회합니다.", scope: "mcp:write", dangerous: true, returnsJob: true, inputSchema: obj({ spaceId: str("스페이스 _id"), text: str("본문(pieceId 지정 시 생략 가능)"), mediaUrls: { type: "array", items: { type: "string" }, description: "미디어 URL" }, linkId: str("마케팅 링크 _id"), pieceId: str("라이브러리 조각 _id"), requireApproval: bool("대시보드/텔레그램 승인 후 게시(기본 true)"), dryRun: bool("실제 게시 없이 절차만 검증"), confirmed: bool("true 일 때만 실제 등록") }, ["spaceId"]) },
  { name: "post_verify_published", description: "발행 잡의 결과(게시 URL)와 최신 readback 지표를 확인합니다.", scope: "mcp:read", inputSchema: obj({ jobId: str("잡 _id") }, ["jobId"]) },
  { name: "job_get", description: "잡 상태·진행 단계·결과 봉투(automoney.job-result/v1)를 조회합니다.", scope: "mcp:read", inputSchema: obj({ jobId: str("잡 _id") }, ["jobId"]) },
  { name: "job_cancel", description: "대기·승인 대기 잡을 취소하거나 실행 중 잡에 취소를 요청합니다.", scope: "mcp:write", inputSchema: obj({ jobId: str("잡 _id") }, ["jobId"]) },
  { name: "admin_team_stats", description: "총판: 하부 유저별 이번 달 실적을 조회합니다.", scope: "admin:read", inputSchema: obj({ month: str("YYYY-MM(기본 이번 달)") }) },
  { name: "super_stats", description: "수퍼어드민: 전체 집계(간접 구매 포함)를 조회합니다.", scope: "super:read", inputSchema: obj({ month: str("YYYY-MM(기본 이번 달)") }) },
];

export const MCP_TOOL_MAP: Record<string, McpToolDef> = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t]));

/** 역할 → 허용 가능한 최대 스코프 집합 */
export function allowedScopesForRole(role: string): McpScope[] {
  if (role === "SUPER_ADMIN") return [...MCP_SCOPES];
  if (role === "ADMIN") return ["mcp:read", "mcp:write", "admin:read"];
  return ["mcp:read", "mcp:write"];
}

export function visibleTools(scopes: readonly string[]): McpToolDef[] {
  return MCP_TOOLS.filter((t) => scopes.includes(t.scope));
}

/** 가벼운 인자 검증(필수 키·타입·enum). 완전한 JSON Schema 검증기는 두지 않는다. */
export function validateToolArgs(tool: McpToolDef, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  for (const key of tool.inputSchema.required ?? []) if (a[key] === undefined || a[key] === null || a[key] === "") return `missing required argument: ${key}`;
  for (const [key, value] of Object.entries(a)) {
    const spec = tool.inputSchema.properties[key] as { type?: string; enum?: unknown[]; minimum?: number; maximum?: number; items?: { type?: string; enum?: unknown[] } } | undefined;
    if (!spec) return `unknown argument: ${key}`;
    if (value === undefined || value === null) continue;
    if (spec.type === "string" && typeof value !== "string") return `${key} must be a string`;
    if (spec.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return `${key} must be an integer`;
    if (spec.type === "boolean" && typeof value !== "boolean") return `${key} must be a boolean`;
    if (spec.type === "array" && !Array.isArray(value)) return `${key} must be an array`;
    if (spec.enum && !spec.enum.includes(value)) return `${key} must be one of ${spec.enum.join(", ")}`;
    if (spec.type === "integer" && typeof value === "number") {
      if (spec.minimum !== undefined && value < spec.minimum) return `${key} must be >= ${spec.minimum}`;
      if (spec.maximum !== undefined && value > spec.maximum) return `${key} must be <= ${spec.maximum}`;
    }
    if (spec.type === "array" && Array.isArray(value) && spec.items?.enum) for (const it of value) if (!spec.items.enum.includes(it)) return `${key} contains invalid value: ${String(it)}`;
  }
  return null;
}

/** MCP 자격증명 형식 */
export const MCP_ENDPOINT_ID_LENGTH = 16;
export const MCP_SECRET_LENGTH = 32;
export const MCP_KEY_PREFIX = "am_mcp_";
export const MCP_PATH_RE = /^\/mcp\/([A-Za-z0-9]{16})\.([A-Za-z0-9]{32})$/;

/** MCP OAuth 2.1 (PKCE·DCR) — 액세스 토큰은 API 키와 같은 형식(`am_mcp_…`)으로 발급되어 같은 인증 경로를 탄다. */
export const MCP_OAUTH = {
  accessTtlMs: 60 * 60_000, // 1시간
  refreshTtlMs: 30 * 24 * 3600_000, // 30일(회전)
  codeTtlMs: 10 * 60_000, // 인가 코드 10분
  defaultScopes: ["mcp:read", "mcp:write"] as McpScope[],
  maxRedirectUris: 10,
} as const;

/** 등록 가능한 리다이렉트 URI: https 또는 루프백(http://localhost|127.0.0.1) 또는 커스텀 스킴(네이티브 앱). */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && u.protocol !== "javascript:" && u.protocol !== "data:";
  } catch {
    return false;
  }
}

