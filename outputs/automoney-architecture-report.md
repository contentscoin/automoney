# automoney 전체 구조·아키텍처·기능·개발 현황 분석

분석 기준 커밋: `2a7ef7ef76bf07ff8b883976421c359f93484f23`  
분석 일자: 2026-09-21  
근거: `README.md`, `docs/00~07`, ADR 7건, `apps/web`, `apps/desktop`, `packages/shared`, 테스트 및 빌드 결과

## 1. 한눈에 보는 결론

automoney는 아뜨랑스 상품을 개인 SNS에서 판매하는 제휴 마케팅 플랫폼이다. 단순 링크 발급 서비스가 아니라 다음 네 영역을 한 제품으로 묶는다.

1. 회원·KYC·상품·제휴 링크·주문·정산을 담당하는 Cloud SaaS
2. 유저 PC에서 Codex와 브라우저 세션을 사용하는 Electron 자동화 에이전트
3. Instagram, Threads, X, TikTok, 네이버 블로그용 콘텐츠 생성·예약·발행 체계
4. Telegram과 Stateless MCP를 통한 원격 지시·승인·보고

현재 저장소는 “기획 문서만 있는 단계”가 아니다. Next.js/Convex 웹 앱, 39개 Convex 테이블, 30개 화면, Electron 에이전트, 21개 MCP 툴, 정산·콘텐츠·분석 로직과 단위 테스트가 존재한다. 전체 테스트 116개가 통과하고 웹·데스크톱 빌드도 통과한다.

다만 로드맵의 M1~M5가 모두 “초안 구현”으로 표시된 이유가 중요하다. 핵심 비즈니스 로직은 구현됐지만 아뜨랑스 실제 API, Meta 앱 리뷰, 실제 SNS 계정 장기 검증, 운영 보안·개인정보 통제, 코드 서명, 운영 관측성 같은 외부·운영 조건이 남아 있다. 따라서 현재 상태는 **기능 범위가 넓은 통합 프로토타입/베타 후보**이며, 즉시 상용 운영 가능한 완성품으로 보기는 어렵다.

## 2. 저장소 구조

```text
automoney/
├─ apps/
│  ├─ web/                  Next.js 16 + Convex 웹/백엔드
│  │  ├─ app/              30개 App Router 화면·라우트
│  │  ├─ components/       공통 UI
│  │  ├─ convex/           39개 테이블, 도메인 함수, HTTP Actions, Cron
│  │  ├─ scripts/          로컬 E2E, MCP E2E
│  │  └─ tests/            Convex 기반 도메인 테스트
│  └─ desktop/              Electron + Playwright 로컬 에이전트
│     ├─ src/agent/         잡 폴러, 스페이스, 레시피, Codex, autopilot
│     ├─ scripts/           자산 복사, 에이전트 E2E
│     └─ tests/             브라우저·레시피·자동 업데이트 테스트
├─ packages/
│  └─ shared/               정산·스케줄·콘텐츠·MCP 계약 순수 TypeScript
├─ docs/                    PRD, 아키텍처, 데이터, 정산, 연동, 콘텐츠, 로드맵
└─ .github/workflows/       데스크톱 빌드·릴리스 자동화
```

### 기술 스택

- 프론트/웹: Next.js 16, React 19, TypeScript, Tailwind CSS
- 백엔드: Convex 함수·문서 DB·파일 스토리지·HTTP Actions·Cron
- 데스크톱: Electron, Playwright, electron-updater
- AI 실행: 유저 PC의 `codex exec`; 실패 시 규칙 템플릿 폴백
- 테스트: Vitest, convex-test, Playwright 픽스처
- 패키지: pnpm workspace (`apps/*`, `packages/*`)

## 3. 실제 런타임 아키텍처

### 3.1 Cloud

`apps/web` 하나에 웹 UI와 Convex 백엔드가 함께 있다.

