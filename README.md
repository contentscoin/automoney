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
- M3-2(구현): 인스타그램·틱톡·네이버 블로그 레시피(픽스처 검증), **오토파일럿**(`src/agent/autopilot/`: 시맨틱 스냅샷→플래너→액션 루프, 금지 컨트롤 차단, 발행 게이트; 플래너는 `codex exec` 또는 테스트용 scripted) — 레시피 실패 시 `autopilot: true` 설정 + Codex 로그인 상태면 자동 복구, 자동 업데이트(`src/updater.ts`, generic 피드, 유휴 확인 후 설치), electron-builder 서명·노터라이즈 설정과 `.github/workflows/desktop-build.yml`.
- 남은 M3: 실제 SNS 에서 셀렉터 튜닝, Codex 플래너 실사용 검증, 설치 파일 서명 인증서 확보.

### M4 콘텐츠 엔진 · 큐레이션 (구현)
- 원칙: **클라우드 LLM 생성 없음** — 생성은 새 잡 `content.generate` 로 유저 PC 의 에이전트가 수행합니다(`codex exec`, 유저 구독 OAuth). Codex 미설치·미로그인·파싱 실패 시 규칙 템플릿(`packages/shared/src/content.ts` `templateGenerate`)으로 폴백하며 결과에 `generatedBy` 를 남깁니다. `AUTOMONEY_CONTENT_PROVIDER=template` 로 강제할 수 있습니다(테스트·E2E).
- 클라우드(`apps/web/convex`): `magazines`(수퍼어드민이 URL 또는 HTML 등록 → og·본문·이미지·`index_no` 상품 링크 추출 → 원자 HOOK/STYLE_TIP/PRODUCT_POINT/QUOTE/TREND_TIE_IN), `content`(생성 요청 → 잡 → 완료 시 `evaluatePiece` 품질 게이트: 광고 표기 자동 삽입, 금칙 주장 차단(최저가·1위·직접 착용·100%), 채널 길이·해시태그 규격, 90점 이상·차단 0 이면 자동 APPROVED 아니면 DRAFT; 라이브러리 = 내 것 + 운영 공유(SHARED); 수정·승인·거절 사유 축적; `pieceId` 로 즉시 게시·예약 채우기), `curation`(구글 트렌드 KR RSS 6시간 크론, 제품 정보 팩(카탈로그 규칙), 연예인 착용 검색은 `lib/search/provider.ts` SearchProvider 추상화 — `BRAVE_API_KEY`/`SERPAPI_KEY` 있을 때만, 출처 링크만 저장·이미지 재게시 금지 라벨, 수퍼어드민 수동 등록은 라이선스 메모 필수).
- 데스크톱: `src/agent/codexText.ts`(codex exec 텍스트 생성), `handleContentGenerate`(프롬프트 → provider → 파싱 → 결과 봉투 `data.pieces`).
- 화면: `/dashboard/content`(생성 요청·오늘의 매거진·라이브러리/짤/트렌드/제품정보/연예인 탭·조각 카드 → "이 콘텐츠로 게시/예약"), `/super/magazines`(매거진 등록·소재 보기·큐레이션 수동 등록·트렌드 갱신·프로바이더 상태·전체 조각 공유 관리·거절 통계), 작업·예약 화면의 라이브러리 선택. 텔레그램 `/content`.
- 검증: shared 27 · convex-test 34 · desktop 19 테스트, `e2e-agent.mjs` 에 매거진 등록 → 생성(template) → 자동 승인 → pieceId 게시 → 공유 가시성 추가.

### 데스크톱 배포·서명
- 설치 파일 다운로드: https://github.com/contentscoin/automoney/releases/latest (`desktop-v*` 태그 푸시 시 GitHub Release 에 Windows `.exe`·macOS `.dmg/.zip` 자동 첨부). 패키징된 앱은 번들 Chromium 이 없으므로 시스템 Chrome → Edge 순으로 자동 폴백하며, `AUTOMONEY_BROWSER_CHANNEL`/`AUTOMONEY_BROWSER_EXECUTABLE` 로 고정할 수 있다.
- 태그 `desktop-v*` 푸시 시 `desktop-build.yml` 이 Windows(NSIS)·macOS(dmg/zip) 를 빌드합니다. 시크릿 `CSC_LINK`/`CSC_KEY_PASSWORD`(코드사인 인증서 p12 base64/비밀번호), `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`(노터라이즈) 가 있으면 서명·노터라이즈, 없으면 서명 없이 빌드합니다. 자동 업데이트는 기본으로 GitHub Releases(`latest.yml`) 를 피드로 쓰며, 새 `desktop-v*` 릴리스가 올라오면 설치된 앱이 유휴 시점에 스스로 갱신합니다(서명 없는 macOS 빌드는 electron-updater 제약으로 자동 갱신이 되지 않아 수동 재설치). 사설 피드를 쓰려면 `AUTOMONEY_UPDATE_FEED_URL`(https 정적 호스팅), 끄려면 `off`. 태그 푸시 없이 릴리스하려면 Actions 에서 `desktop-build` 를 `release_tag=desktop-vX.Y.Z` 입력과 함께 수동 실행하면 현재 커밋에 태그와 Release 를 만듭니다.
- 에이전트 설정(`~/.automoney/config.json`): `autopilot`(레시피 실패 시 Codex 복구), `updateFeedUrl`, `browserChannel`, `headless`.

