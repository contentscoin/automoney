# automoney 배포·복구 runbook

작성일: 2026-09-22  
적용 대상: R0 개발 검증 이후 제한 베타 배포

## 1. 배포 전 확인

1. `ATTRANGS_MODE`, Meta mock/graph 모드, `SITE_URL`, Convex 대상이 배포 환경과 일치하는지 확인한다.
2. 운영 요율·파트너 CSV·링크 풀을 테스트 fixture와 분리하고, 실제 값이 미확정이면 발급·정산 기능을 활성화하지 않는다.
3. KYC 암호화 키와 key id를 별도 비밀 저장소에서 주입한다. 로그나 `.env` 예시에 실제 키를 남기지 않는다.
4. 웹 단위 테스트 55개, shared 39개, desktop 31개와 타입 검사·린트·빌드가 통과한 커밋만 배포한다.
5. 실행 중인 발행 잡을 확인하고 신규 발행을 일시 정지한다. `RUNNING` 또는 `UNCERTAIN` 잡은 자동 재실행하지 않는다.

## 2. 스키마 및 애플리케이션 배포 순서

1. optional 필드와 신규 테이블을 포함한 Convex 스키마/함수를 먼저 배포한다.
2. 기존 데이터는 fallback reader로 계속 읽는다. 기존 승인 정보가 없는 잡은 승인 필요로 취급한다.
3. 웹을 배포하고 상품·링크 풀·주문 CSV를 각각 preview만 실행해 오류 건수를 확인한다.
4. protocol v2 데스크톱 에이전트를 배포한다. claim 응답의 attempt/lease token, preflight, completion journal 동작을 확인한다.
5. 테스트 스페이스 한 개에서 dry-run 후 실제 승인 게시 한 건을 실행한다. quota reservation이 `COMMITTED`가 되는지 확인한다.
6. 발행 정지를 해제한다. v1 에이전트 실게시 차단 gate는 v2 보급 확인 후 켠다.

## 3. CSV 및 정산 운영

- 모든 import는 `preview → apply` 순서로 수행한다. 실패 시 같은 batch cursor에서 재개하며 원본을 편집해 같은 batch로 속이지 않는다.
- 동일 content hash 파일은 no-op이어야 한다. 다른 내용에 같은 event id가 있으면 충돌 원장에서 확인한다.
- 정산은 마감 snapshot hash → 승인 snapshot hash → 지급 파일 hash 순서가 모두 일치해야 한다.
- 1원 차이, 누락 주문, 최신 revision 불일치, USER/ADMIN KYC 미승인은 지급을 중지한다.
- 이미 지급된 월의 환불은 과거 지급 행을 수정하지 않고 후속 조정으로 처리한다.

## 4. 장애 대응

| 상황 | 즉시 조치 | 금지 사항 |
|---|---|---|
| 게시 결과 불명확 | 잡과 reservation을 `UNCERTAIN`으로 유지하고 SNS에서 수동 확인 | 자동 retry, Meta→브라우저 fallback |
| 완료 API 일시 실패 | 데스크톱 completion journal 재전송 대기 | 게시 handler 재실행 |
| lease/preflight 실패 | 게시 전 중단, 계정·space·승인·quota 원인 확인 | 토큰 없이 complete 강제 호출 |
| CSV 중간 실패 | batch cursor와 실패 row를 확인해 재개 | 전체 데이터를 임의 재삽입 |
| KYC 키 오류 | 지급 중지, key id와 legacy decoder 확인 | 평문 출력·로그 기록 |
| 링크 풀 소진 | 실제 풀 추가 import 후 재시도 | mock 링크 자동 생성 |

## 5. 롤백과 복원

- 기능 gate를 끄고 이전 호환 reader로 롤백한다. 신규 원장·주문 이벤트·정산·감사 기록은 삭제하지 않는다.
- 배포 직전 Convex backup 식별자, 웹 커밋, 데스크톱 버전을 기록한다.
- 파일 journal은 원자적 rename으로 보존된다. 손상 시 별도 보관하고 서버의 잡 상태와 SNS 실제 게시 상태를 먼저 대조한다.
- 복원 훈련은 합성 데이터 환경에서 `backup → import → 주문 반영 → 정산 snapshot 비교`까지 수행한다.
- 실제 운영 복원과 서명 앱 롤백은 배포 대상·인증서가 제공된 뒤 R2 증거로 남긴다.

## 6. 출시 후 관찰

- 매일 실패/불명확 게시, quota skip, 만료 승인, import 실패 row, 지급 보류를 확인한다.
- 제한 베타는 검증된 스페이스 합계 3개 이상을 7일간 관찰한다. 성공뿐 아니라 실패·skip·uncertain을 모두 기록한다.
- 실제 파트너 월 정산은 원천 파일과 0원 오차를 확인한 뒤에만 R1 통과로 판정한다.

