# ADR-0006 백엔드를 Convex 로 채택 (ADR-0002 대체)

- 상태: 채택 (2026-09-04). ADR-0002(Postgres + Drizzle)를 대체한다.
- 맥락: M1 착수 시점에 운영 부담 최소화와 실시간 대시보드를 우선해 Convex(DB·서버 함수·파일 스토리지·스케줄러·HTTP actions 통합)로 전환하기로 결정했다.
- 결정:
  - 데이터·함수는 `apps/web/convex/` 에 두고 Convex 스키마(`schema.ts`)를 정본으로 한다. `docs/02-data-model.md` 의 테이블 정의는 컬럼 계약으로 유지하되, 물리 모델은 Convex 문서 테이블이다.
  - 인증은 `@convex-dev/auth` Password 프로바이더(이메일+비밀번호). 역할·총판 연결은 가입 콜백(`lib/onboarding.ts`)에서 결정한다.
  - 집계는 SQL GROUP BY 대신 **월별 유저 집계 테이블(`userMonthlyStats`)** 을 뮤테이션 트랜잭션 안에서 증감하여 유지한다. 직접/간접 필드를 분리해 유저·총판 쿼리에서 간접구매가 노출되지 않도록 한다.
  - 주문 원장은 `orders` + `orderEvents`(event_id 멱등)로 append 성격을 유지하고, 상태 전이 시 집계를 역분개한다.
  - 민감정보(주민번호·계좌번호)는 액션에서 AES-256-GCM(WebCrypto, `KYC_ENC_KEY`)으로 암호화 후 저장하고 마지막 4자리만 별도 보관한다. 통장사본은 Convex 파일 스토리지, 열람은 감사로그를 남긴다.
  - 외부 호출: 단축 링크 리다이렉터(Next route)→`clicks.record`(공유 시크릿), 아뜨랑스 웹훅→Convex HTTP action(HMAC 서명 검증).
- 결과:
  - Postgres 관련 문서(01 §4 기술 스택, 02 물리 스키마)는 Convex 기준으로 읽는다.
  - 개인정보는 Convex 클라우드 리전에 저장되므로 개인정보처리방침에 국외 이전 고지가 필요하다.
  - 테스트는 `convex-test`(인메모리) + vitest 로 함수 단위 검증, 로컬 개발은 `npx convex dev`(익명 로컬 배포 가능).
