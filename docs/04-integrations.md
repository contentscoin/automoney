# 04. 외부 연동 규격

## 1. 아뜨랑스 파트너 API (제안 규격)
아뜨랑스에는 파트너 API가 없으므로 automoney가 아래 규격을 제안하고 아뜨랑스가 구현합니다. 구현 전까지는 §1.7 CSV 폴백으로 운영합니다.

### 1.1 공통
- Base: `https://partner-api.attrangs.co.kr/v1`, 인증: `Authorization: Bearer {partner_api_key}` + `X-Partner-Id`.
- 웹훅 서명: `X-Attrangs-Signature: sha256={HMAC(secret, timestamp + "." + body)}`, `X-Attrangs-Timestamp`, 5분 리플레이 창.
- 멱등: 웹훅 `event_id` unique, 재전송 시 동일 응답.

### 1.2 상품·링크
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/products?updated_since=&page=` | 상품 목록(index_no, 이름, 가격, 할인가, 카테고리, 이미지, 상세 URL, 판매 상태) |
| POST | `/links` | `{ partner_user_code, product_id }` → `{ tracking_code, landing_url, expires_at? }` |
| DELETE | `/links/{tracking_code}` | 비활성화 |

### 1.3 주문 웹훅 (아뜨랑스 → automoney `POST /api/partner/attrangs/webhook`)
```json
{
  "event_id": "evt_01H…", "event_type": "order.created|order.cancelled|order.refunded|order.confirmed",
  "occurred_at": "2026-09-04T12:00:00+09:00",
  "order": {
    "order_id": "A20260904-0001", "ordered_at": "…",
    "tracking_code": "tc_…", "attribution": "direct|indirect",
    "clicked_at": "…", "landing_product_id": 12345,
    "items": [{ "product_id": 12345, "qty": 1, "amount": 39000, "commissionable_amount": 35000 }],
    "order_amount": 39000, "commissionable_amount": 35000, "status": "paid"
  }
}
```
어트리뷰션 판정은 아뜨랑스가 수행(쿠키 24h, 마지막 클릭). automoney는 `clicked_at`/`ordered_at`으로 24h 조건을 재검증합니다.

### 1.4 정산 확정
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/settlements?month=2026-08` | `{ grade, rate_bps, payout_total, orders:[{order_id, commissionable_amount, attribution, status}] }` |
| GET | `/grades` | 그레이드 구간표(월 매출 구간 → 지급률) |

### 1.5 매거진 피드
- `GET /magazines?published_since=` 또는 RSS/JSON Feed. 필드: id, 제목, 본문 HTML, 대표 이미지, 연결 상품 id 목록, 발행 시각.
- 폴백: 아뜨랑스 사이트 매거진 페이지 스크래핑(허가 전제).

### 1.6 SLA 요청 사항
- 웹훅 지연 5분 이내, 실패 시 지수 백오프 재시도 24h.
- 정산 확정 데이터 M+1 10일까지 제공.

### 1.7 CSV 폴백 (API 구현 전)
- 수퍼어드민이 아뜨랑스 제공 주문 CSV(주문번호, 주문일시, tracking_code, 상품, 금액, 직접/간접, 상태)를 업로드 → 동일 원장 파이프라인으로 처리. 링크 발급은 아뜨랑스가 사전 생성한 tracking_code 풀을 CSV로 등록 후 유저에게 배정.

## 2. Meta (Threads · Instagram)

### 2.1 앱 구성
- Meta 개발자 앱 1개에 Threads API 유스케이스와 Instagram API(Business Login) 유스케이스 추가.
- 사업자 인증(Business Verification) 필수, 개인정보처리방침·이용약관 URL, 데이터 삭제 콜백 제공.
- 앱 리뷰 권한 (권한별 개별 심사, 스크린캐스트 필요):

