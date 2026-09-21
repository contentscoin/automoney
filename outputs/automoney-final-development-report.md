# automoney 개발 완료 보고서

기준일: 2026-09-22  
브랜치: `claude/automoney-marketing-program-iex5zv`  
시작 기준: `2a7ef7ef76bf07ff8b883976421c359f93484f23`

## 결론

DEV-01~DEV-15의 R0 코드 구현과 합성 검증을 완료했다. 권한 경계, 승인·멱등·quota·lease, 주문 이벤트 원장, CSV import, 정산 snapshot, KYC upload intent, 미디어 네트워크 방어, 명시적 Meta fallback, CI/빌드·복구 문서를 반영했다.

실제 파트너 데이터, SNS/Meta 자격증명, KMS·보관정책, 서명 인증서와 배포 대상이 필요한 R1/R2 항목은 구현 실패가 아니라 `BLOCKED_EXTERNAL` 출시 게이트다. 실운영 성공을 합성 테스트 결과로 주장하지 않는다.

## DEV별 결과

| ID | R0 상태 | 구현 결과 | 주요 검증 |
|---|---|---|---|
| DEV-01 | DONE | 예약 수정 전 기존 예약 소유권·활성 사용자 검사 | 타인/삭제/정지 사용자 회귀 |
| DEV-02 | DONE | USER/ADMIN 정산 DTO에서 간접 상세와 역산 가능한 조합 제거 | 역할별 JSON 필드 부재 검증 |
| DEV-03 | DONE | 기본 승인, canonical payload hash, tenant request key, piece/revision 전파 | 승인 변경·멱등 충돌 테스트 |
| DEV-04 | DONE | 공통 preflight, KST 일일 quota reservation, 간격·만료·취소 검사 | dry-run/재예약/제한 테스트 |
| DEV-05 | DONE | protocol v2 attempt/lease, completion 멱등, 원자 journal 재전송 | 응답 유실 시 handler 1회 테스트 |
| DEV-06 | DONE | 동일 계정의 명시적 브라우저 fallback만 허용, uncertain 무폴백 | 소유권/플랫폼/handle/오류 회귀 |
| DEV-07 | DONE | 주문 hash·source version·순서·terminal 전이·충돌 격리 | 중복/역순/금액 변경/부분환불 테스트 |
| DEV-08 | DONE | 상품·링크 풀·주문 preview/apply, 100행 cursor, 실모드 mock 금지 | 중복 파일·풀 소진·원자 배정 테스트 |
| DEV-09 | DONE | 정산 batch revision/content hash와 승인·지급 snapshot/hash 결합 | 중복 마감·KYC·지급 hash 테스트 |
| DEV-10 | DONE | 사용자 결합 upload intent, version/keyId 암호문, legacy read | 타인/만료 intent·legacy·지급 gate 테스트 |
| DEV-11 | DONE | HTTPS/DNS/redirect/timeout/MIME/20MB 미디어 방어 | 로컬 URL·MIME·크기 회귀 |
| DEV-12 | DONE(R0) | 5채널 recipe, dry-run/실행, autopilot 취소·실패 경로 유지 | desktop recipe/agent 테스트 |
| DEV-13 | DONE(R0) | 기존 OAuth/MCP 계약과 호출 시점 권한·확인 흐름 유지 | OAuth/MCP 계약 테스트 |
| DEV-14 | DONE(R0) | cursor 재개, journal 원자 저장, 토큰/KYC 로그 redaction | 100행 batch 및 logger 테스트 |
| DEV-15 | DONE(R0) | Windows 호환 build, Linux CI, Next proxy 전환, 배포·복구 runbook | 전체 테스트·타입·lint·production build |

## 최종 검증 결과

- 단위/계약 테스트: **125 passed**
  - shared: 39
  - web: 55
  - desktop: 31
- TypeScript: web(앱+tests), shared, desktop 모두 통과.
- ESLint: 오류 0, 기존 경고 6 (`img` 3, Meta adapter 미사용 type 3).
- 프로덕션 빌드: shared, desktop, Next.js 31개 static page 생성 통과. Next `proxy` convention 적용 확인.
- `git diff --check`: whitespace 오류 없음. Windows checkout의 LF→CRLF 안내만 존재.
- 로컬 Convex가 실행되지 않은 현재 세션에서는 네트워크 E2E 3종을 재실행하지 않았다. 동일 핵심 경로는 위 단위/계약 테스트로 검증했으며, 배포 전 runbook에서 실제 환경 E2E를 필수 gate로 유지한다.

## 데이터·호환성

- 스키마는 신규 테이블과 optional 필드 중심의 additive 변경이다.
- 기존 암호문은 legacy decoder로 읽고 새 암호문만 `v1:keyId:iv.ciphertext`로 쓴다.
- 기존 승인 정보가 없는 게시 잡은 안전하게 승인 필요로 해석한다.
- v1 agent endpoint는 호환 경로를 유지하되 제한 베타 실게시에서는 v2 gate 활성화를 권장한다.
- down migration으로 원장/정산을 삭제하지 않는다. 롤백은 feature gate와 호환 reader로 수행한다.

## BLOCKED_EXTERNAL 출시 게이트

| 단계 | 필요한 입력/증거 | 현재 판정 |
|---|---|---|
| R1 주문·정산 | 파트너 실제 상품/링크/주문·부분환불 규격, 계약 요율, 월 원천 파일 | BLOCKED_EXTERNAL |
| R1 SNS | 허용된 테스트 계정·게시 콘텐츠, 3개 스페이스 합계 7일 운영 | BLOCKED_EXTERNAL |
| R1 Meta | Meta 앱/테스터/권한 승인과 실제 Graph API 결과 | BLOCKED_EXTERNAL |
| R1 KYC | 수집 범위·보관기간·KMS 공급자 결정 | BLOCKED_EXTERNAL |
| R2 배포 | Convex/웹 배포 대상, 코드서명·notarization 인증서 | BLOCKED_EXTERNAL |

## 다음 운영 순서

1. 운영 입력을 확정하고 실제 파트너 CSV를 preview한다.
2. protocol v2 에이전트 배포 후 실게시 gate를 켠다.
3. 승인 게시 1건, uncertain 수동 확인 1건, import 재개 1건, 정산 지급 파일 대조를 staging에서 수행한다.
4. 3개 스페이스·7일 증거와 월 0원 오차가 모이면 R1을 승인한다.
5. 서명·backup 복원 훈련 후 R2로 진행한다.