- Next.js App Router: 사용자·총판·수퍼어드민 대시보드와 로그인/가입
- Convex Core: 회원, KYC, 상품, 링크, 주문, 정산, 콘텐츠, 스페이스, 잡, MCP, OAuth
- HTTP Actions: 아뜨랑스 웹훅, 에이전트 claim/heartbeat/complete, Meta callback, MCP, OAuth, Telegram webhook
- Cron: 월 정산 마감, 잡 lease 회수, 예약 tick, 트렌드 갱신, 분석 readback, Meta 토큰 갱신
- 저장소: Convex 데이터베이스와 파일 스토리지

### 3.2 사용자 PC

`apps/desktop`은 서버가 대신 보관해서는 안 되는 브라우저 세션과 Codex 로그인을 로컬에 둔다.

- Electron 트레이/패널, 딥링크 페어링, 단일 인스턴스
- 3초 단위 잡 폴링과 heartbeat/complete
- 스페이스별 Playwright persistent context
- Instagram, Threads, X, TikTok, 네이버 블로그 레시피
- 레시피 실패 시 시맨틱 스냅샷 기반 autopilot
- `codex exec` 기반 문안 생성과 액션 계획
- 자동 업데이트와 Chrome→Edge 브라우저 폴백

### 3.3 외부 연동

- 아뜨랑스: 상품, 링크, 주문, 정산 데이터 원천. 현재 실제 API가 아니라 Mock/CSV 경로
- Meta: Threads/Instagram Graph API 코드 존재. 자격증명이 없으면 Mock
- SNS 웹: 브라우저 스페이스를 통한 게시 및 readback
- Telegram: 명령, 승인 버튼, 상태/성과/결과 알림
- MCP 클라이언트: ChatGPT, Claude, Codex 등에서 JSON-RPC 2.0으로 호출

### 3.4 핵심 신뢰 경계

- Cloud에는 업무 상태와 암호화된 민감정보를 저장한다.
- Codex OAuth 토큰, SNS 쿠키·비밀번호, 브라우저 프로필은 사용자 PC에만 둔다.
- MCP는 세션 상태 없이 API 키 또는 OAuth 2.1 토큰으로 매 요청을 인증한다.
- 위험 작업인 `post_publish`, `space_create`는 `confirmed=true`가 없으면 실행하지 않는다.

## 4. 역할과 제품 표면

### 사용자

- 가입, 총판 초대 코드 연결, KYC 제출
- 상품 검색과 링크 발급, 클릭·주문·예상 수당 조회
- 콘텐츠 생성·수정·승인·거절·라이브러리 사용
- 디바이스 페어링, 스페이스, 예약, 작업, Telegram, MCP 관리
- 월별 정산 및 웹 명세서 확인/인쇄

### 총판

- 초대 코드 발급
- 하부 사용자·KYC 상태·직접 실적 조회
- 총판 요율과 사용자 요율의 차액 정산 조회

### 수퍼어드민

- 전체 사용자/역할/상태 관리
- KYC 검수와 민감정보 접근 감사
- 상품·주문·요율·그레이드·정산·리컨실 관리
- 간접구매와 운영사 차액 조회
- 매거진·큐레이션·콘텐츠·분석·플레이북 운영

## 5. 데이터 모델

물리 스키마 정본은 `apps/web/convex/schema.ts`이며 39개 테이블이 있다.

### 계정·보안

`users`, `inviteCodes`, `kycProfiles`, `devices`, `pairCodes`, `auditEvents`, `settings`

### 판매·어트리뷰션

`products`, `marketingLinks`, `clickEvents`, `orders`, `orderEvents`, `userMonthlyStats`

### 정산

`commissionRules`, `gradeTiers`, `commissionEntries`, `settlements`, `attrangsSettlementBatches`, `settlementMonths`

### 자동화

`spaces`, `agentJobs`, `schedules`, `telegramBindings`, `telegramOutbox`

### 콘텐츠·분석

`magazines`, `contentAtoms`, `contentPieces`, `curationItems`, `contentRejections`, `snsAccounts`, `metaOauthStates`, `postMetrics`, `experiments`, `playbooks`

### MCP·OAuth

`mcpCredentials`, `oauthClients`, `oauthCodes`, `oauthRefreshTokens`, `mcpRateBuckets`

## 6. 핵심 업무 흐름

