# automoney 배포·복구 runbook

작성일: 2026-09-22  
적용 대상: R0 개발 검증 이후 제한 베타 배포

## 1. 배포 전 확인

1. `ATTRANGS_MODE`, Meta mock/graph 모드, Convex 대상이 배포 환경과 일치하는지 확인한다. `SITE_URL`은 브라우저와 SNS에서 접근 가능한 공개 HTTPS origin이어야 하며 localhost·HTTP·사설 IP를 사용하지 않는다. 운영 live Meta 게시에는 `META_MODE=graph`와 실제 앱 자격증명이 모두 필요하며 mock 계정은 테스트 harness 외 실게시에서 차단된다. `LIVE_PUBLISH_ENABLED`의 기본값은 off이므로 검증 전과 승인된 실게시 시간 외에는 미설정 또는 `false`로 둔다.
2. 운영 요율·파트너 CSV·링크 풀을 테스트 fixture와 분리하고, 실제 값이 미확정이면 발급·정산 기능을 활성화하지 않는다.
3. KYC 암호화 키와 key id를 별도 비밀 저장소에서 주입한다. 로그나 `.env` 예시에 실제 키를 남기지 않는다.
4. 고정된 테스트 개수를 합격 기준으로 쓰지 않는다. 저장소 루트에서 아래 명령이 모두 성공한 커밋만 배포한다.

   ```bash
   pnpm typecheck
   pnpm test
   pnpm lint
   pnpm build
   ```

   테스트 추가·삭제 후에도 같은 명령 기준을 유지하고, CI 결과 링크와 커밋 SHA를 배포 기록에 남긴다.
5. 실행 중인 발행 잡을 확인하고 신규 발행을 일시 정지한다. `RUNNING` 잡이나 `publishPhase`/reservation이 `UNCERTAIN`인 잡은 자동 재실행하지 않는다.

## 2. 스키마 및 애플리케이션 배포 순서

> **운영 환경 전환 완료(2026-09-26)**: 공개 웹과 데스크톱 0.1.15의 기본값은 정식 production `resilient-cheetah-311`을 가리킨다. 데스크톱 0.1.15는 기존 설치에 저장된 구 공개 주소도 자동으로 production으로 승격하므로 재설치 후 페어링 코드가 다른 환경으로 전송되지 않는다. 기존 공개 대상 `wry-ermine-412`와 production의 사전 snapshot을 각각 보관한 뒤 인증·암호화 환경변수를 hash 대조해 복제하고, 987개 문서를 `--replace-all` snapshot import로 이관했다. 이관 후 production snapshot의 모든 테이블 문서 수가 원본과 일치함을 확인했으며 `LIVE_PUBLISH_ENABLED=false`를 명시했다. 백업 위치는 로컬 `Documents/Codex/automoney-backups/20260926-113226`이고 Convex Dashboard snapshot도 양쪽 배포에 남아 있다.

1. optional 필드, sweep용 복합 인덱스, `contentReviewEvents`를 포함한 Convex 스키마/함수를 먼저 배포한다. 인덱스 backfill과 함수 배포가 끝난 뒤 웹·데스크톱을 진행한다.
2. 기존 데이터는 fallback reader로 계속 읽되, `runId`가 없고 `generatedBy !== manual`인 이전 자동 생성물은 게시·공유·복사하지 않는다. 현재 품질 계약으로 새로 생성해야 하며 수퍼어드민 우회도 허용하지 않는다.
3. 웹을 배포하고 상품·링크 풀·주문 CSV를 각각 preview만 실행해 오류 건수를 확인한다.
4. protocol v2 데스크톱 에이전트 0.1.13 이상을 배포하고 `MIN_DESKTOP_VERSION=0.1.13` 이상으로 설정한다. 0.1.12 이하가 live `post.publish`를 claim하지 못하는지, claim 응답의 attempt/lease token, fenced completion journal, JIT preflight·직전 재검증·게시 시도 marker와 콘텐츠 결과의 engine·model·`cliVersion` 저장을 확인한다.
5. `LIVE_PUBLISH_ENABLED`를 미설정 또는 `false`로 유지한 채 테스트 스페이스에서 payload `dryRun=true` 작업을 실행한다. recipe와 autopilot의 click·키보드 submit이 0회인지, 외부 게시물과 canonical receipt가 생기지 않는지, capability 응답의 `livePublish=false`인지 확인한다. 로컬 `AUTOMONEY_DRY_RUN=1`로 live payload를 보내면 가짜 성공이 아니라 `LOCAL_DRY_RUN_OVERRIDE`로 중단돼야 한다.
6. 승인된 변경 시간에만 `LIVE_PUBLISH_ENABLED=true`로 설정하고 실제 승인 게시 한 건을 실행한다. 저장된 space handle과 현재 session handle이 일치하고, 브라우저 submit/Meta API 호출 직전 원자적 게시 시도 승인이 사용자·콘텐츠·링크·예약 revision·계정·quota를 다시 통과하며 `publishAttemptedAt`이 정확히 한 번 기록되는지 확인한다. 새 canonical receipt가 대상 플랫폼·계정과 일치하고 quota reservation은 receipt 검증 뒤에만 `COMMITTED`여야 한다.
7. 기본 운영값은 계속 off로 유지한다. 승인된 실게시 시간 또는 별도로 승인된 상시 운영 환경에서만 정확히 `true`를 사용하고, 승인 범위가 끝나면 `false`로 되돌린다. 미설정·`false`·인식되지 않는 값은 fail-closed이며 dry-run만 허용된다. 구현은 `1`·`yes`·`on`도 활성값으로 인식하지만 운영 설정에는 사용하지 않는다.

