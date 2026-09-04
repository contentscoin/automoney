# ADR-0005 Codex는 유저 PC에서 로그인, 서버 토큰 위임 금지

- 상태: 채택
- 맥락: 요구사항은 "유저가 구독하는 Codex 계정을 OAuth 인증받아 사용"이다. OpenAI 문서상 ChatGPT OAuth는 Codex CLI/IDE/Cloud 용도이며 제3자 서버가 사용자 토큰을 대신 사용하는 것은 지원되지 않는다.
- 결정: 데스크톱 에이전트에서 `codex login`(브라우저) 또는 디바이스 코드 로그인을 수행하고 토큰은 로컬(`~/.codex/auth.json` 또는 키체인)에만 둔다. Cloud는 로그인 상태만 수신한다. OpenAI API 키 입력을 폴백으로 제공한다.
- 근거: 계정 정지·약관 위반 위험 회피. blogautomcp `src/lib/codex-local.ts` 구현이 이미 검증되어 있다.
- 결과: Cloud에서 실행되는 공용 콘텐츠 생성은 운영사 API 키를 사용한다. 유저 개인화·브라우저 조작은 유저 Codex를 사용한다.
