/** 혼동 문자(0/O/1/I) 제외 알파벳. blogautomcp lib/pairing.ts 의 규칙을 계승. */
export const SAFE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const ROLES = ["USER", "ADMIN", "SUPER_ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const KYC_STATUSES = ["SUBMITTED", "APPROVED", "REJECTED"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const ORDER_STATUSES = ["PAID", "CANCELLED", "REFUNDED", "CONFIRMED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ATTRIBUTIONS = ["DIRECT", "INDIRECT"] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

/** 24시간 간접구매 창 (ms) */
export const INDIRECT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 기본 유저 요율 (basis points, 10000 = 100%) */
export const DEFAULT_USER_RATE_BPS = 500;

/** 웹훅 리플레이 허용 창 (ms) */
export const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