### 링크와 주문

1. 사용자가 상품을 선택한다.
2. Cloud가 아뜨랑스 어댑터에서 tracking code를 발급한다.
3. `/r/{code}`가 클릭을 기록하고 상품 페이지로 리다이렉트한다.
4. 아뜨랑스 주문 웹훅을 HMAC·멱등성·24시간 조건으로 검증한다.
5. 주문과 이벤트를 저장하고 월 통계를 갱신한다.
6. 직접/간접 어트리뷰션에 맞춰 수수료 원장을 재계산한다.

### 3단계 정산

- 사용자 수익: `floor(base × 사용자 요율)`
- 총판 차액: `floor(base × 총판 요율) - 사용자 수익`
- 운영사 차액: `floor(base × 아뜨랑스 지급률) - 사용자 수익 - 총판 차액`
- 취소·환불은 음수 델타로 역분개한다.
- 월 마감 후 아뜨랑스 확정 배치와 주문 단위로 0원 오차 리컨실한다.
- KYC가 승인되지 않으면 HELD, 해소 후 다음 마감에서 합산한다.

### 예약 게시

1. Cloud 스케줄러가 KST 시간과 deterministic jitter로 잡을 만든다.
2. 데스크톱 에이전트가 lease를 획득한다.
3. 콘텐츠/링크/스페이스를 로드한다.
4. 플랫폼 레시피를 먼저 실행하고 실패 시 autopilot으로 복구한다.
5. 승인 필요 작업은 Telegram/대시보드에서 승인받는다.
6. 게시 URL과 결과 봉투를 Cloud로 반환한다.
7. 24h/72h/7d 성과를 수집해 실험·플레이북에 누적한다.

### 콘텐츠 생성

1. 매거진 URL/HTML에서 본문·이미지·상품을 추출한다.
2. HOOK, STYLE_TIP, PRODUCT_POINT 등 원자를 만든다.
3. 데스크톱의 Codex가 채널별 콘텐츠를 생성한다.
4. 광고 표기, 금칙어, 길이, 해시태그, AI 상투어를 규칙 기반으로 평가한다.
5. 승인된 콘텐츠를 라이브러리·게시·예약에 연결한다.
6. 성과가 좋은 훅/CTA/시간대는 플레이북으로 승격한다.

## 7. 구현 현황

### M0 규격 합의 — 부분 완료

완료:

- 모노레포와 문서·ADR 체계
- 아뜨랑스 제안 API 규격과 CSV 폴백 정의
- Convex 전환 결정

미완료:

- 아뜨랑스와 공식 API·요율·그레이드·취소 확정 기간 합의
- 실데이터 샘플과 운영 SLA 확정

### M1 코어 — 초안 구현 완료

구현:

- 이메일/비밀번호 인증, RBAC, 총판 초대
- KYC 제출·파일 업로드·암호화·검수
- 상품 Mock/CSV 동기화
- 링크 발급·단축 URL·클릭 기록
- 주문 웹훅, 멱등성, 직접/간접 재검증
- 3종 대시보드

남은 부분:

- 카카오 가입은 PRD에는 있지만 코드상 확인되지 않음
- 상품 즐겨찾기, QR 생성은 요구사항 대비 명확한 구현 근거가 없음
- 실제 아뜨랑스 어댑터가 없음

### M2 정산 — 초안 구현 완료

구현:

- bps 정수 기반 결정론적 분배
- 개별/총판/전역 규칙 우선순위와 그레이드
- 취소·환불·요율 변경을 동일 델타 재계산 경로로 처리
- DRAFT/HELD/CONFIRMED/APPROVED/PAID 상태
- 배치 CSV, 리컨실, 지급 파일, 명세서 화면
- 권한별 직접/간접 실적 분리

남은 부분:

- 실제 아뜨랑스 월 확정 데이터로 0원 오차 증명
- 은행 지급 파일 형식과 회계/세무 운영 승인
- 명세서는 서버 생성 PDF가 아니라 브라우저 인쇄/PDF 저장 방식

### M3 데스크톱·자동화 — 기능 구현, 실서비스 검증 필요

