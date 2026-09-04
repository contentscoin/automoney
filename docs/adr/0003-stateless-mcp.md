# ADR-0003 MCP 서버는 stateless Streamable HTTP, write 툴은 잡 비동기

- 상태: 채택
- 맥락: 외부 AI 클라이언트(ChatGPT·Claude·Codex)에서 작업 지시와 결과 보고를 받아야 한다. 실제 작업은 유저 PC에서 수행된다.
- 결정: 세션 상태 없는 POST 전용 MCP 엔드포인트(blogautomcp `apps/sites/app/api/mcp` 계승). OAuth PKCE + 원타임 URL 두 경로. write 툴은 잡 id를 반환하고 `job_get`으로 결과 조회. 위험 툴은 `confirmed: true` 필수.
- 근거: 서버리스 확장성, 클라이언트 다양성, 장시간 작업의 비동기성.
- 결과: 클라이언트는 폴링 패턴을 따라야 한다. 툴 스키마는 단일 소스(`tool-schema.ts`)로 문서·검증을 공유한다.
