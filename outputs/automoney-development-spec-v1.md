# automoney 개발 실행 명세 v1.0

작성일: 2026-09-21. 기준: `2a7ef7ef76bf07ff8b883976421c359f93484f23`.
대상: Sol 구현 담당자, 코드 리뷰 담당자, 운영 담당자.
상태: 로컬 개발 착수 가능한 실행 기획. 외부 계약·실서비스 승인을 대신하지 않는다.

## 1. 목표와 범위

첫 출시 목표는 한 명의 사용자가 가입 → 상품 링크 확보 → 콘텐츠 선택 → 승인 → SNS 게시 → 주문 반영 → 월 정산 명세 확인을 일관된 데이터로 완료하는 제한 베타다. 다음 개발의 목표는 이 경로의 권한·멱등성·복구·정산 정확성을 완성하는 것이다.

기존 구현을 유지한다: Next.js/React 웹, Convex 도메인·DB·스토리지·Cron, Electron/Playwright 에이전트, shared TypeScript 계약. Postgres, Redis, SQLite, 데스크톱 내장 Next 서버를 새로 도입하지 않는다. 스케줄 정본은 Cloud, 로컬은 파일 기반 실행/완료 보고 기록이다. AI 생성은 사용자 PC Codex와 표시되는 템플릿 폴백이다.

### 출시 단계

| 단계 | 포함 | 완료 의미 |
|---|---|---|
| R0 개발 검증 | 합성 사용자·주문·KYC, Mock Meta, SNS 픽스처, 로컬 Convex | 전체 핵심 흐름을 외부 자격증명 없이 재현 |
| R1 제한 베타 | 검증된 파트너 CSV, 검증된 채널만 활성화, 수동 게시 승인, 실제 정산 대조 | 3개 스페이스·7일 운영 증거와 월 정산 0원 오차 확보 |
| R2 일반 공개 | 실제 파트너 API 또는 계약된 CSV 운영, 승인된 Meta, 서명 앱, 운영 복구 체계 | 릴리스 게이트 모두 충족 |

R1 기본 개발 범위는 이메일 가입, 기존 3역할, 상품/링크/주문, KYC, 정산, 콘텐츠 라이브러리, 5채널 중 검증된 채널의 게시, 1회/매일/요일 예약, Telegram 명령, 기존 21 MCP 툴/OAuth, readback이다. 채널별 출시 여부는 독립적이며 미검증 채널은 화면에서 비활성화 사유를 보여준다.

R2 이후로 미룬다: 카카오 로그인, QR, 즐겨찾기, 임의 cron 입력, 티스토리, 자연어 Telegram 명령, 미디어 자동 제작, 전문가 패널/자동 반복 생성, 멀티 디바이스·병렬 잡, 프록시/지문 변조. 이는 새 기획 기준의 범위 결정이며 기존 문서에서 이미 완성된 기능이라는 뜻이 아니다.

## 2. 증거와 우선 수정 사항

아래는 코드 읽기로 확인한 사항이다. 보안 공격 재현이나 운영 장애 실측 결과로 표현하지 않는다. Sol은 수정 전 회귀 테스트로 재현한다.