## 3. 콘텐츠 승인·미디어·provenance 게이트

- 제작 run 콘텐츠는 `DRAFT` 상태이며 승인 화면이 읽은 `expectedOutputHash`와 서버가 다시 계산한 현재 `outputHash`가 같아야 한다. stale 화면과 이미 승인·폐기된 상태에서의 승인은 차단한다. 폐기 결과는 수정으로 새 revision을 만든 뒤에만 다시 검토한다.
- 승인자는 상품 사실(`productFacts`), 광고 표기(`adDisclosure`), 미디어 권리·채널 적합성(`mediaRightsAndFit`), 최종 문구(`finalCopy`)의 네 체크리스트를 모두 확인해야 한다. 하나라도 false이거나 누락되면 승인하지 않는다.
- 승인마다 actor·시각·`outputHash`·체크리스트·당시 본문/해시태그/대본/미디어/점수를 새 `contentReviewEvents` 행으로 기록한다. 이 event와 기존 snapshot은 수정·삭제하지 않고 정정 시 새 revision/event를 추가한다.
- Instagram Reels와 TikTok은 검증 가능한 HTTPS 동영상 URL이 정확히 1개 필요하다. 현재 파이프라인은 대본만 자동 생성하므로 운영자가 카드 수정 화면에서 정적 이미지를 제거하고 `.mp4`, `.mov`, `.m4v`, `.webm` URL 1개로 수동 교체한 뒤 재검토·재승인한다.
- 각 생성 결과의 provider·engine·model·Codex CLI 버전(`cliVersion`)·데스크톱 버전·attempt·입출력 hash를 배포 증거에 포함한다. 확인 불가능한 model/CLI 값은 추정하지 않고 `null`과 해당 데스크톱 로그를 함께 남긴다.
- 이전 품질 계약의 자동 생성물은 참고·감사용으로만 보존한다. 현행 run, frozen standard, output hash, review event를 갖춘 새 결과로 교체하기 전에는 운영 게시에 사용하지 않는다.
- 승인된 공유 콘텐츠를 내 콘텐츠로 복사하면 `evidenceRunId`와 `copiedFromPieceId` 계보만 이어지고 상태는 `PRIVATE`·`DRAFT`가 된다. 원본 승인자·시각·체크리스트를 상속하지 않으며, 복사본의 현재 output hash로 네 체크리스트를 다시 완료해 새 review event를 만든 뒤에만 공유·게시한다.
- 공유 중인 콘텐츠는 수동 작성본도 편집 즉시 `PRIVATE`로 전환한다. 새 revision 승인과 수퍼어드민 재공유 전에는 타 tenant가 볼 수 없어야 한다. 즉시 게시·예약 모두 canonical 본문·미디어와 output/snapshot hash를 결합하고, override가 있는 요청은 거부해 `pieceId` 성과 귀속 오염을 막는다.

## 4. 게시·MCP·Telegram 안전 게이트

