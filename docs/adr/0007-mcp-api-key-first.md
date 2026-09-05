# ADR-0007 MCP 1단계 인증은 원타임 URL·API 키, OAuth(PKCE·DCR)는 후속

- 상태: 채택 (2026-09-05)
- 맥락: 04 §5·ADR-0003 은 OAuth 연결(`.well-known`, 동적 클라이언트 등록, PKCE)과 원타임 발급 URL 두 경로를 정의했다. 현재 주요 클라이언트(Claude Desktop/Code, Cursor)는 URL 만으로 붙는 HTTP MCP 를 지원하고, OAuth 서버는 인가 화면·토큰 저장소·리프레시 등 별도 범위가 크다.
- 결정: M5 는 `/mcp/{endpointId}.{secret}` 원타임 URL 과 `Authorization: Bearer am_mcp_…` API 키만 제공한다. 자격증명은 대시보드에서 발급하며 시크릿은 1회만 표시, 스코프는 발급 시점 역할 범위로 제한하고 호출 시점 역할로 다시 축소한다. OAuth 경로는 동일한 `mcpCredentials` 레코드에 토큰 발급자를 추가하는 형태로 후속 구현한다.
- 근거: 로드맵 완료 기준(외부 MCP 클라이언트 E2E)을 OAuth 없이 충족하면서, 툴 카탈로그·디스패치·레이트리밋·감사 등 공통부를 먼저 안정화한다.
- 결과: 키 유출 시 폐기(즉시 401)로 대응하며, 키는 해시로만 저장한다. OAuth 도입 시 스코프 동의 화면과 리프레시 토큰 정책을 추가해야 한다.