구현:

- Electron 앱, 페어링, 잡 폴링, 스페이스 파일 구조·락
- 5개 채널 레시피와 픽스처 테스트
- 시맨틱 스냅샷, 금지 액션, 발행 게이트, autopilot
- Codex 생성/플래너, 템플릿 폴백
- 스케줄, 일일 한도, Telegram, 자동 업데이트
- 시스템 Chrome/Edge 폴백

남은 부분:

- 실제 SNS 계정에서 셀렉터·2FA·캡차·업로드·게시 URL 검증
- 스페이스 3개 7일 연속 운영 검증
- Codex 실제 로그인 상태에서 planner E2E
- Windows/macOS 코드 서명·노터라이즈 인증서
- 문서에는 SQLite와 로컬 Next 서버가 있으나 현재 코드/의존성에는 해당 구현이 보이지 않음
- stealth, 프록시 고정, 지문 노이즈 같은 일부 문서 기능은 구현 근거가 약함

### M4 콘텐츠·큐레이션 — 초안 구현 완료

구현:

- 매거진 URL/HTML 등록과 원자 추출
- Codex/템플릿 채널별 생성
- 규칙 기반 품질 평가와 광고 표기·금칙 주장 차단
- 콘텐츠 라이브러리·공유·수정·승인·거절
- Google Trends RSS, Brave/SerpAPI 추상화, 제품 정보, 코디 제안
- 라이선스 메모와 연예인 이미지 재게시 금지 정책

남은 부분:

- 전문가 패널 90점/최대 3회 재생성은 현재 규칙 기반 1차 대체
- 이미지 크롭·오버레이·숏폼 미디어 제작 파이프라인 근거가 약함
- 네이버 데이터랩/X/TikTok 트렌드 소스 확대
- 아뜨랑스 매거진 이미지·본문 2차 가공 권한 합의

### M5 Meta·MCP·분석 — 코드 구현, 외부 검증 필요

구현:

- Meta adapter 계약, Graph 구현, Mock 연결/발행/인사이트/갱신
- API 실패 시 브라우저 스페이스 폴백
- 21개 Stateless MCP 툴
- API 키, 원타임 URL, OAuth 2.1 PKCE/DCR/refresh/revoke
- 역할·스코프 필터, 레이트리밋, 위험 작업 확인, 감사로그
- 24h/72h/7d readback, 실험, lift 평가, 플레이북

남은 부분:

- Meta 사업자 인증과 앱 리뷰
- 실제 Threads/Instagram 장기 토큰·릴스 처리·인사이트 검증
- 외부 MCP 클라이언트별 호환성/부하/회전 토큰 운영 검증
- 브라우저 readback 셀렉터 실계정 검증

## 8. 문서와 실제 코드의 차이

1. 초기 아키텍처 문서의 Postgres/Drizzle/R2는 ADR-0006 이후 Convex로 대체됐다. 코드가 최신 정본이다.
2. 데스크톱 문서의 SQLite·내장 Next 서버는 현재 패키지 의존성과 코드에서 확인되지 않는다. 실제 구현은 파일 기반 스페이스 메타/이력과 정적 Electron 패널에 가깝다.
3. 문서 일부는 MCP OAuth를 “후속”이라고 쓰지만 코드와 README 최신 절에는 OAuth 2.1 경로가 구현돼 있다.
4. README 마지막 “남은 로드맵”에는 코디 제안이 남았다고 쓰지만 `OUTFIT` 큐레이션은 이미 구현돼 있다.
5. 콘텐츠 문서의 Cloud LLM 경로는 이후 결정으로 폐기됐고, 현재는 사용자 PC Codex + 템플릿 폴백이다.
6. PRD의 KMS 봉투 암호화와 달리 현재 구현은 환경변수의 32바이트 키를 이용한 AES-256-GCM이다. 운영 KMS/키 회전 설계가 추가로 필요하다.

## 9. 품질과 검증 상태

현재 확인 결과:

