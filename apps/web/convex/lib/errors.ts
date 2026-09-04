import { ConvexError } from "convex/values";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "KYC_INCOMPLETE"
  | "INVITE_INVALID"
  | "ATTRANGS_LINK_UNAVAILABLE"
  | "ATTRANGS_WEBHOOK_SIGNATURE_INVALID"
  | "CONFIG_MISSING";

/** 에러 봉투 {code, message}. blogautomcp lib/http.ts 의 apiError 규약을 ConvexError 로 이식. */
export function fail(code: ErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}