### M5 Meta API · Stateless MCP · 분석 루프 (구현)
- **Meta API 발행**(ADR-0004): `convex/lib/meta/` 어댑터(`graph.ts` 실 Threads/Instagram Graph API, `mock.ts` 앱 자격증명 없이 전체 흐름 검증). `/dashboard/spaces` 에서 "스레드/인스타그램 연결" → OAuth(`/meta/callback`) → 장기 토큰 암호화 저장(`snsAccounts`) → `authMode=META_API` 스페이스(디바이스 불필요). 이 스페이스의 `post.publish` 는 `executor=CLOUD` 로 Convex 액션이 실행하고, 토큰 만료·권한 오류 시 같은 페이로드를 브라우저 스페이스 잡으로 자동 폴백(`fallbackFromJobId`). 만료 7일 전 `meta.token_refresh` 크론. `META_APP_ID/META_APP_SECRET` 이 있으면 실 API, 없거나 `META_MODE=mock` 이면 Mock.
- **Stateless MCP**(ADR-0003·0007): `packages/shared/src/mcpTools.ts` 가 툴 카탈로그(21종) 단일 소스. `POST /mcp/{endpointId}.{secret}` 또는 `POST /mcp` + `Authorization: Bearer am_mcp_…`, JSON-RPC 2.0(`initialize`/`tools/list`/`tools/call`/`ping`), 세션 상태 없음. 스코프 `mcp:read|mcp:write|admin:read|super:read` 는 역할 범위로 제한, 레이트리밋 유저 120/min·IP 600/min, 위험 툴(`post_publish`·`space_create`)은 `confirmed:true` 없이는 미리보기, write 툴은 잡 id 반환 → `job_get` 폴링, 모든 호출 감사 기록, 응답 필드 화이트리스트(간접 구매는 `super:read` 만). `/dashboard/mcp` 에서 발급·폐기·Claude/Cursor 설정 스니펫. **OAuth 2.1** 도 지원: 서버 URL(`…/mcp`) 만 넣으면 `.well-known` 발견 → 동적 등록 → `/oauth/authorize` 동의 → PKCE 토큰 교환 → 1시간 액세스·30일 리프레시(회전). 세부는 ADR-0007 후속 절.
- **분석 루프**(docs/06 §5): 게시 성공 시 `postMetrics` 생성 → 1시간 크론이 24h/72h/7d 창마다 (a) Meta 계정은 insights API (b) 브라우저 스페이스는 데스크톱 잡 `post.readback`(레시피 공통 `readPostMetrics`, 픽스처 훅) (c) 원장(링크 클릭·주문·매출, 창 경계 고정)을 결합. 7d 확정 시 `experiments`(계정×채널×훅/CTA/시간대) 누적 → `evaluateLift`(표본≥20·+15%·z≥1.96) 통과 시 `playbooks` 승격 → `content.requestGenerate` 프롬프트에 "검증된 패턴"·"피해야 할 것(거절 사유)" 주입. 화면 `/dashboard/analytics`, `/super/analytics`(전역 실험 승격/철회), 텔레그램 `/report`.
- 검증: shared 33 · convex-test 44 · desktop 22 테스트, `apps/web/scripts/e2e-mcp.mjs`(순수 JSON-RPC 클라이언트로 initialize→tools/list→product_search→link_issue→Meta mock 연결→post_publish(confirmed)→job_get→post_verify_published→post_schedule→earnings_get→폐기 401), `e2e-agent.mjs` 에 readback 잡 추가.

### M1 범위와 다음 단계
- 구현: 회원·RBAC·총판 초대, KYC 제출·암호화·검수, 상품 CSV/Mock 동기화, 링크 발급·단축 URL·클릭 로그, 주문 웹훅(멱등·24h 재검증·취소 역분개), 유저/총판/수퍼어드민 대시보드(단일 요율 예상 수당, 간접구매는 수퍼어드민 전용).
- 남은 로드맵: MCP OAuth(PKCE·DCR) 경로, Meta 앱 리뷰 후 실 API 검증, 코디 제안 카드. 아뜨랑스 실제 API 어댑터는 규격 합의 후.

## 전제 (사용자 확정)
- 아뜨랑스에는 현재 파트너 API가 없으므로 **automoney가 인터페이스 규격을 제안**하고 아뜨랑스가 구현합니다. 초기 폴백은 CSV 배치입니다.
- 백엔드는 **Convex** 로 확정했습니다(ADR-0006, Postgres 결정 대체).
- 수당은 **3단계 마진 구조**(아뜨랑스 → 운영사(그레이드별 %) → 총판 → 유저)이며, 24시간 간접구매는 별도 요율입니다.
- 브라우저 자동화(스페이스, 고정, SNS 포스팅)와 Codex 로그인은 **유저 PC의 데스크톱 앱**에서 실행됩니다. 클라우드는 MCP, 정산, 대시보드를 담당합니다.
