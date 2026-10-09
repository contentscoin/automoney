# automoney 개발 완료 보고서

## 2026-10-09 운영 검증: 수퍼어드민 제작 → 사용자 공급

최신 확인: 2026-10-09 21:29 KST. 사용자 승인에 따라 기존 수퍼어드민 계정으로 PC를 전환하고, 지정한 [아뜨랑스 기획전 2971](https://attrangs.co.kr/benefit/exhibition.php?index_no=2971)의 대표 상품 **로베른 슬랙스(170649)**로 실제 운영 제작·공급 경로를 검증했다. 기획전 전체 상품 또는 기존 10개 상품 전체를 이번에 새로 생성한 것은 아니다.

### 확인된 결과

| 단계 | 실제 결과 |
|---|---|
| 운영자 PC | 공식 페어링으로 수퍼어드민 연결, PC 0.1.19 온라인·Codex 로그인 확인. 기존 SNS 프로필과 로그인 파일 보존 |
| 원자료 | 새로 작성한 사실 요약 1건 + 출처 상품 이미지 1건 READY. 이미지 622,149 bytes, JPEG, 고정 저장 후 원본과 SHA-256 일치 |
| AI 생성 | 실제 운영자 PC에서 Threads·Instagram Feed·Blog 3건, 1차 시도 약 57초에 생성 성공 |
| 검수 | 숏·롱 2기장 / 투핀턱 / 히든밴딩 / 세미 와이드만 사용. 가격·할인·배송 보장·착용 경험 주장 없음. 본문 첫 줄 `[광고 · 데모 콘텐츠]` 추가 후 최신 출력 해시로 승인 |
| 공급 | `[데모 검증] 기획전 2971 · 로베른 슬랙스` 묶음 PUBLISHED, 콘텐츠 3건 APPROVED·SHARED. 일반 USER 권한의 라이브러리 조회에서 모두 노출 |
| 사용자 복사 | 일반 USER의 개인 사본 3건 생성. PRIVATE·DRAFT, 승인자·승인 시각·체크리스트 초기화 확인. 사본의 최종 검토는 남겨 둠 |
| 비게시 실행 | 승인 원본 + 같은 상품의 관리자 MOCK 링크로 Threads·Instagram Feed cloud dry-run 2건 SUCCEEDED |
| 실게시 방지 | 두 결과 모두 `dryRun:true`, 게시 URL·외부 게시 ID·publish intent·게시 시도 시각 없음. 예약 원장/실적 생성 0건. LIVE는 계속 false |

실행 추적: 컬렉션 `rx75dtvrgvh1z066yccd5s00ah8fzzyd`, 성공 run `rh70z9sgdmgmv1a8nba9mcd4x58fzh84`(COMPLETED, 생성/승인 3/3), 생성 job `j5728vrs1mz630e5mvq3aevrrn8fy38q`. Dry-run jobs: `j570mvcnz6b4epzgpcf8afam518fytk1`, `j574snrjpvrmza9rxkept612bn8fy1z5`. 로컬 상세 증거는 Git에서 제외한 `dist/ops/exhibition-2971-verification.json`에 보관한다.

검수·등록·승인·복사는 사용자의 위임에 따라 Codex가 공식 애플리케이션 API로 수행했고 수퍼어드민/테스트 USER의 감사 기록을 남겼다. 사용자가 브라우저에서 직접 검수 버튼을 눌렀다는 뜻이 아니며, 로그인된 브라우저 UI E2E 검증과도 구분한다. 파일 이미지 자체는 직접 확인했지만 PC 패널 캡처는 시간 초과로 확인하지 못해 연결 상태는 서버 및 앱 로그로 대조했다. 자동 품질점수 100은 규칙 검사 통과를 뜻하며 문장 완성도·광고 적합성·권리 계약·판매 성과의 완벽한 보장이 아니다. 이미지 사용 근거는 이번 데모에 대한 사용자의 자료 지정·승인으로 기록했으며, 사이트의 공개 여부 자체를 라이선스로 취급하지 않는다.

### 실제 실행에서 발견해 수정한 문제

개인 Codex 설정의 부가 연결을 상속하는 기존 실행은 180초 시간 초과와 재시도로 지연됐다. 동일 로그인에서 개인 설정을 분리한 최소 실행은 약 7초에 응답했고, 수정 코드 스모크는 약 5초에 성공했다. PC **0.1.19**에서 개인 설정·앱 연결·세션 저장을 생성 실행과 분리하고, 읽기 전용·기존 규칙·인증 경로를 유지했다. 모델이 실행하는 셸에는 부모 환경변수를 상속하지 않게 했고, 프롬프트는 명령줄 대신 표준입력으로 전달한다. 비정상 종료 시 일부 출력 파일이 남아도 실패 처리한다. [공식 실행 옵션](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [환경변수 상속 설정](https://learn.chatgpt.com/docs/config-file/config-reference)을 확인해 적용했다.

첫 지연 job은 공식 취소 요청으로 CANCELLED 처리됐고 이전 run은 FAILED 이력으로 남겼다. 같은 자료를 새 run으로 재생성했으며 원자료·기존 콘텐츠를 삭제하지 않았다.

- 구현 커밋: `666fe3b793f81810bf0a2bd8b5d1bb3f7591cd0b`, 기존 개발 브랜치 push 완료.
- 이번 PC 전체 테스트 **103개**, 타입 검사·빌드 통과. 추가 Meta dry-run 경로 테스트 13개 통과. 이전 웹/공통 전체 테스트를 이번에 전부 재실행한 것은 아니다.
- [Windows x64 / Mac arm64 0.1.19 릴리스](https://github.com/contentscoin/automoney/releases/tag/desktop-v0.1.19), [CI 빌드·테스트·릴리스](https://github.com/contentscoin/automoney/actions/runs/37929303167) 성공. 운영 웹 다운로드가 각각 0.1.19 설치 파일로 연결됨을 확인했다.
- 현재 PC는 자동 업데이트로 21:25:34 KST 재시작했고 .19 heartbeat·Codex 로그인·페어링 유지 확인. 앱 코드 서명 완료를 의미하지 않는다.
- 이번 수정은 PC 앱만 배포했으며 웹·서버 코드는 변경하지 않았다. 기존 `work/`는 수정·커밋·업로드하지 않았다.

### 사용 경로와 남은 범위

1. 수퍼어드민으로 [콘텐츠 공급실](https://automoney-eight.vercel.app/super/content)에 로그인해 위 묶음을 확인한다.
2. 일반 사용자로 [콘텐츠 찾기](https://automoney-eight.vercel.app/dashboard/content)에서 운영 제공 3건을 확인한다. 현재 테스트 USER에는 [내 콘텐츠](https://automoney-eight.vercel.app/dashboard/content/mine)에 검토 대기 사본도 3건 준비돼 있다.
3. 사본 최종 검수·개인 마케팅 링크·실제 SNS 연결 후 해당 사용자 장치에서 테스트한다. **현재 PC는 운영자용이므로 이전 USER 장치는 오프라인**이다. USER 데스크톱 브라우저 실행이나 네이버 블로그 실행까지 완료한 것은 아니다.
4. Meta 앱 자격증명, 실제 제휴 링크·주문 귀속, 외부 캠페인 재사용 계약 범위, 실제 계정 검증 및 별도 운영 승인 전까지 LIVE를 켜지 않는다. 현재 partner/Meta는 mock이며 이번 2건의 성공은 SNS 실게시 성공이 아니다.

## 2026-10-09 후속: 승인 미디어 고정·검수 흐름

이 절은 0.1.18 배포 당시 기록이다. 최신 운영 검증과 PC 상태는 위 0.1.19 절을 따르며, 아래 앞선 배포 기록과 9월 기록은 당시 결과를 보존한다.

- 운영자·사용자는 **사용권 및 공개 저장 동의 → 파일 고정 → 전체 미리보기 → 네 항목 검수 → 승인** 순서로 미디어 콘텐츠를 준비한다. 파일이 준비되었다고 자동 승인하지 않는다.
- 원격 파일은 공개 HTTPS/DNS·redirect·실제 연결 IP·본문 제한 시간·크기·파일 형식 검증 후 불변 저장한다. 파일 SHA-256·크기·MIME·순서를 승인 event, 작업 payload와 예약에 결합한다.
- 수정 중인 콘텐츠는 이전 다운로드 결과로 덮어쓰지 않는다. 중복 요청, 오래된 작업자의 실패, 마지막 저장 응답 유실에도 연결된 파일을 보호한다. 실패·진행·재시도 안내를 카드에 표시한다.
- 서버 등록·승인·실행·최종 게시, PC 다운로드 바이트, Meta 최초 파일 읽기 전까지 동일 파일인지 검사한다. 미디어 실게시 PC 최소 버전은 **0.1.18**이고 텍스트 전용은 기존 최소 버전을 유지한다.
- 과거 원격 주소 승인본은 수정 저장→고정→재승인이 필요하다. 파일 명세 없는 이전 예약은 자동 중지한다. 직접 입력 미디어는 테스트 실행만 가능하다. 기존 이력·개인 사본은 삭제하지 않는다.

검증 결과: 웹 230개, 공통 규칙 62개, PC 앱 88개 — **380개 테스트 통과**. 앱 및 테스트 타입 검사, shared/desktop/웹 production build 통과. ESLint 오류 없음, 기존 OAuth 이미지 경고 1개. 실제 React 화면을 사용하는 mock UI 32검사 통과. 외부 계정·원본 파일 네트워크·운영 미디어 재생·SNS 실게시 성공을 의미하지 않는다.

### 화면 사용성 점검

검토 범위는 미디어 준비→검수→게시/예약의 한 흐름이다. `better-interface` 기준을 적용해 아래 항목을 통합 보완했다.

| 범위 | 적용·확인 |
|---|---|
| 접근성 | 입력 라벨, 오류 연결, 진행 상태 알림, 키보드 Space/Tab, 3px 포커스 표시 |
| 배치 | 320/1440px에서 넘침 없음, 200% CSS 확대 reflow, 전체 미디어 펼치기 |
| 문구 | 사용권과 공개 저장 범위, 고정과 승인의 차이, 저장 실패·이전 승인 복구 안내 |
| 타이포그래피 | 기존 글꼴·위계 유지, 긴 주소/오류 줄바꿈과 진행 숫자 확인 |
| 색상 | 기존 토큰 유지, 상태를 색상만으로 전달하지 않음; 전체 조합의 수치 대비 검사는 미수행 |
| UI 마감 | 중복 클릭 방지, 입력 보존, 미리보기 실패·재시도, 수정 후 체크 초기화 |

통합 발견사항은 ‘외부 원본을 승인하는 흐름’과 ‘준비 상태/승인 상태 혼동’이었다. 고정 파일만 미리보기하고 모든 미리보기 로드 및 사람 체크 후 승인하도록 수정했다. 판정: **검증한 합성 흐름의 차단 이슈 없음, 실계정 출시 검증은 남음**. 실제 보조기기·브라우저 자체 확대·영상 codec별 재생·전 색상 대비는 별도 점검 대상이다. UI 증거는 로컬 `dist/ui-smoke/report.json` 및 화면 이미지에 있고 Git에는 검증 스크립트만 포함한다.

### 운영 준비와 잔여 조건

- 읽기 확인 기준 LIVE는 계속 꺼짐, 파트너·Meta는 mock, Meta 앱 자격증명은 미설정이다.
- 온라인 0.1.17 PC의 Codex 로그인은 일반 사용자 계정에서 확인됐으며 수퍼어드민 PC는 0.1.16·오프라인이다. 운영자 PC를 새 버전으로 업데이트하고 운영자 계정에서 다시 연결해야 한다. 기존 SNS HEALTHY 기록은 오래되어 현재 로그인 증거로 보지 않는다.
- 실제 제휴 링크·미디어 재사용 허가·SNS/Meta 연결을 준비한 뒤 어드민 제작→검수→공개→사용자 복사→테스트 실행을 검증한다. 그 뒤 별도 운영 승인으로 LIVE를 켠다. 이번 작업은 실제 게시를 수행하지 않는다.
- 저장 직후 연결 전에 프로세스가 강제 종료되면 식별되지 않은 미사용 blob이 남을 수 있다. 자동으로 기존 저장소를 추정 삭제하지 않는다. 비용 관찰·권리 철회/보존 정책·앱 코드 서명은 운영 잔여 과제로 runbook에 기록했다.
- 배포 전 production DB snapshot: `1791542589834566691`. 로컬 보관: `D:\CodexData\Documents\Codex\automoney-backups\media-predeploy-20261009-194308.zip` (기존 파일 저장소는 변경·삭제하지 않음).

배포 확인:

- 구현 커밋 `eb58ccbc634cac10c8a278cfef6fae007c4408a0`, 기존 개발 브랜치 push 완료.
- Convex production `resilient-cheetah-311` 스키마·함수 배포 성공. 새 미디어 테이블 인덱스 5개 추가, 기존 인덱스 삭제 없음. 준비상태 조회에서 live off / partner mock / Meta 미설정 / 미디어 PC 최소 0.1.18 확인. 잘못된 파일 ID의 공개 경로는 404 반환.
- [운영 웹](https://automoney-eight.vercel.app): Vercel `dpl_9DbY6wMjBohtdYZu6pDcpoxeMHV1` READY. 로그인 200, 미인증 공급실·게시 화면은 로그인으로 307 이동 확인.
- PC [0.1.18 릴리스](https://github.com/contentscoin/automoney/releases/tag/desktop-v0.1.18): Windows x64 EXE, Mac arm64 DMG/ZIP 및 업데이트 메타데이터 공개 완료. [빌드·테스트·릴리스 실행](https://github.com/contentscoin/automoney/actions/runs/37919685113) 성공. 운영 웹의 Windows/Mac 다운로드 경로가 각각 0.1.18 설치 파일로 302 이동하는 것을 확인했다. 앱 코드 서명 완료를 의미하지 않는다.
- 기존 `work/`는 수정·커밋·업로드하지 않았으며 웹은 커밋 소스의 깨끗한 사본으로 배포했다.

## 2026-10-09 콘텐츠 운영 보강 결과

아래 2026-09-22 R0 기록은 당시 결과이며, 이번 작업은 어드민 자료 공급부터 사용자 게시 준비까지의 운영 완성도를 보강했다. 상시 실게시 출시 완료와 구분한다.

| 영역 | 이번 완료 사항 |
|---|---|
| 운영 자료 | 초안 수정, 검토 시각 충돌 검사, 준비 완료 원본 불변 유지 |
| 공급 묶음 | 제목·태그·자료 수정, 초안 폐기·자료 재사용, AI 실행·수신 중 변경 잠금 |
| 탐색·복구 | 자료·묶음 페이지네이션, 불러온 목록 검색, 생성 실패 이유와 복구 경로 |
| 콘텐츠 품질 | 수동·AI 사실 검사 통일, 상품 가격 변경 재검증, 운영 사본 수정 후 사람 재검수 |
| 게시 준비 | 서버 기반 PC·SNS·live 준비 안내, 테스트 기본값, 승인 원문 보호, 최근 목록 밖 직접 링크 조회 |
| 제휴 링크 | 데모 실게시 차단, 실제 풀 전환, 기존 클릭·링크 이력 보존, 전환 경쟁·풀 소진 방어 |
| 예약 | 건너뛴 사유 노출, 실패·삭제·중복 클릭 처리, 잘못된 날짜·과거 지터·만료 재개 차단 |
| 접근성·좁은 화면 | 입력 라벨 연결, 오류 안내, 편집 충돌 시 입력 보존, 320px 가로 넘침 수정 |

검증 범위:

- 웹 단위/계약 테스트 159건, 공통 규칙 60건, PC 앱 79건: 298건 통과.
- 앱·테스트 타입 검사와 shared/desktop/Next.js production build 통과. ESLint 오류 없음, 기존 OAuth 이미지 경고 1건.
- 실제 React 페이지를 사용하는 **mocked UI** 검증 18건 통과: 공급실/게시/예약/링크 320·1440px, 편집·저장 실패·입력 보존, LIVE-off 차단, 링크 전환. 실제 계정 로그인·AI 실행·파일 업로드·외부 SNS 성공을 의미하지 않는다.
- UI 재검증은 웹 빌드 후 `node apps/web/scripts/ui-smoke.mjs`로 실행한다. `--serve`를 붙이면 `127.0.0.1:4179`에서 확인할 수 있고, 산출물은 Git에서 제외된 `dist/ui-smoke`에 저장한다. 실제 사이트·계정에 쓰지 않는다.
- `better-interface` 기준으로 흐름·문구·입력 접근성·좁은 화면을 점검했으며, 실제 보조기기 및 로그인된 운영자·일반 사용자 양쪽의 종단간 검증은 별도다.

남은 출시 조건:

1. 실제 제휴 링크 풀·주문 귀속 연동 및 콘텐츠/이미지 재사용 권리 확인.
2. 운영 PC Codex 로그인과 실제 SNS/Meta 연결 후 관리자 생성→검수→공개→일반 사용자 복사→테스트 실행 확인.
3. 원격 미디어 바이트를 승인 시점에 고정하는 저장 계층, 실제 계정 스모크 및 운영 승인 후에만 LIVE 활성화. 현재 `false`를 유지한다.
4. origin이 없는 과거 링크는 호환 유지하므로 실제 파트너 링크인지 운영 점검한다. 코드 서명·계정별 SNS 제한은 외부 운영 과제로 남는다.

운영 환경 읽기 확인: `LIVE_PUBLISH_ENABLED=false`, `ATTRANGS_MODE=mock`, `META_MODE=mock`. Meta 앱 자격증명은 미설정. 이번 작업으로 이 플래그를 실제 게시 모드로 바꾸지 않았다.

배포 확인:

- 구현 커밋: `3ca7addbd276a16d4b99e8ab246a9e71894bb3b5` (기존 개발 브랜치에 push 완료).
- Convex production `resilient-cheetah-311`: 스키마 검증·함수 배포 성공, 삭제된 인덱스 없음. 공개 준비상태 조회에서 live off / partner mock / Meta 미설정 / 공개 URL 정상 확인.
- 웹: [운영 사이트](https://automoney-eight.vercel.app), Vercel `dpl_3z9KKPktgbvcMXDAFNaA9iAofNzR`가 READY. 로그인 화면 HTTP 200, 미인증 공급실·게시 화면은 로그인으로 307 이동 확인.
- PC 앱: [0.1.17 릴리스](https://github.com/contentscoin/automoney/releases/tag/desktop-v0.1.17), Windows x64 설치 프로그램과 Mac arm64 DMG/ZIP 및 업데이트 메타데이터 공개 완료. [빌드·테스트·릴리스 실행](https://github.com/contentscoin/automoney/actions/runs/37913158747) 성공.
- 사용자 기존 `work/` 폴더는 수정·커밋·웹 업로드하지 않았다. 웹 배포는 커밋의 깨끗한 소스 사본에서 진행했다.

---

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
