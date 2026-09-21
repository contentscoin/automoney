# automoney 개발 진행 기록

기준 브랜치: `claude/automoney-marketing-program-iex5zv`  
시작 기준 HEAD: `2a7ef7ef76bf07ff8b883976421c359f93484f23`

## Wave A — 권한 및 데이터 경계

### DEV-01 — DONE

- 변경: `apps/web/convex/schedules.ts`, `apps/web/tests/agent.test.ts`
- 기존 예약을 수정할 때 대상 예약의 존재 여부와 `userId` 소유권을 새 space/piece 처리보다 먼저 확인한다.
- 타인 예약과 삭제된 예약은 모두 `NOT_FOUND`로 처리하여 존재 여부를 노출하지 않는다.
- 정지된 사용자는 `requireUser` 단계에서 거절되며 기존 예약은 변경되지 않는다.
- 회귀 증거: 타인 예약 ID 수정, 삭제된 ID 수정, 정지 사용자 수정 및 원본 불변 검증.

### DEV-02 — DONE

- 변경: `apps/web/convex/settlements.ts`, 총판 정산 UI, 정산 명세 UI, `apps/web/tests/settlements.test.ts`
- 총판 월 응답에서 `adminMarginDirect`를 제거하여 총차액과 직접차액의 동시 반환을 차단했다.
- 총판 자신의 ADMIN 정산 목록에서 `entryCount`를 제거했다.
- 총판 자신의 ADMIN 명세서는 주문별 행·주문번호·직간접 구분·기준금액·요율을 반환하지 않고 월 합계 한 행만 반환한다.
- 하부 USER의 직접 수당 명세와 SUPER_ADMIN 전체 명세는 기존 기능을 유지한다.
- MCP `settlement_history`는 같은 역할별 정산 DTO를 사용하므로 총판 응답에도 동일한 차단이 적용된다.
- 회귀 증거: 총판 월 응답/목록/명세 JSON에 `indirect`, `entryCount`, `adminMarginDirect`, `attribution`, `attrangsOrderId`, `baseAmount`, `rateBps`가 없는지 검증.

## 검증 결과

- `corepack pnpm --filter @automoney/web exec vitest run tests/agent.test.ts tests/settlements.test.ts`: PASS, 17 tests
- `corepack pnpm test`: PASS
  - shared: 39 tests
  - web: 50 tests
  - desktop: 28 tests
- `corepack pnpm typecheck`: PASS
- `corepack pnpm --filter @automoney/web lint`: PASS with 기존 경고 6개 (`img` 3개, Meta 미사용 타입 3개), 오류 0개
- `corepack pnpm --filter @automoney/web build`: PASS, 31 routes
- 빌드 경고: Next.js의 `middleware` convention deprecation. 이번 변경과 무관하며 DEV-15에서 정리 대상.

## 호환성 및 마이그레이션

- 데이터 스키마 변경 없음. 마이그레이션 불필요.
- 기존 예약/정산 데이터 형식은 유지된다.
- 총판 클라이언트 응답 계약에서 `adminMarginDirect`와 ADMIN 정산의 `entryCount`가 제거되는 의도적 보안 변경이 있다.
- 데스크톱 에이전트 프로토콜 변경 없음.

## 다음 실행 단위

- DEV-03: 게시 승인 기본값, payload hash 결합, 변경 시 재승인, `pieceId` 전파, tenant별 멱등키.
- 이후 DEV-04 공통 preflight/quota 정책으로 연결한다.

## 2026-09-22 진행 갱신

### DEV-03 — DONE

- 게시 기본값을 승인 필요로 변경하고 승인에 canonical `payloadHash`를 결합했다.
- 동일 사용자의 같은 request key는 같은 payload만 재사용하며 다른 payload는 `IDEMPOTENCY_CONFLICT`; 다른 사용자의 같은 key는 독립 처리한다.
- 예약 revision과 `pieceId`의 예약→잡 payload 전파를 추가했다.
- 과거 `autoApprove` 누락은 승인 필요로 해석한다.

### DEV-04 — DOING

- agent protocol v2 attempt/lease 토큰과 `/preflight`를 추가했다.
- preflight가 사용자/space/취소/lease/승인 hash/승인 만료/예약 만료/일일 quota/15분 간격을 검사한다.
- `publishReservations`로 quota를 트랜잭션 예약하며 dryRun은 예약하지 않는다.
- Cloud Meta와 Desktop 모두 preflight를 통과해야 게시 경로로 진입한다.
- 남음: KST 자정 재예약과 동시 preflight 추가 회귀, 운영 feature gate 문서.

### DEV-05 — DOING

- claim에 protocolVersion/attemptNo/leaseToken을 추가하고 stale heartbeat/complete를 거절한다.
- completionId+canonical hash 재전송은 no-op, 다른 내용 재사용은 충돌 처리한다.
- 데스크톱은 실행 결과와 전달 실패를 분리하고 원자적 completion journal에서 재전송한다. journal에는 device/lease token을 저장하지 않는다.
- heartbeat 확인 실패를 삼키지 않고 게시 전 실행을 중지한다.
- 남음: 프로세스 재시작 journal 전용 회귀와 UNCERTAIN 세분화.

### DEV-06 — DOING

- Meta 계정에 명시적 `fallbackSpaceId`를 도입했다.
- 동일 사용자·동일 플랫폼·정상 브라우저 세션·동일 handle 검증을 통과한 스페이스만 지정할 수 있다.
- 기존 API space 자체를 암묵적으로 브라우저 폴백으로 사용하지 않는다.
- 남음: 스페이스 UI의 폴백 선택/복구 안내와 불명확 오류 무폴백 회귀.

