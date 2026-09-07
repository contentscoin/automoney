import fs from "node:fs";

/** 테스트용 Chromium 경로: 환경변수 > 컨테이너 기본 경로(존재할 때만) > Playwright 기본(설치된 브라우저) */
export function testExecutablePath(): string | undefined {
  if (process.env.AUTOMONEY_BROWSER_EXECUTABLE) return process.env.AUTOMONEY_BROWSER_EXECUTABLE;
  return fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
}