- 브라우저 게시 전 저장된 space handle과 현재 session handle을 정규화해 둘 다 존재하고 일치하는지 확인한다. Meta API와 브라우저 fallback 등 같은 실제 계정의 별칭은 하나의 publication identity와 일일 reservation을 사용해야 한다.
- 브라우저 전용 X·TikTok·Naver는 provider-signed stable account ID가 없어 publication key가 `tenant + handle` 범위다. 같은 실제 외부 계정을 여러 Automoney 테넌트에 연결하면 전역 중복 차단을 보장하지 못하므로 현재 운영에서는 한 테넌트에만 연결한다. 단순 전역 handle key는 handle 사칭에 의한 게시 잠금 DoS를 만들 수 있어 사용하지 않는다. 외부 계정 소유권 registry 또는 서명된 stable ID 수집을 도입하기 전까지 이를 잔존 위험으로 릴리스 기록에 남긴다.
- handler 시작 preflight는 준비 단계 검사일 뿐 최종 승인이 아니다. 실제 submit click 또는 Meta API publish 호출 직전 단일 서버 mutation이 live switch, 승인 hash/TTL, 사용자·space, 콘텐츠/review, 링크, 예약 revision, 계정 identity, lease와 reservation을 다시 검사하고 게시 시도 marker를 원자적으로 기록한다. marker 이후 같은 attempt의 재-preflight와 두 번째 top-level submit은 거부한다. Naver처럼 한 게시 시도 안에 확인 버튼이 한 번 더 필요한 경우에는 새 marker를 만들지 않는 `/publish-continuation`이 동일 marker·lease·취소·live switch·승인·계정·콘텐츠·링크·예약·reservation을 최종 버튼 직전에 다시 확인한다.
- live 성공은 submit 직전 baseline 이후 짧은 검증 시간 안에 새로 나타난 대상 플랫폼 canonical post URL로만 인정한다. URL에 계정 handle이 있는 플랫폼은 선택 계정과도 일치해야 한다. 모델의 `done`, 모델이 제시한 URL, 기존 DOM 링크, canonical receipt가 없는 completion은 성공 증거가 아니다.
- Meta→브라우저 fallback은 원 작업의 승인 요구를 상속하되 기존 승인을 재사용하지 않는다. 승인 대기 fallback 알림이 발송되는지 확인한다. 원 작업 취소는 이미 생긴 active fallback까지 전파하고 root 취소 표식을 남기며, fallback의 JIT 게이트도 이 표식을 확인해야 한다.
- MCP `post_publish`·`post_schedule`은 먼저 확인 미리보기를 받고, 실제 확정 호출에 `confirmed=true`와 8~100자의 새 `clientRequestId`를 함께 보낸다. 네트워크 재시도는 같은 payload와 같은 키를 사용하고, 다른 payload에 키를 재사용하지 않는다.
- MCP 예약에서 `autoApprove=true`를 쓰려면 위험 작업 확인인 `confirmed=true`와 반복 무승인 게시 확인인 `confirmAutoApprove=true`가 모두 필요하다. 운영자가 두 의미를 각각 승인하지 않았다면 `autoApprove=false`를 유지한다.
- Telegram webhook endpoint에는 Bot API `secret_token`과 유효한 `update_id`가 모두 필요하다. 같은 `update_id`가 재전송돼도 `/post` 작업, 승인 callback, 감사 event, 봇 응답이 각각 한 번만 발생하는지 배포 후 확인한다.

## 5. CSV 및 정산 운영

- 모든 import는 `preview → apply` 순서로 수행한다. 실패 시 같은 batch cursor에서 재개하며 원본을 편집해 같은 batch로 속이지 않는다.
- 동일 content hash 파일은 no-op이어야 한다. 다른 내용에 같은 event id가 있으면 충돌 원장에서 확인한다.
- 정산은 마감 snapshot hash → 승인 snapshot hash → 지급 파일 hash 순서가 모두 일치해야 한다.
- 1원 차이, 누락 주문, 최신 revision 불일치, USER/ADMIN KYC 미승인은 지급을 중지한다.
- 이미 지급된 월의 환불은 과거 지급 행을 수정하지 않고 후속 조정으로 처리한다.

## 6. 장애 대응

| 상황 | 즉시 조치 | 금지 사항 |
|---|---|---|
| 게시 결과 불명확 | 잡은 terminal `FAILED`, `publishPhase`와 reservation은 `UNCERTAIN`으로 유지하고 SNS에서 수동 확인 후 작업 화면에서 `게시됨` 또는 `게시되지 않음`으로 조정. `게시되지 않음`은 안전 대기 종료 후 해제 확인 | 자동 retry, 확인 전 Meta→브라우저 fallback·동일 콘텐츠 재게시 |
| 완료 API 일시 실패 | 데스크톱 completion journal 재전송 대기 | 게시 handler 재실행 |
| lease/preflight 실패 | 게시 전 중단, 계정·space·승인·quota 원인 확인 | 토큰 없이 complete 강제 호출 |
| local dry-run override가 live 작업 차단 | 서버 작업을 `dryRun=true`로 새로 등록하거나 승인된 실게시 환경에서 로컬 override 제거 | live payload를 dry-run 성공으로 수동 완료 처리 |
| 비게시 실행 lease 3회 고갈 | `EXECUTION_RETRY_EXHAUSTED` terminal 실패와 연결 run 갱신 확인 후 원인 해결·새 실행 등록 | 기존 잡의 attempt 초기화·재큐잉 |
| 큐 24시간 대기 초과 | `DEVICE_OFFLINE_TIMEOUT` terminal 실패와 연결 run 갱신 확인, PC 연결 복구 후 새 실행 등록 | 오래된 payload를 임의로 QUEUED로 복원 |
| Reels·TikTok 미디어 차단 | HTTPS 동영상 URL 1개로 수동 교체하고 output hash 기준 재승인 | 정적 이미지 게시, URL 종류 검사 우회 |
| 이전 자동 생성물 차단 | 현행 제작 워크플로로 다시 생성·검토 | 수퍼어드민 권한으로 공유·복사·게시 우회 |
| CSV 중간 실패 | batch cursor와 실패 row를 확인해 재개 | 전체 데이터를 임의 재삽입 |
| KYC 키 오류 | 지급 중지, key id와 legacy decoder 확인 | 평문 출력·로그 기록 |
| 링크 풀 소진 | 실제 풀 추가 import 후 재시도 | mock 링크 자동 생성 |

