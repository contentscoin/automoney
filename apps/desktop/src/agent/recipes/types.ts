import type { Page } from "playwright";

export type SessionCheck = { state: "HEALTHY" | "LOGIN_REQUIRED" | "RESTRICTED"; handle?: string | null; detail?: string };
export type SessionCheckOptions = { navigate?: boolean };

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
  checkSession(page: Page, options?: SessionCheckOptions): Promise<SessionCheck>;
  publish(page: Page, input: PublishInput, helpers: RecipeHelpers): Promise<PublishOutcome>;
}

export interface RecipeHelpers {
  /** 사람처럼 타이핑 (지연 포함) */
  humanType(page: Page, selector: string, text: string): Promise<void>;
  /** 취소 요청·시간 초과 체크. 취소면 throw */
  checkpoint(stage: string, progress?: number): Promise<void>;
  /** 실제 게시 직전 승인/드라이런 게이트. false 면 게시하지 않음 */
  beforePublish(): Promise<boolean>;
  /** 이미 기록된 동일 게시 시도의 다단계 최종 확인 직전 정책 재검증 */
  revalidatePublishContinuation(): Promise<void>;
  waitHuman(minMs?: number, maxMs?: number): Promise<void>;
}

/** 화면에 실제 표시된 계정 차단 문구만 판정한다. 일반 인증 challenge/본인 확인은 로그인 흐름이다. */
export const RESTRICTION_HINTS = [
  /account.{0,40}(?:suspended|disabled|temporarily restricted)/i,
  /(?:suspended|disabled|temporarily restricted).{0,40}account/i,
  /계정.{0,30}(?:정지|이용 제한|비활성화)/,
  /일시적으로.{0,20}(?:계정.{0,10})?제한/,
];
