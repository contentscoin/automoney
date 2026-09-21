# Sol 구현 백로그와 수락 테스트

기준 명세: automoney-development-spec-v1.md. 모든 작업은 실제 파일 재확인→실패 재현→최소 변경→회귀 검증→결과 기록 순서. 아래 변경 파일은 시작 지점이며 필요하면 인접 테스트/UI/생성 타입을 함께 수정한다.

| ID | 우선 | 선행 | 구현 범위/주요 파일 | 수락 조건 |
|---|---|---|---|---|
| DEV-01 | P0 | 없음 | schedules.ts, lib/rbac.ts, schedules/agent tests | A가 자기 space와 B의 schedule id로 수정하면 NOT_FOUND, B 데이터 불변. 중지 사용자/삭제 대상도 거절 |
| DEV-02 | P0 | 없음 | settlements.ts, dashboard.ts, lib/mcpTools.ts, telegram.ts, 역할별 DTO | USER/ADMIN 명세·통계·내보내기에 간접행/건수/분해금액 없음. ADMIN 총액은 정확하며 직접차액과 동시 반환하지 않음 |
| DEV-03 | P0 | DEV-01 | jobs.ts, shared/jobs.ts, schedules.ts, Telegram/MCP, 작업 UI | 기본 승인 true, payloadHash 결합, 변경 시 재승인. pieceId가 예약→작업→metrics 유지. tenant별 requestKey 멱등 |
| DEV-04 | P0 | DEV-03 | schema.ts, agent.ts, meta.ts, common publish policy | 모든 source/executor가 preflight 사용. 동시 claim·KST 자정·취소·일일 한도·15분 간격·2시간 만료 검증 |
| DEV-05 | P0 | DEV-04 | desktop agent api/loop/handlers, agent.ts, jobs.sweep | 성공 응답 유실 후 재전송은 성공 1건·metrics 1건. 구 attempt 거절. preflight 연결 실패 시 클릭 0. UNCERTAIN 자동 재실행 0 |
| DEV-06 | P0 | DEV-05 | meta.ts, spaces UI, schema.ts | 명시 fallbackSpaceId, 동일 사용자/계정 검증. 불명확한 API 완료는 폴백 금지, 확정 미발행 오류만 승인/hash 유지하며 전환 |
| DEV-07 | P0 | 없음 | orders.ts, shared/attrangs.ts, stats/commission engine | 중복/역순/동시 이벤트/금액 변경 fixture 통과. 격리 이벤트는 통계·분배 미변경. 부분환불 미지원은 명확히 격리 |
| DEV-08 | P0 | DEV-07 | 신규 imports service/UI, products/links/attrangs adapter | 상품·링크 풀·주문 미리보기/apply/재개. 파일 재적용 no-op. 풀 소진 오류. 실제 모드에서 Mock fallback 0 |
| DEV-09 | P0 | DEV-02,07,08 | settlements.ts, commissionEngine.ts, payout/statement UI | 0원 reconcile·KYC 이월·지급 후 환불·확정 후 변경·중복 마감 골든셋. batch revision과 승인/파일/지급 hash 일치 |
| DEV-10 | P0 | 없음 | kyc.ts, crypto.ts, schema.ts, KYC UI | 타인 storage id 거절, 인증 다운로드, legacy 암호문 호환, keyId roundtrip, 로그 평문 없음. USER/ADMIN 지급 KYC 재검사 |
| DEV-11 | P1 | DEV-03,05 | content.ts, magazines.ts, desktop handlers, fetch adapter | 템플릿 표시, 품질 차단, 미디어 MIME/크기/timeout/redirect 검사, 로컬/사설망 URL 거절, 승인된 내용 일치 |
| DEV-12 | P1 | DEV-05,06,11 | recipes/*, autopilot/*, updater.ts, tests | 픽스처 5채널 + 취소/실패 테스트. 실제 채널별 증거 표는 별도 작성, 캡차/제한이면 사람 조치로 종료 |
| DEV-13 | P1 | DEV-02,03,07 | oauth.ts, mcp.ts, Telegram, contract tests | 기존 OAuth/21툴 유지. 토큰 회전·재사용·스코프 축소·위험툴 확인·역할 강등 테스트. 단순 write 반환을 전부 job으로 바꾸지 않음 |
| DEV-14 | P1 | DEV-09,10 | cron, aggregate/pagination, audit/logger, 운영 UI | 100행 처리·cursor 재개, 비밀 로그 없음, 실패/미확인 작업 알림 중복 방지, 합성 부하 측정 |
| DEV-15 | P1 | DEV-01~14 | CI, scripts/e2e-*, package.json, docs | 3 E2E+정산 CSV 흐름 자동화, Windows 빌드 재현, 모드 검사, 마이그레이션/복원 runbook, release evidence |

## 권장 구현 묶음

1. Wave A: DEV-01, DEV-02. 첫 번째 검토 단위: 소유권과 역할별 데이터 경계 수정.
2. Wave B: DEV-03→04→05→06. 두 번째 검토 단위: 승인·quota·lease·완료 재전송·폴백.
3. Wave C: DEV-07→08→09와 DEV-10. 세 번째 검토 단위: 실제 CSV로 운영 가능한 정산·KYC.
4. Wave D: DEV-11→12, DEV-13→14→15. 네 번째 검토 단위: 통합·운영 검증과 제한 베타 준비.

DEV-10의 외부 KMS 선택은 인터페이스 이후 보류 가능하다. DEV-12 실계정 검증과 DEV-15 실제 배포는 외부 입력에 의존하므로 Mock 성공과 별도 기록한다. 날짜/공수는 확정하지 않으며 각 Wave의 실제 난이도와 결과로 갱신한다.

## 회귀 테스트 시나리오 목록

| 테스트 ID | Given / When | Then |
|---|---|---|
| AUTH-01 | A와 B의 예약, A가 B id로 변경 | 거절 및 B 상태 불변 |
| AUTH-02 | 총판 직접/간접 수익을 가진 fixture | 총판 응답에 분해값 없어 간접값 차감 추론 불가 |
| PUB-01 | 기본 옵션으로 WEB/MCP/Telegram 게시 요청 | 동일 승인 기본값, 확인되지 않은 실행 0 |
| PUB-02 | 승인 후 본문 또는 미디어 교체 | 기존 승인 무효 |
| PUB-03 | 하루 마지막 quota 1개, 2 실행 동시 preflight | 예약 1개만 허용 |
| PUB-04 | 23:59 예약 후 자정 지나 실행 | 실제 발행일 quota 재확인 |
| PUB-05 | 게시 성공 후 complete 응답 유실·프로세스 재시작 | journal 재전송, 게시 호출 총 1회 |
| PUB-06 | lease 회수 후 늦은 heartbeat/complete | 이전 attempt 거절, 새 상태 불변 |
| PUB-07 | 발행 직전 서버 연결 끊김 | 게시 클릭/API publish 0회 |
| PUB-08 | Meta publish timeout 후 결과 불명확 | fallback 생성 0, 확인 필요 |
| PUB-09 | 승인 만료/계정 중지/space 제한/예약 만료 | 실행 차단 및 설명 가능한 오류 |
| ORD-01 | 같은 event_id 같은/다른 hash 재전송 | 각각 no-op / 격리 |
| ORD-02 | 환불 후 과거 paid 도착 | 원장 기록만, 실적 재부활 없음 |
| ORD-03 | 순금액 변경·부분환불 미확정 규격 | 지원된 snapshot만 조정, 불명확 데이터 격리 |
| SET-01 | 3단계 합성 35,000원, 500/800/1,200bps | 1,750+1,050+1,400=4,200 |
| SET-02 | KYC 보류 후 승인, 다음 마감 | 누락·중복 없이 이월 반영 |
| SET-03 | 지급 후 환불 및 같은 이벤트 반복 | 후속 조정 1회, 과거 지급액 고정 |
| SET-04 | 1원 diff/누락 주문/최신 revision 불일치 | 확정·지급 차단 |
| SET-05 | 큰 CSV 중간 실패 후 재개·재업로드 | 같은 최종 원장/hash, 중복 0 |
| KYC-01 | 타인 storageId, 만료 intent, 위조 type | 제출/열람 거절 |
| KYC-02 | legacy/new keyId 데이터 섞임 | 호환 읽기, 새 쓰기 버전 적용, 실패시 평문 미노출 |
| INT-01 | 기존 OAuth refresh token 재사용/역할 강등 | 기존 권한 재사용 불가 |
| INT-02 | 승인된 콘텐츠 예약과 dryRun | 실게시만 1회 metrics, pieceId 유지 |

## 작업별 결과 기록 양식

각 DEV의 상태는 TODO / DOING / DONE / BLOCKED_EXTERNAL. DONE은 변경 파일, 재현 테스트, 실제 실행 명령·결과, 호환성/마이그레이션 확인이 있어야 한다. 미실행 테스트는 NOT_RUN과 이유를 쓴다. 기존 테스트 숫자를 현재 결과로 복사하지 않는다. 로컬 완료와 R1/R2 승인 상태를 분리한다.