| ID | 코드 근거 | 관찰 | 필수 조치 |
|---|---|---|---|
| F01 | convex/schedules.ts: upsertScheduleFor | 전달한 space 소유권만 확인하고 기존 schedule id를 patch | 기존 예약 소유권도 수정 전에 검증 |
| F02 | convex/schedules.ts: tick; jobs.ts: enqueuePublishFor | 예약 경로에서 최근 50건으로 일일 한도 계산, 공통 발행 진입에는 동일 검사 없음 | 모든 발행 진입 및 실행 직전에 동일 정책 적용 |
| F03 | desktop/src/agent/loop.ts: runJob | 성공 complete 요청 실패도 catch에서 FAILED 보고로 전환 | 실행 결과와 전달 실패 분리, 성공 결과 재전송 |
| F04 | desktop/src/agent/loop.ts: checkpoint | heartbeat 예외를 삼키고 계속 진행 가능 | 실제 발행 직전 유효 lease 확인 실패 시 발행 중지 |
| F05 | convex/orders.ts: applyToExisting | 기존 주문은 새 이벤트 상태만 적용, 사건 시각/순서와 금액 수정 정책 없음 | 역순 이벤트·동시 수정·부분환불 계약 확정 및 처리 |
| F06 | convex/settlements.ts: getStatement/adminMonth | 명세서 lines에 attribution 포함, 총판 응답에 총액과 직접 차액 동시 반환 | 간접구매 상세 및 차액 역산 누출 방지 |
| F07 | convex/kyc.ts: saveSubmission | 파일 존재/크기/type 검사, 업로더 소유권 결합은 없음 | 업로드 intent와 소유권 검증, 보호된 열람 |
| F08 | convex/meta.ts: saveAccount/completeCloudJob | API 전용 space 생성은 device 없이 가능, 폴백은 같은 space.deviceId 필요 | 명시적 브라우저 폴백 매핑 구현 |
| F09 | convex/settlements.ts: reconcile | MISSING_OURS를 diff로 남김 | 원천 데이터 보강 후 동일 수신 경로로 재처리; 임의 주문 생성 금지 |
| F10 | convex/schedules.ts: tick | payload에 기존 schedule.pieceId가 전달되지 않음 | 콘텐츠 출처를 잡·게시·분석까지 유지 |

경로의 convex/는 apps/web/convex/를 의미한다. 현재 상태를 파일 존재만으로 완료 처리하지 않는다. 이전 분석의 116개 테스트 통과는 당시 실행 결과이며 구현 후 다시 측정한다.

## 3. 확정 정책

### 권한

- USER: 본인 업무 데이터. ADMIN: 본인 및 소속 사용자에 허용된 직접 실적. SUPER_ADMIN: 전체 운영.
- 모든 변경은 서버에서 actor, 대상 소유자, 계정 ACTIVE 상태를 검사한다. UI 숨김은 접근 통제가 아니다.
- 타인 id는 NOT_FOUND로 반환한다. 역할은 발급 시점이 아닌 호출 시점에 다시 확인한다.
- ADMIN에게 간접 주문 행·건수·요율·간접 차액 및 직접/전체 차액 조합을 반환하지 않는다. 본인 차액 총액만 표시하고 상세 명세는 민감 구분 없이 집계한다.
- USER/ADMIN의 명세서·CSV·MCP·Telegram에 동일 응답 정책을 적용한다.

### 돈과 시간

- KRW 정수, bps 정수, 원 단위 floor. 기존 USER/ADMIN/OPERATOR 분배와 합계 보존 원칙 유지.
- 사용자 간접 요율 0bps, 간접 실적 상세는 SUPER_ADMIN만. 실제 지급·원천징수는 아뜨랑스, automoney는 세전 금액과 지급 기록.
- 계약 미확정 요율을 운영값으로 seed하지 않는다. 합성 테스트값은 표시하고 실 데이터와 분리.
- 저장 시각 UTC epoch ms, 예약/일일 한도/월 경계 Asia/Seoul. 월 마감 기본은 현재 코드의 매월 2일 03:00 KST를 유지한다.
- CONFIRMED 이후 금액·구성 원장은 고정한다. 재계산 차이는 후속 미정산 조정으로 남긴다. 이미 확정된 월에 변경 배치를 넣어 덮어쓰지 않는다.
- 음수 수혜 잔액은 HELD로 이월하며 음수 지급 파일을 만들지 않는다. USER와 ADMIN 수령인 모두 지급 시점 KYC 조건을 충족해야 한다.

### 승인·발행·복구

