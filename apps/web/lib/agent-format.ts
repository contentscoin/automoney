export const SPACE_STATE_LABEL: Record<string, string> = {
  CREATED: "생성 중",
  LOGIN_REQUIRED: "로그인 필요",
  HEALTHY: "정상",
  RUNNING: "작업 중",
  EXPIRED: "세션 만료",
  RESTRICTED: "제한됨",
  PAUSED: "일시정지",
};
export const SPACE_STATE_TONE: Record<string, string> = {
  CREATED: "PENDING",
  LOGIN_REQUIRED: "PENDING",
  HEALTHY: "ACTIVE",
  RUNNING: "PAID",
  EXPIRED: "REJECTED",
  RESTRICTED: "SUSPENDED",
  PAUSED: "DISABLED",
};
export const JOB_STATUS_LABEL: Record<string, string> = {
  NEEDS_APPROVAL: "승인 대기",
  QUEUED: "대기",
  RUNNING: "실행 중",
  SUCCEEDED: "완료",
  FAILED: "실패",
  CANCELLED: "취소",
};
export const JOB_STATUS_TONE: Record<string, string> = {
  NEEDS_APPROVAL: "PENDING",
  QUEUED: "PENDING",
  RUNNING: "PAID",
  SUCCEEDED: "ACTIVE",
  FAILED: "REJECTED",
  CANCELLED: "DISABLED",
};
export const JOB_TYPE_LABEL: Record<string, string> = {
  "post.publish": "게시",
  "space.create": "스페이스 생성",
  "space.login": "로그인 창",
  "space.verify": "세션 검증",
  "codex.login": "Codex 로그인",
  "content.generate": "콘텐츠 생성",
  "post.readback": "지표 수집",
  "meta.token_refresh": "Meta 토큰 갱신",
};
export const PLATFORM_LABEL: Record<string, string> = { THREADS: "쓰레드", X: "X", INSTAGRAM: "인스타그램", TIKTOK: "틱톡", NAVER_BLOG: "네이버 블로그" };
export const DOW = ["일", "월", "화", "수", "목", "금", "토"];
