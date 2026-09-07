# ADR-0007 MCP 1단계 인증은 원타임 URL·API 키, OAuth(PKCE·DCR)는 후속

- 상태: 채택 (2026-09-05)
- 맥락: 04 §5·ADR-0003 은 OAuth 연결(`.well-known`, 동적 클라이언트 등록, PKCE)과 원타임 발급 URL 두 경로를 정의했다. 현재 주요 클라이언트(Claude Desktop/Code, Cursor)는 URL 만으로 붙는 HTTP MCP 를 지원하고, OAuth 서버는 인가 화면·토큰 저장소·리프레시 등 별도 범위가 크다.
- 결정: M5 는 `/mcp/{endpointId}.{secret}` 원타임 URL 과 `Authorization: Bearer am_mcp_…` API 키만 제공한다. 자격증명은 대시보드에서 발급하며 시크릿은 1회만 표시, 스코프는 발급 시점 역할 범위로 제한하고 호출 시점 역할로 다시 축소한다. OAuth 경로는 동일한 `mcpCredentials` 레코드에 토큰 발급자를 추가하는 형태로 후속 구현한다.
- 근거: 로드맵 완료 기준(외부 MCP 클라이언트 E2E)을 OAuth 없이 충족하면서, 툴 카탈로그·디스패치·레이트리밋·감사 등 공통부를 먼저 안정화한다.
- 결과: 키 유출 시 폐기(즉시 401)로 대응하며, 키는 해시로만 저장한다. OAuth 도입 시 스코프 동의 화면과 리프레시 토큰 정책을 추가해야 한다.

## 후속 (구현됨) — OAuth 2.1 경로
- 인가 서버 메타데이터 `GET /.well-known/oauth-authorization-server`, 보호 자원 메타데이터 `GET /.well-known/oauth-protected-resource[/mcp]`(RFC 9728). `/mcp` 401 응답의 `WWW-Authenticate` 가 이를 가리켜 클라이언트가 자동 발견한다.
- 동적 클라이언트 등록 `POST /oauth/register`(RFC 7591): public(`none`) 기본, `client_secret_post` 선택. redirect_uri 는 https · 루프백 http · 커스텀 스킴만 허용.
- 인가 화면은 웹 `/oauth/authorize`(로그인 필요, `next` 로 복귀). PKCE S256 필수, 스코프는 요청 ∩ 역할 허용(미지정 시 read/write). 승인 시 10분짜리 코드 발급.
- `POST /oauth/token`: `authorization_code`(코드 1회용, 재사용 시 해당 클라이언트 토큰 폐기) · `refresh_token`(회전, 회전된 토큰 재사용 감지 시 자격증명 전체 폐기, 스코프 축소만 허용). 액세스 1시간 · 리프레시 30일.
- 액세스 토큰은 `mcpCredentials`(kind=OAUTH, `expiresAt`) 의 `keyHash` 로 저장되어 API 키와 같은 인증·레이트리밋·감사 경로를 탄다. 대시보드에서 "OAuth · 클라이언트명" 으로 보이며 폐기 가능. `POST /oauth/revoke`(RFC 7009) 도 지원.