- 베타에서는 서버 기본 requireApproval=true. 명시적으로 저장된 autoApprove 설정만 생략 가능. 과거 값이 없으면 승인 필요로 해석.
- 승인은 플랫폼·계정·본문·미디어·링크·콘텐츠 버전으로 만든 payloadHash에 결합한다. 바뀌면 재승인. 승인 유효기간은 기존 24시간.
- 게시 직전 서버 preflight가 계정 상태, space 상태, 한도, 간격, 취소, lease, 승인 hash를 다시 확인한다.
- 기본 최소 게시 간격 15분은 제품 초기값이다. 플랫폼의 공식 허용치라는 의미가 아니다. 일일 기본값은 기존 PLATFORM_LIMITS를 사용하고 더 엄격한 운영값을 적용할 수 있다.
- 예약 허용 지연 2시간. 만료는 FAILED + SCHEDULE_EXPIRED. 다음 반복 슬롯으로 넘기고 폭주하는 밀린 게시를 만들지 않는다.
- 원격 게시의 exactly-once를 보장한다고 쓰지 않는다. 부수효과 발생 여부가 불명확하면 FAILED + AGENT_LOST_UNCERTAIN과 별도 검증 필요 표시; 자동 재게시·autopilot·Meta 폴백 금지.
- 이미 성공한 실행의 보고 실패는 성공 결과를 재전송한다. 결과를 실패로 바꾸지 않는다.
- dryRun은 quota/실게시 지표/매출 귀속을 소비하지 않는다. 실게시 직전 의도 기록은 dryRun에서 만들지 않는다.

## 4. 핵심 사용자 화면의 완료 조건

| 화면 | 추가/보완 동작 | 오류·빈 상태 |
|---|---|---|
| 링크 | Mock/실발급 구분, CSV 풀 소진 표시, 활성 링크만 발행 사용 | 파트너 미설정, 소진, 비활성 상품 안내 |
| 콘텐츠 | generatedBy, 품질 사유, 승인 버전 표시 | Codex 실패 시 템플릿 사용 사실 노출 |
| 예약 | 다음 KST 실행·만료 정책·승인 여부·활성 채널 | 과거 날짜/잘못된 요일 거절; 건너뛴 사유 표시 |
| 작업 | 승인 payload 미리보기, 취소, 실행 단계, 보고 재전송/게시 확인 필요 | 불명확한 게시의 재시도 버튼 대신 확인 흐름 |
| 스페이스 | API/브라우저 방식, 검증 계정, 명시적 폴백 대상 | 오프라인/로그인 만료/제한 상태별 복구 행동 |
| KYC | 안전한 업로드, 제출/반려/승인 | 만료 업로드 재시작, 반려 사유, 처리 중 표시 |
| 정산 운영 | import 미리보기→확정, diff, 승인, 지급 결과 수신 | 단 1원 차이/누락/충돌도 확정 차단 |
| 사용자·총판 정산 | 역할별 명세와 이월 내역 | 간접 상세가 응답 자체에 없어야 함 |

## 5. 데이터 변경 계약 — 제안 스키마

다음은 신규 구현 목표이며 현재 존재한다고 해석하지 않는다. 기존 테이블 이름과 id는 유지한다. 각 필드마다 검증·인덱스·마이그레이션 테스트를 포함한다.

### agentJobs 확장

`requestKey?`, `rootJobId?`, `attemptNo?`, `leaseTokenHash?`, `expiresAt?`, `payloadHash?`, `approval? {actorUserId, approvedAt, payloadHash}`, `publishPhase? (PREPARING|INTENT_RECORDED|CONFIRMED|UNCERTAIN)`, `completionHash?`, `protocolVersion?`.

상태 enum은 기존 6개를 유지한다. UNCERTAIN은 별도 status를 무분별하게 추가하지 않고 publishPhase 및 오류 코드로 표현한다. 신규 attempt는 토큰을 바꾸고 이전 토큰의 heartbeat/complete를 거절한다. 멱등 키는 userId + requestKey 복합 인덱스로 격리한다. payload가 다른 동일 키는 IDEMPOTENCY_CONFLICT.

### publishReservations 신규

필드: userId, spaceId, rootJobId, kstDay, state(RESERVED|COMMITTED|RELEASED|UNCERTAIN), reservedAt, expiresAt, committedAt?. 인덱스: by_space_day(spaceId,kstDay), by_root(rootJobId).

