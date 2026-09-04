# automoney — 아뜨랑스 제휴(부업) 마케팅 프로그램 개발 기획서

아뜨랑스(https://attrangs.co.kr/) 상품을 판매하는 제휴 마케팅 프로그램 **automoney**의 개발 기획 문서 세트입니다.
유저는 개인별 마케팅 링크를 발급받아 SNS에 포스팅하고, 발생한 구매 실적에 따라 매월 수당을 정산받습니다.
총판(어드민)과 운영사(수퍼어드민)는 하부 실적과 마진 차액을 통계로 확인합니다.

참조 레포
- `blogautomcp` — 네이버 브랜드커넥트 자동 포스팅 제품. stateless MCP + OAuth, 잡큐, 데스크톱 에이전트, Codex 연동, 스케줄러, 텔레그램 알림의 골격을 계승합니다.
- `ai-marketing-skills` — 콘텐츠 원자 → 채널별 변환, 전문가 패널 품질 게이트, 트렌드 수집, 실험 원장 패턴을 콘텐츠 엔진에 차용합니다.

## 문서 구성

| 문서 | 내용 |
|---|---|
| [00-overview-prd.md](docs/00-overview-prd.md) | 제품 개요, 역할, 요구사항→기능 매핑, 비기능 요구, 용어집 |
| [01-architecture.md](docs/01-architecture.md) | 시스템 아키텍처, 컴포넌트, 시퀀스, 기술 스택, 재사용 모듈 맵 |
| [02-data-model.md](docs/02-data-model.md) | ERD, 테이블 정의(Postgres), 로컬 SQLite 스키마 |
| [03-settlement.md](docs/03-settlement.md) | 링크 추적·어트리뷰션, 3단계 마진, 월 정산 사이클, 권한별 가시성 |
| [04-integrations.md](docs/04-integrations.md) | 아뜨랑스 파트너 API 제안 규격, Meta API, Codex OAuth, 텔레그램 봇, MCP 툴 카탈로그 |
| [05-desktop-browser-spaces.md](docs/05-desktop-browser-spaces.md) | 데스크톱 에이전트, 스페이스, 브라우저 고정, AI 에이전트 조작, 다계정·예약 |
| [06-content-engine.md](docs/06-content-engine.md) | 매거진 수집 → 채널별 콘텐츠 생성 → 품질 게이트 → 큐레이션 |
| [07-roadmap.md](docs/07-roadmap.md) | 마일스톤, 리스크, 오픈 이슈, 검증 기준 |
| [adr/](docs/adr/) | 핵심 아키텍처 결정 기록 |

## 요구사항 ↔ 문서 매핑

| # | 요구사항 | 문서 |
|---|---|---|
| 1 | 아뜨랑스 상품 판매 마케팅 프로그램 | 00 §1 |
| 2 | 아뜨랑스가 마케팅 링크·정산 시스템 제공 | 03, 04 §1 |
| 3 | 아뜨랑스 전산 연동으로 상품별 링크 배정 | 04 §1.2 |
| 4 | 개인정보·통장사본 등록 후 수당 인정(KYC) | 00 §4.1, 02 `kyc_profiles`, 03 §5 |
| 5 | 유저별 링크 발급 → 포스팅 → 수익 | 00 §4.2, 03 §1 |
| 6 | 구매 실적 수신 → 대시보드 실적·차월 정산 예정액·정산 히스토리 | 03 §3~4, 00 §4.3 |
| 7 | 수퍼어드민: 전체/개별 실적, 그레이드 차액, 24h 간접구매 실적 (수퍼어드민 전용) | 03 §2, §6 |
| 8 | 어드민(총판): 하부 유저 실적과 차액 정산금 | 03 §2, §6 |
| 9 | 일일 매거진 → 인스타/틱톡/블로그/쓰레드/X 채널별 콘텐츠 생산·제공 | 06 §1~3 |
| 10 | 짤, 트렌드 이슈, 제품 정보, 연예인 착용 검색 등 큐레이션 | 06 §4 |
| 11 | 다계정 운영, 예약 설정으로 정기 자동화 | 05 §4~5 |
| 12 | 다계정용 브라우저 고정 기능 | 05 §3 |
| 13 | 모든 작업은 Codex, 유저 구독 계정 OAuth 인증 | 04 §3, ADR-0005 |
| 14 | SNS 채널 연동 자동 포스팅 브라우저, 스페이스(계정 1:1), 세션·이력 분리, AI 에이전트 마우스·타이핑 (ego browser 참조) | 05 §2~3 |
| 15 | 텔레그램 봇으로 작업 지시·결과 보고 | 04 §4 |
| 16 | 쓰레드·인스타그램 Meta API 인증 설계 | 04 §2, ADR-0004 |
| 17 | stateless MCP로 작업 지시·결과 보고 | 04 §5, ADR-0003 |

## 코드 구성 (M1 코어)

```
apps/web/            Next.js 16 앱 + Convex 백엔드 (apps/web/convex/)
  convex/schema.ts   데이터 모델 정본
  convex/auth.ts     Convex Auth (이메일+비밀번호), 가입 시 역할·총판 연결 (lib/onboarding.ts)
  convex/{users,invites,kyc,products,links,clicks,orders,dashboard,settings,audit}.ts
  convex/http.ts     아뜨랑스 주문 웹훅 POST /partner/attrangs/webhook (HMAC 검증)
  app/r/[code]/      단축 링크 리다이렉터 (클릭 기록 → 아뜨랑스 상품 페이지)
  app/dashboard/*    유저: 대시보드·링크·주문 실적·KYC
  app/admin          총판: 초대 코드·하부 실적
  app/super/*        수퍼어드민: 운영 대시보드·유저/권한·KYC 검수·상품·주문 원장·요율
  tests/             convex-test 기반 함수 테스트
  scripts/e2e-local.mjs  로컬 E2E (가입→링크→클릭→웹훅→대시보드)
packages/shared/     순수 TS: 요율 계산, 웹훅 파서, 24h 어트리뷰션, CSV, 코드 생성
```

### 실행

```bash
pnpm install
cd apps/web
npx convex dev            # 최초 실행 시 "계정 없이 로컬 개발" 선택 가능 (익명 로컬 배포)
# Convex 환경변수 (npx convex env set KEY VALUE)
#   SITE_URL, JWT_PRIVATE_KEY, JWKS  → npx @convex-dev/auth 로 생성 가능
#   SUPER_ADMIN_EMAILS, KYC_ENC_KEY(openssl rand -base64 32),
#   REDIRECT_SHARED_SECRET, ATTRANGS_WEBHOOK_SECRET
# apps/web/.env.local 에 NEXT_PUBLIC_CONVEX_URL, REDIRECT_SHARED_SECRET
pnpm dev                  # next dev + convex dev
# 데스크톱 에이전트
pnpm --filter @automoney/desktop build
pnpm --filter @automoney/desktop start          # Electron (트레이 + 패널)
node apps/desktop/dist/cli.js pair <코드>       # 또는 CLI 로 페어링
node apps/desktop/dist/cli.js run               # 폴링 루프
```
Convex 추가 환경변수: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`(웹훅 등록 시 `secret_token`), `MIN_DESKTOP_VERSION`.

검증: `pnpm -r test`(shared 10 + convex 15 테스트), `pnpm -r typecheck`, `pnpm --filter @automoney/web build`, 서버 기동 후 `node apps/web/scripts/e2e-local.mjs`.

### M2 정산 엔진 (구현)
- `packages/shared/src/rules.ts`: 요율 규칙 해석(유저 예외 > 총판 예외 > 전역, 유효기간), 그레이드 구간, 기본 시드.
- `convex/lib/commissionEngine.ts`: 주문별 3단계 분배 원장(`commissionEntries`). "원하는 분배 − 정산된 금액" 델타만 미정산으로 남겨 취소·요율 변경·그레이드 확정을 한 경로(`recomputeMonth`)로 처리.
- `convex/settlements.ts`: 월 마감(DRAFT/HELD 재구성, KYC 미승인 보류·이월) → 아뜨랑스 확정 배치 CSV 업로드 → 리컨실(주문 대조·그레이드 확정·재계산·0원 오차 시 CONFIRMED) → 승인 → 지급 파일(계좌 복호화, 감사로그) → 지급 완료. 매월 크론 마감(`convex/crons.ts`).
- 화면: 유저 정산 히스토리·웹 명세서(인쇄/PDF), 총판 정산(차액), 수퍼어드민 정산 관리·요율/그레이드 관리.
- 확정 정책: 간접구매 유저 미지급(0bps), 원천징수·지급은 아뜨랑스 수행(세전 금액만 계산).

### M3a 데스크톱 에이전트 · 스페이스 · 예약 · 텔레그램 (구현)
- 클라우드(`apps/web/convex`): `devices`(1회용 페어 코드 → 디바이스 토큰, 1유저 1활성 디바이스), `agent`(HTTP: `/agent/claim`, `/agent/jobs/:id/heartbeat|complete`, `/agent/spaces/sync`, `/agent/config`; lease 120s·하트비트 30s·스페이스 락), `jobs`(승인 대기·취소·lease 회수 크론), `spaces`(생성·핀·일시정지·일일 한도·로그인/검증 요청), `schedules`(KST 예약·지터·일일 한도·5분 틱), `telegram`(웹훅 시크릿 검증, /start 바인딩, /status /earnings /links /schedule /post /jobs, 인라인 승인 버튼, 알림).
- 데스크톱(`apps/desktop`, Electron + Playwright): 트레이 + 최소 패널(페어링·상태), 딥링크 `automoney://pair?code=`, 스페이스별 격리 프로필·락·고정 지문, 오프스크린 실행, 쓰레드·X 레시피(세션 검증·게시), Codex 로그인 상태, `dist/cli.js` 로 Electron 없이 실행(`pair`, `run --once`, `status`).
- 화면: `/dashboard/devices`, `/dashboard/spaces`, `/dashboard/jobs`, `/dashboard/schedules`, `/dashboard/telegram`.
- 검증: `apps/desktop/scripts/e2e-agent.mjs` — 로컬 Convex 상대로 페어링 → 스페이스 생성 → 픽스처 페이지 세션 검증 → 승인 후 드라이런 게시 → 게시 URL 수집까지.
- M3-2 로 이관: 인스타그램·틱톡·네이버 블로그 레시피, Codex 에이전트 루프(스냅샷→액션) 복구, 자동 업데이트, 설치 파일 서명.

### M1 범위와 다음 단계
- 구현: 회원·RBAC·총판 초대, KYC 제출·암호화·검수, 상품 CSV/Mock 동기화, 링크 발급·단축 URL·클릭 로그, 주문 웹훅(멱등·24h 재검증·취소 역분개), 유저/총판/수퍼어드민 대시보드(단일 요율 예상 수당, 간접구매는 수퍼어드민 전용).
- 남은 로드맵: M3-2(추가 채널 레시피·Codex 에이전트 루프), M4 콘텐츠 엔진, M5 Meta API·MCP. 아뜨랑스 실제 API 어댑터는 규격 합의 후.

## 전제 (사용자 확정)
- 아뜨랑스에는 현재 파트너 API가 없으므로 **automoney가 인터페이스 규격을 제안**하고 아뜨랑스가 구현합니다. 초기 폴백은 CSV 배치입니다.
- 백엔드는 **Convex** 로 확정했습니다(ADR-0006, Postgres 결정 대체).
- 수당은 **3단계 마진 구조**(아뜨랑스 → 운영사(그레이드별 %) → 총판 → 유저)이며, 24시간 간접구매는 별도 요율입니다.
- 브라우저 자동화(스페이스, 고정, SNS 포스팅)와 Codex 로그인은 **유저 PC의 데스크톱 앱**에서 실행됩니다. 클라우드는 MCP, 정산, 대시보드를 담당합니다.