### DEV-07 — DOING

- 주문 이벤트 payload hash, 적용 상태, 순서 메타를 추가했다.
- 같은 event id/다른 payload는 별도 충돌 원장에 격리하고 금액을 변경하지 않는다.
- source version/occurredAt 역순, terminal 상태 역행, 미확정 부분환불을 stale/quarantine 처리한다.
- 전체 snapshot 금액 변경은 기존 통계를 제거한 뒤 새 금액으로 다시 반영한다.
- 남음: 역순·금액변경·부분환불 골든 fixture 확대.

### DEV-10 — DOING

- KYC 업로드 intent 생성→storage 결합→동일 사용자 제출 시 1회 소비 흐름을 추가했다.
- 암호문을 `v1:keyId:iv.ciphertext` 형태로 쓰고 기존 `iv.ciphertext`도 읽는다.
- 남음: 타인/만료 intent 회귀, ADMIN 지급 시 KYC 재검사, 외부 KMS provider 구현은 공급자 선정 전 BLOCKED_EXTERNAL.

### DEV-11 — DOING

- 데스크톱 미디어 fetch에 HTTPS 강제, 로컬/사설망 DNS 차단, redirect 재검증/제한, timeout, MIME/20MB 검사를 추가했다.
- 남음: 네트워크 fixture 회귀와 콘텐츠 승인 버전 UI.

### DEV-15 — DOING

- Windows에서 동작하지 않던 음수 workspace filter를 제거하고 web/desktop 명시 빌드로 변경했다.

## 2026-09-22 2차 진행 갱신

- DEV-05: 성공 완료 응답 유실 journal 회귀를 추가했다. 핸들러 실행 1회, 같은 completion 재전송 2회째 성공, journal 제거를 검증했다.
- DEV-06: 명시적 폴백 지정 mutation과 동일 사용자/플랫폼/handle/정상 세션 검증을 추가했다. 불명확한 `META_PUBLISH_FAILED`에는 폴백하지 않고 reservation을 `UNCERTAIN`으로 유지한다.
- DEV-07: 동일 event id/다른 payload 충돌, 부분환불 격리, 환불 후 과거 paid 이벤트 비적용 회귀를 추가했다.
- DEV-08: `importBatches`, `importRows`, `partnerLinkPool`과 링크 풀 CSV preview/apply를 추가했다. 100행 cursor 재개, 같은 파일 no-op, 원자 배정, 풀 소진, 실제 모드 Mock fallback 금지를 검증했다. 상품·주문 importer 통합 UI는 계속 진행 중이다.
- DEV-09: 정산/확정 배치 revision·content hash·snapshot hash·승인 snapshot·지급 파일 hash를 추가했다. 지급 완료는 승인 snapshot과 지급 snapshot/hash가 일치하는 행만 허용한다.
- DEV-10: USER와 ADMIN 모두 마감·지급 시 KYC 승인을 요구한다. 타인/만료 upload intent와 legacy 암호문 회귀를 추가했다.
- DEV-11: HTTPS, DNS 사설망, redirect, timeout, MIME, 크기 검사를 구현하고 로컬 URL/MIME 차단 테스트를 추가했다. 비프로덕션 E2E fixture만 명시적 환경 변수로 사설 URL을 허용한다.
- DEV-14: completion/import journal은 원자 파일/100행 cursor로 재개 가능하며 로그의 device/lease/OAuth/KYC 패턴 redaction을 확대했다.
- DEV-15: Linux CI workflow를 추가하고 Next.js `middleware`를 `proxy` convention으로 이전했다. 루트 Windows build가 shared→web→desktop 순서로 통과한다.

### 최신 검증(2차)

- 전체 단위 테스트: PASS — shared 39, web 54, desktop 28 (이후 신규 desktop 회귀 포함 targeted 9 PASS).
- 전체 typecheck: PASS.
- 전체 lint: 오류 0, 기존 경고 6.
- 루트 build: PASS; Next.js 31 routes와 Desktop TypeScript/assets build.
- Next.js proxy 전환 후 web production build: PASS, middleware deprecation 경고 제거.

### 최신 검증

- `corepack pnpm test`: PASS — shared 39, web 51, desktop 28.
- 변경 관련 web/desktop typecheck: PASS.

## 2026-09-22 최종 감사

- DEV-01~DEV-15의 R0 구현 상태를 모두 `DONE`으로 감사했다. 상세 근거와 외부 gate는 `automoney-final-development-report.md`에 기록했다.
- 스케줄의 `lastSkipReason`/`lastSkippedAt`을 실제 tick에서 기록하고, 정상 실행 시 해제하도록 완료했다.
- Meta 연결 화면에서 검증 가능한 동일 계정 브라우저 스페이스를 명시적으로 선택하도록 완료했다.
- 상품·링크 풀·주문 import UI와 100행 cursor apply, 정산 hash chain, KYC upload intent, protocol v2 completion journal을 통합 확인했다.
- 배포·CSV·장애·롤백·복원 절차를 `automoney-release-runbook.md`로 작성했다.

### 최종 로컬 증거

- 단위/계약 테스트: shared 39 + web 55 + desktop 31 = **125 PASS**.
- 타입 검사: web 앱/tests, shared, desktop **PASS**.
- ESLint: **0 errors**, 기존 경고 6.
- 프로덕션 빌드: shared/desktop 및 Next.js 31 pages **PASS**.
- 실제 파트너·SNS·Meta·KMS·서명/배포 증거는 입력 미제공으로 `BLOCKED_EXTERNAL`; R0 코드 완료와 분리했다.