preflight 한 트랜잭션에서 lock과 quota 예약. RESERVED/COMMITTED/UNCERTAIN은 한도에 포함, RELEASED 제외. 불명확한 예약은 자동 만료 해제 금지. Meta→브라우저 폴백은 동일 rootJobId 예약을 인계하고 추가 차감하지 않는다. KST 날짜가 바뀌면 발행 전 당일 quota로 재예약한다. 대기 잡 생성 시에는 예상 한도를 안내하되 최종 quota는 실행 직전 판정한다.

### orders/orderEvents 확장

orders: lastSourceVersion?, lastOccurredAt?, source(CSV|WEBHOOK|RECON)?, ingestionVersion?. orderEvents: payloadHash?, applyStatus(APPLIED|STALE|QUARANTINED)?, reason?.

동일 event_id·동일 hash는 no-op, 동일 id·다른 hash는 충돌 격리. sourceVersion이 있으면 우선 사용, 없으면 occurredAt과 전이 규칙. 역순 또는 동일 시각의 충돌은 기록 후 자동 적용하지 않는다. CONFIRMED→REFUNDED 같은 합법적 후속 변화는 허용. 주문 금액 수정은 전/후 전체 snapshot 차이로 통계·수수료 조정. 부분환불은 계약된 누적 순금액/품목 규격 확보 전 격리하며 전체 환불로 추정하지 않는다.

### importBatches/importRows 신규

batch: kind(PRODUCT|LINK_POOL|ORDER|SETTLEMENT), contentHash, sourceVersion, uploadedBy, status(PREVIEW|VALIDATED|APPLYING|COMPLETED|FAILED), counters, cursor?, createdAt, completedAt?.
row: batchId, rowNo, normalizedPayload, rowHash, status, errors[]. 인덱스 by_batch_row와 batch contentHash/kind. 숫자/날짜/URL/중복 검증 후 미리보기. apply는 100행 이하 배치로 재개 가능하게 처리한다. 거래 원천값을 action에서 검증하고 mutation에서 멱등 반영. 같은 파일 재업로드도 추가 주문·수수료를 만들지 않는다.

### partnerLinkPool 신규

productId, trackingCode, targetUrl, assignedUserId?, assignedLinkId?, status(AVAILABLE|ASSIGNED|DISABLED), batchId. by_trackingCode 및 by_product_status 인덱스. 한 트랜잭션에 배정/marketingLinks 생성. 다른 사용자에게 같은 코드 중복 배정 금지. 실제 풀 없으면 발급 실패; Mock 코드 자동 생성 금지.

### uploadIntents 신규와 KYC 암호화 메타

uploadIntents: userId, purpose=KYC_BANKBOOK, expiresAt, storageId?, state(PENDING|BOUND|CONSUMED|EXPIRED). intent 생성→서버가 제공하는 인증 업로드 경로에서 사용자/파일을 결합→같은 사용자 submit에서 소비. 클라이언트가 넘긴 arbitrary storageId를 소유권 증거로 삼지 않는다.

암호문은 version/keyId/iv/ciphertext 정보를 갖게 확장하되 기존 iv.ciphertext를 읽는 legacy decoder 유지. 실 주민번호 수집 범위·보관기간은 계약/법무 결정을 기다리는 출시 게이트이며 개발 테스트는 합성값만 사용. KMS 공급자 미선정 상태에서 SDK를 임의 도입하지 말고 key provider 인터페이스와 로컬 테스트 구현을 준비한다.

### snsAccounts, schedules 확장

snsAccounts.fallbackSpaceId?는 동일 사용자·동일 플랫폼·확인된 동일 계정에만 설정. 대상이 건강하지 않으면 NEEDS_ACTION 응답/수동 복구로 종료. schedules에 revision?, lastSkipReason?, lastSkippedAt? 추가. schedule.pieceId는 실제 job payload와 metrics로 보존한다.

## 6. API·실행 계약

