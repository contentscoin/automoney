import type { Page } from "playwright";

export type SessionCheck = { state: "HEALTHY" | "LOGIN_REQUIRED" | "RESTRICTED"; handle?: string | null; detail?: string };

export interface PublishInput {
  text: string;
  mediaPaths: string[];
}

export interface PublishOutcome {
  postUrl: string | null;
  detail?: string;
}

/**
 * 플랫폼 레시피: 안정적인 셀렉터 기반 플로우. 실패 시 상위에서 RECIPE_FAILED 로 보고하고
 * (M3-2) Codex 에이전트 루프로 복구를 시도한다. 셀렉터는 원격 업데이트 가능하도록 한 곳에 모은다.
 */
export interface PlatformRecipe {
  platform: "THREADS" | "X" | "INSTAGRAM" | "TIKTOK" | "NAVER_BLOG";
  loginUrl: string;
  homeUrl: string;
  checkSession(page: Page): Promise<SessionCheck>;
  publish(page: Page, input: PublishInput, helpers: RecipeHelpers): Promise<PublishOutcome>;
}

export interface RecipeHelpers {
  /** 사람처럼 타이핑 (지연 포함) */
  humanType(page: Page, selector: string, text: string): Promise<void>;
  /** 취소 요청·시간 초과 체크. 취소면 throw */
  checkpoint(stage: string, progress?: number): Promise<void>;
  /** 실제 게시 직전 승인/드라이런 게이트. false 면 게시하지 않음 */
  beforePublish(): Promise<boolean>;
  waitHuman(minMs?: number, maxMs?: number): Promise<void>;
}

export const RESTRICTION_HINTS = [/suspended/i, /계정이 정지/i, /일시적으로 제한/i, /temporarily restricted/i, /unusual activity/i, /확인이 필요/i, /challenge/i];