- shared 테스트: 39개 통과
- web 테스트: 49개 통과
- desktop 테스트: 28개 통과
- 전체: 116개 통과
- TypeScript 전체 typecheck 통과
- Next.js production build 통과
- Electron TypeScript build 통과
- Archify 아키텍처: 저장소 증거 22개 검증, showcase 9/9 검사 통과

아직 실행하지 못했거나 외부 조건이 필요한 검증:

- 로컬 Convex를 포함한 `e2e-local.mjs`, `e2e-mcp.mjs`, `e2e-agent.mjs`
- 실제 아뜨랑스 API/CSV 골든 데이터
- 실제 Meta 앱과 실제 SNS 계정
- 7일 연속 예약 게시
- 부하·장애·복구·백업/복원·보안 침투 테스트

## 10. 출시 전 우선순위

### P0 — 외부 계약과 돈/개인정보 안전

1. 아뜨랑스 API·CSV 계약, 요율·그레이드·취소 확정일, 지급 파일 확정
2. 실 월 데이터 정산 골든셋과 주문 단위 0원 오차 리컨실
3. KYC 최소수집·보관·파기 법무 검토, KMS/키 회전, 관리자 열람 통제
4. 감사로그 불변성, 운영자 권한 분리, 비밀값 관리

### P1 — 실제 채널 운영

1. Meta 앱 리뷰·실 API 검증
2. 5개 SNS 실계정 selector 튜닝과 차단/캡차 대응
3. Codex 로그인·생성·autopilot 실제 E2E
4. 코드 서명·노터라이즈·업데이트 롤백

### P2 — 운영 안정성

1. 구조화 로그, 오류 추적, 작업 지연·실패율·정산 diff 알림
2. Convex 백업/복원, 파일 보관·삭제, RTO/RPO 정의
3. 잡 중복·lease 유실·네트워크 단절·앱 강제종료 복구 테스트
4. MCP/웹훅/Telegram 레이트리밋과 부하 테스트

### P3 — 제품 완성도

1. 카카오 가입, 상품 즐겨찾기, QR 등 PRD 누락 기능 결정
2. 이미지 가공과 숏폼 미디어 생성 파이프라인
3. 콘텐츠 품질 전문가 패널 고도화
4. 관리자 운영 매뉴얼, 고객지원·분쟁 처리·정산 이의제기 흐름

## 11. 권장 실행 계획

### 1단계: 통합 개발 환경 고정

- Convex 로컬 개발과 세 E2E 스크립트를 CI에서 재현
- 문서의 Postgres/SQLite/Cloud LLM 잔재를 실제 코드 기준으로 정리
- 루트 Windows 빌드 필터 문제와 Vite CJS/ESM 경고 정리

### 2단계: 샌드박스 베타

- 아뜨랑스 CSV 샘플, Meta 테스트 계정, SNS 전용 테스트 계정으로 폐쇄 베타
- 매일 정산 diff, 게시 성공률, 세션 만료율, 잡 지연을 측정
- 데이터·로그·스크린샷의 보관/삭제 정책을 실제로 적용

### 3단계: 제한된 실사용

- 소수 운영자와 총판/유저로 7~30일 운영
- 돈이 오가는 정산은 이중 승인과 수동 대조 유지
- SNS 자동화는 낮은 한도와 수동 승인 기본값 유지

### 4단계: 상용화

- API/SLA, 보안·개인정보, 앱 리뷰, 코드 서명, 장애복구 조건 충족 후 점진 확대
- 채널별 성공률과 정산 0원 오차를 출시 게이트로 사용

## 12. 최종 판단

제품의 핵심 설계는 일관적이다. 특히 “Cloud는 업무 상태, 사용자 PC는 Codex 토큰과 SNS 세션”이라는 경계, 결정론적 정산 원장, stateless MCP, 브라우저 레시피 우선/agent fallback 구조는 좋은 선택이다.

가장 큰 리스크는 코드량 부족이 아니라 **실제 외부 시스템과 운영 조건의 미검증**이다. 다음 개발의 중심은 새 기능 추가보다 아뜨랑스·Meta·SNS 실환경 통합, 정산·개인정보 통제, 장기 안정성 검증이어야 한다.