### 기존 진입점 유지

웹은 기존 Convex query/mutation/action, 데스크톱은 `/agent/claim`, `/agent/jobs/:id/heartbeat|complete`, MCP는 `/mcp`, 주문은 `/partner/attrangs/webhook`를 유지한다.

공통 서비스: `assertOwnedActiveResource`, `validatePublishRequest`, `authorizePublishAttempt`, `applyOrderEvent`, 역할별 `to*View`. WEB/MCP/TELEGRAM/SCHEDULE/SYSTEM이 이 경로를 함께 사용한다. 공통 helper는 클라이언트가 전달한 userId를 신뢰하지 않는다.

### 신규 agent protocol v2

claim 응답: 기존 필드 + protocolVersion=2, attemptNo, leaseToken(원문은 응답에만, DB hash), leaseExpiresAt.
heartbeat 요청: jobId URL + attemptNo + leaseToken + stage + progress. stale attempt는 HTTP 409.
신규 POST `/agent/jobs/:id/preflight`: attempt 인증 후 승인·취소·소유권·quota 확인, publishIntentId 반환. 실패 시 게시 금지. intent는 게시 가능성 기록이지 provider 완료 증거가 아니다.
complete 요청: attemptNo, leaseToken, completionId, result, resultHash. 같은 completionId와 같은 canonical hash 재전송은 200/no-op. 같은 id·다른 내용 또는 다른 attempt는 409. resultHash는 서버가 재계산한다.
Cloud 실행도 같은 정책 helper를 사용하되 내부 mutation으로 호출한다. publish request timeout 이후에는 확인 전 다른 executor로 넘기지 않는다.
호환성: v1 에이전트는 상태 확인/업데이트 안내 가능, R1 실게시에서는 APP_UPDATE_REQUIRED로 차단. 서버 먼저 additive 배포→v2 에이전트 배포→실게시 v2 gate 활성화 순서.

### CSV 최소 내부 계약

- 상품: external_product_id, name, price, sale_price?, detail_url, image_urls, status.
- 링크 풀: external_product_id, tracking_code, target_url.
- 주문: event_id, event_type, occurred_at, order_id, ordered_at, tracking_code, attribution, clicked_at?, order_amount, commissionable_amount, status, source_version?.
- 정산 확정: 기존 shared/settlement-csv.ts 계약을 우선 사용하고 batch id/hash 및 검증 결과를 부가한다.
- 실제 파트너 형식은 adapter에서 내부 계약으로 변환한다. 외부 CSV 형식이 확정됐다고 주장하지 않는다.
- 입력은 UTF-8 BOM 허용, 최대 2MB/5,000행 초기값, 100행 단위 처리. 초과는 명확히 거절. 출력은 스프레드시트 수식 주입을 방지하고 금액 원값은 유지한다.

## 7. 정산 불변식·예외

1. 각 주문의 USER+ADMIN+OPERATOR 분배 합계 = 원천 지급 총액. 계산 예시는 합성 base 35,000원, 500/800/1,200bps일 때 1,750/1,050/1,400원이며 실제 계약 요율이 아니다.
2. 동일 이벤트·동일 마감·동일 리컨실 재실행 결과가 동일하다.
3. APPROVED/PAID 금액과 수혜자 snapshot은 변하지 않는다.
4. 확정 전 원천 주문 변경 시 기존 CONFIRMED를 조용히 재사용하지 않는다. 새 조정/리컨실 revision으로 명시하고 지급 승인 gate에서 pending diff를 확인한다.
5. 전월 지급 후 환불은 다음 미지급 정산의 음수 조정, KYC 보류는 원장 소멸 없이 이월.
6. 원천에만 존재하는 주문은 추가 필수 데이터 확보 전 MISSING_OURS. batch 총액에 맞추려고 임의 배정/금액 보정하지 않는다.
7. 승인 요청 revision과 현재 revision이 다르면 STALE_REVISION. 지급 파일은 승인된 snapshot의 hash와 연결하고 markPaid는 지급 참조와 같은 snapshot을 요구한다.
8. 베타 운영 승인자는 작성/리컨실 담당자와 다른 운영 계정을 기본으로 한다. 테스트에서도 두 SUPER_ADMIN fixture를 사용한다.

