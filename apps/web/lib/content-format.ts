export const CHANNEL_LABEL: Record<string, string> = {
  INSTAGRAM_FEED: "인스타 피드",
  INSTAGRAM_REEL: "인스타 릴스",
  THREADS: "스레드",
  X: "X",
  TIKTOK: "틱톡",
  BLOG: "블로그",
};
export const CHANNEL_ORDER = ["INSTAGRAM_FEED", "INSTAGRAM_REEL", "THREADS", "X", "TIKTOK", "BLOG"] as const;
export const CURATION_KIND_LABEL: Record<string, string> = {
  MEME: "짤·밈",
  TREND: "트렌드",
  PRODUCT_FACT: "제품 정보",
  OUTFIT: "코디 제안",
  CELEB_MATCH: "연예인 착용",
};
export const PIECE_STATUS_LABEL: Record<string, string> = { DRAFT: "검토 필요", APPROVED: "승인", RETIRED: "폐기" };
export const PIECE_STATUS_TONE: Record<string, string> = { DRAFT: "PENDING", APPROVED: "ACTIVE", RETIRED: "DISABLED" };
export const GENERATED_BY_LABEL: Record<string, string> = { codex: "Codex", template: "템플릿", manual: "수동" };