`UNCERTAIN`은 실패 재시도 신호가 아니라 외부 결과를 알 수 없다는 terminal 운영 상태다. 담당자는 잡 ID·reservation·계정·예상 본문·preflight 시각을 기준으로 SNS에서 게시물을 직접 찾는다. 게시된 경우 `/dashboard/jobs`에서 canonical 게시 URL을 입력해 **게시됨**으로 조정한다. 서버는 reservation을 `COMMITTED`로 바꾸고 실적 수집을 시작하며 actor·시각·URL을 감사 기록에 남긴다. 게시물이 없음을 확인한 경우 **게시되지 않음**으로 조정하되, reservation은 원 intent 만료와 조정 후 15분 중 더 늦은 시각까지 `UNCERTAIN` 상태를 유지한다. 예약이 자동으로 `RELEASED`된 것을 확인한 뒤에만 새 payload와 새 승인의 작업을 만든다. terminal `FAILED` 잡 자체는 재큐잉하지 않으며, 조정 전에는 같은 콘텐츠의 신규 실게시를 금지한다.

## 7. 현재 제한과 live 출시 조건

- 승인·작업 payload는 미디어 URL 문자열을 고정하지만 원격 URL의 실제 파일 바이트는 아직 자사 저장소에 immutable snapshot으로 고정하지 않는다. 승인 후 원격 원본이 바뀌는 위험을 제거하려면 object storage 복사, MIME/크기 검사, content hash 저장, 게시 직전 hash 재검증이 필요하다.
- Instagram 브라우저 permalink 자체에는 계정 handle이 없으므로 성공 URL만으로 계정 귀속을 재검증할 수 없다. 현재는 submit 직전 session identity와 새 permalink baseline을 결합해 방어하며, provider-signed post owner 확인이 추가되기 전까지 제한 베타 범위로 운영한다.
- 위 미디어 고정 계층과 실제 계정 스모크 테스트가 완료되기 전 production 기본값은 `LIVE_PUBLISH_ENABLED=false`다. 웹/백엔드 배포와 dry-run 검증은 가능하지만 상시 live 기능은 출시하지 않는다.

## 8. 롤백과 복원

- 먼저 `LIVE_PUBLISH_ENABLED=false`로 바꾸고 기능 gate를 끈 뒤 이전 호환 reader로 롤백한다. 신규 원장·주문 이벤트·정산·`contentReviewEvents`를 포함한 감사 기록은 삭제하지 않는다.
- 배포 직전 Convex backup 식별자, 웹 커밋, 데스크톱 버전을 기록한다.
- 파일 journal은 원자적 rename으로 보존된다. 손상 시 별도 보관하고 서버의 잡 상태와 SNS 실제 게시 상태를 먼저 대조한다.
- 복원 훈련은 합성 데이터 환경에서 `backup → import → 주문 반영 → 정산 snapshot 비교`까지 수행한다.
- 실제 운영 복원과 서명 앱 롤백은 배포 대상·인증서가 제공된 뒤 R2 증거로 남긴다.

## 9. 출시 후 관찰

- 매일 실패/불명확 게시, `EXECUTION_RETRY_EXHAUSTED`, `DEVICE_OFFLINE_TIMEOUT`, quota skip, 만료 승인, legacy 격리 차단, import 실패 row, 지급 보류를 확인한다.
- 게시 표본에서 account identity, submit 직전 JIT preflight, canonical receipt, reservation 상태가 한 실행 계열로 연결되는지 확인한다. Telegram 원장에서 같은 `update_id`의 중복 처리나 중복 outbox가 없는지도 확인한다.
- 콘텐츠 표본에서 승인 체크리스트와 review event snapshot, output hash, model·CLI provenance가 서로 연결되는지 확인한다.
- 제한 베타는 검증된 스페이스 합계 3개 이상을 7일간 관찰한다. 성공뿐 아니라 실패·skip·uncertain을 모두 기록한다.
- 실제 파트너 월 정산은 원천 파일과 0원 오차를 확인한 뒤에만 R1 통과로 판정한다.