| 플랫폼 | 권한 | 용도 |
|---|---|---|
| Threads | `threads_basic`, `threads_content_publish`, `threads_manage_insights` | 발행, 인사이트 |
| Instagram | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights` | 피드·릴스 발행, 인사이트 |

### 2.2 연결 플로우
1. 유저가 대시보드에서 "인스타그램/쓰레드 연결" → Meta OAuth 리다이렉트(Cloud 콜백).
2. 단기 토큰 → 장기 토큰(60일) 교환, `sns_accounts.meta_token_enc` 암호화 저장, 만료 7일 전 `meta.token_refresh` 잡.
3. 계정 `auth_mode = META_API`. 실패·미승인 권한 시 자동으로 `BROWSER`(스페이스) 폴백.

### 2.3 발행
- Instagram: 미디어 컨테이너 생성(이미지/릴스 URL은 공개 접근 가능한 스토리지) → 게시. 릴스는 처리 상태 폴링.
- Threads: 컨테이너 생성 → 게시, 텍스트 500자·이미지·캐러셀 규격 검증은 콘텐츠 엔진 단계에서 수행.
- 한도: 플랫폼 API 일일 발행 한도와 계정별 `daily_post_limit` 중 작은 값.

### 2.4 앱 리뷰 전 운영
- 개발 모드에서는 테스터 계정만 가능. 리뷰 승인 전 일반 유저는 브라우저 스페이스 폴백으로 운영.

## 3. Codex (유저 구독 OAuth)

- 원칙: **Codex 토큰은 유저 PC에서만 생성·보관**. 데스크톱 에이전트가 `codex login`(브라우저 OAuth) 또는 `codex login --device-auth`(디바이스 코드)를 실행하고, 토큰은 `~/.codex/auth.json` 또는 OS 키체인에 저장됩니다. Cloud는 로그인 여부·만료만 보고받습니다.
- 근거: OpenAI 공식 문서상 ChatGPT OAuth는 Codex CLI/IDE/Cloud 용도이며 제3자 서버가 사용자 토큰으로 대신 호출하는 것은 지원 대상이 아닙니다. 서버 위임 구조는 계정 정지 위험이 있어 채택하지 않습니다(ADR-0005).
- 구현: blogautomcp `src/lib/codex-local.ts`(번들 바이너리 탐지, 비동기 로그인 잡), `scripts/lib/codex-draft-provider.ts`(SDK 호출) 계승. 모델은 설정값, 타임아웃·재시도 정책 유지.
- 폴백: 유저가 OpenAI API 키를 입력하면 `openai-text.ts` 경로 사용(과금 유저 부담 명시).
- Codex 사용처: 채널별 문안 최종화, 브라우저 에이전트 조작 계획(스냅샷→액션), 큐레이션 요약, 텔레그램 자연어 명령 해석.

## 4. 텔레그램 봇

### 4.1 바인딩
- 대시보드에서 6자리 바인딩 코드 발급 → 유저가 봇에 `/start {code}` → `telegram_bindings` 저장. 1유저 1채팅, 그룹은 총판 전용 옵션.

### 4.2 명령
| 명령 | 동작 |
|---|---|
| `/status` | 에이전트 온라인, 스페이스 상태, 오늘 예약 |
| `/post {상품/링크} [채널] [시간]` | 콘텐츠 생성 후 승인 카드 전송 → 승인 시 발행 잡 |
| `/schedule` | 예약 목록·일시정지·재개 |
| `/earnings` | 오늘·이번 달 실적, 예상 수당 |
| `/links` | 최근 링크, 새 링크 발급 |
| `/content` | 오늘 매거진 기반 추천 콘텐츠 3개 |
| 자연어 | Codex가 의도 분류 → 위 명령으로 매핑, 모호하면 선택지 버튼 |

### 4.3 보고
- 잡 완료·실패(에러 코드·다음 조치), 스페이스 세션 만료(재로그인 필요), 주문 발생(옵션), 정산 확정·지급.
- 구현: blogautomcp `scripts/lib/chatbot-notifier.ts`(3600자 분할, 링크 제한) 확장 + Cloud 웹훅 수신 `/api/telegram/webhook`. 승인 콜백은 `callback_data`에 잡 id·서명.

### 4.4 다계정
- 한 텔레그램 채팅에서 여러 스페이스를 지정(`/post … @space:insta_main`). 스페이스별 권한은 소유 유저로 제한.

## 5. Stateless MCP

### 5.1 서버
- Streamable HTTP, POST 전용, 세션 상태 없음(요청마다 토큰으로 유저·스코프 결정). blogautomcp `apps/sites/app/api/mcp/[credential]/route.ts` 계승.
- 엔드포인트: OAuth 연결 `/api/mcp`(Dynamic Client Registration, PKCE, `.well-known/oauth-authorization-server`)와 원타임 발급 URL `/api/mcp/{endpointId}.{secret}` 두 경로.
- 스코프: `mcp:read`, `mcp:write`, `admin:read`, `super:read`. 툴 노출은 스코프와 역할로 필터.
- 툴 인자 스키마는 `tool-schema.ts` 한 곳에서 정의하고 문서·검증에 공용.

### 5.2 툴 카탈로그
| 툴 | 스코프 | 설명 |
|---|---|---|
| `agent_get_status` | read | 디바이스·스페이스·Codex 로그인 상태 |
| `product_search` | read | 상품 검색 |
| `link_issue` | write | 상품 링크 발급 |
| `link_list` | read | 내 링크·클릭·전환 |
| `earnings_get` | read | 기간별 실적·예상 수당 |
| `settlement_history` | read | 정산 히스토리 |
| `magazine_today` | read | 오늘 매거진과 추천 콘텐츠 |
| `content_generate` | write | 상품/매거진 → 채널별 콘텐츠 잡 |
| `content_list` / `content_get` | read | 라이브러리 조회 |
| `curation_fetch` | write | 짤·트렌드·제품정보·연예인 착용 검색 잡 |
| `space_list` / `space_create` / `space_pin` | read/write | 스페이스 관리 |
| `post_schedule` | write | 예약 등록(스페이스·시간·콘텐츠) |
| `post_publish` | write | 즉시 발행, `confirmed: true` 필수 |
| `post_verify_published` | read | 게시 URL 검증 |
| `job_get` / `job_cancel` | read/write | 잡 상태·취소 |
| `admin_team_stats` | admin:read | 하부 유저 실적·총판 차액 |
| `super_stats` | super:read | 전체·간접구매·운영사 차액 |

### 5.3 결과 계약
- 모든 write 툴은 잡 id를 즉시 반환하고 결과는 `job_get`으로 조회(장시간 작업은 데스크톱에서 수행되므로 비동기).
- 결과 봉투는 `automoney.job-result/v1`(01 §2.2). 위험 툴(`post_publish`, `space_create`)은 `confirmed` 없이 호출 시 미리보기만 반환.
- 레이트리밋: IP 600 req/min, 유저 120 calls/min(blogautomcp 값 유지). 최소 데스크톱 버전 미달 시 `APP_UPDATE_REQUIRED`.

## 6. 구현 메모 (M5, 2026-09-05)
- **Meta**: `apps/web/convex/lib/meta/` — `adapter.ts` 계약, `graph.ts`(Threads `graph.threads.net/v1.0` 컨테이너→`threads_publish`, Instagram `graph.instagram.com/v21.0` `media`→`media_publish`, 릴스 `status_code` 폴링, 에러 코드 190/463/467→`META_TOKEN_EXPIRED`, 10/200/299→`META_PERMISSION`, 4/17/32→`META_RATE_LIMITED`), `mock.ts`(코드 `mock:<이름>`, 토큰 `expired-` 접두로 만료 시뮬레이션, 본문 `[meta-fail]` 로 발행 실패 시뮬레이션). 콜백 `GET /meta/callback`, 계정 `snsAccounts`(토큰 AES-GCM 암호화, `META_TOKEN_ENC_KEY` 없으면 `KYC_ENC_KEY`), 스페이스 `authMode=META_API` + `snsAccountId`. 발행 잡은 `agentJobs.executor=CLOUD` 로 분기해 `internal.meta.runCloudJob` 이 실행한다. 앱 리뷰 전 실 API 는 테스터 계정만 동작(§2.4).
- **MCP**: `POST /mcp` 라우터(`convex/mcp.ts`), 툴 스키마 `packages/shared/src/mcpTools.ts`(21종 — §5.2 의 18종 + `content_get`, `space_pin`, `job_cancel` 분리). `link_issue` 만 액션 컨텍스트(아뜨랑스 어댑터)에서 처리하고 나머지는 하나의 내부 뮤테이션 디스패처(`lib/mcpTools.ts`)가 기존 `*For` 헬퍼를 호출한다. 레이트리밋은 `mcpRateBuckets` 고정 창(1분). OAuth 경로는 ADR-0007 참고.