## 8. 마이그레이션·복구

- additive optional 필드/신규 테이블부터 배포한다. read fallback을 구현하고 기존 fixture와 새 fixture 모두 테스트한다.
- 백필은 cursor·dry-run·진행 카운터를 제공한다. 큰 월 전체를 한 mutation에서 collect/재계산하지 않는다.
- 기존 승인 없는 대기 실게시 잡은 자동 승인하지 않는다. 새 승인으로 이동시키되 payload hash를 보존한다.
- R1 진입 전 잠시 발행 pause → 실행 중 완료 확인 → quota/attempt migration → resume. 불명확한 RUNNING은 수동 확인 큐.
- 결과 재전송 journal은 원자적 파일 교체로 저장. 시작 시 flush하며 실행을 다시 하지 않는다. 토큰/쿠키/민감 KYC는 journal에 저장하지 않는다.
- 배포 롤백은 새 데이터 삭제가 아니라 feature gate off와 이전 호환 reader로 수행한다. 원장/정산 기록을 자동 삭제하는 down migration은 제공하지 않는다.

## 9. 출시 검증 게이트

R0: 전체 단위/타입/빌드, F01~F10 회귀, 3개 기존 E2E, 신규 CSV→주문→정산 E2E, Mock·dryRun의 실적 제외를 통과해야 한다. 린트 기준선의 기존/신규 오류를 구분하고 신규 오류 0.

R1: 파트너 샘플 월 0원 오차, 지급 snapshot 대조, 역할별 데이터 누출 0, 승인 없는 게시 0, 동일 root 작업의 의도치 않은 중복 게시 0. 검증된 채널별 3개 스페이스를 합쳐 7일 운영하고 성공/실패/건너뜀/미확인 모두 증거 기록. 7일을 단시간 테스트로 대체하지 않는다.

제안 초기 성능 목표: 합성 10,000주문·1,000예약 데이터에서 목록 첫 페이지 p95 1초 이내, 예약 생성 지연 p95 6분 이내(현 5분 tick 기준), 데스크톱 온라인 시 실행 가능한 잡 claim p95 10초 이내. 외부 승인 대기·rate limit은 별도 측정하며 성공률에서 숨기지 않는다. 측정 환경/표본을 보고하고 운영 SLA로 확정하지 않는다.

R2: 실제 연동 증거, 배포 환경별 모드/시크릿 검증, 서명/업데이트/복원 실습, 사고 대응 연락처와 운영 runbook 완료. 외부 입력이 없으면 해당 gate는 BLOCKED_EXTERNAL로 남기고 R0 구현은 계속한다.

## 10. 외부 입력 목록

| 입력 | 담당 | 개발 중 기본 처리 | 막는 단계 |
|---|---|---|---|
| 파트너 원천 샘플/링크 풀·부분환불 규격 | 아뜨랑스 담당 | 합성 fixture/엄격한 importer, 미확정 이벤트 격리 | R1 실주문 |
| 요율·그레이드·반품 확정일·지급 파일 | 운영+파트너 | 테스트 전용 설정, 운영값 미설정 오류 | R1 정산 |
| Meta 앱/테스터·승인 | 운영 | Mock 통합·contract tests | 해당 채널 실 API |
| 테스트 SNS 계정·게시 허용 콘텐츠 | 운영 | fixture/dryRun | 실계정 게시 |
| KYC 범위/키 공급자/보관 정책 | 운영+검토 담당 | 합성값, provider interface | 실 KYC |
| 서명 인증서·웹/Convex 배포 대상 | 운영 | 로컬 빌드·미배포 산출물 | R2 배포 |

위 항목은 요청할 때 구체적 샘플/필드를 전달한다. 존재하지 않는 계약값·운영 자격증명·테스트 성공을 만들어내지 않는다.
