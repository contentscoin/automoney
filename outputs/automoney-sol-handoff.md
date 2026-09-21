# Sol 개발 인수인계 — 시작 프롬프트

아래 명세와 백로그를 기준으로 automoney의 제한 베타 개발을 진행하라.

## 시작 위치

저장소: 현재 workspace의 Git root. 원격 contentscoin/automoney, 작성 기준 HEAD 2a7ef7ef76bf07ff8b883976421c359f93484f23.

먼저 outputs/automoney-development-spec-v1.md와 outputs/automoney-sol-backlog.md를 읽는다. 이전 README/docs는 배경 자료이며 현재 코드와 실행 명세의 차이를 확인한다. 이 명세의 신규 필드와 정책은 구현 목표다. 현재 이미 존재하는 기능으로 가정하지 않는다.

## 실행 지시

1. git status와 실제 HEAD, 적용되는 AGENTS.md, packageManager를 확인한다. 사용자의 기존 변경을 보존한다.
2. DEV-01과 DEV-02부터 구현한다. 예약 소유권 누락과 총판 명세/차액 응답의 간접 정보 노출을 회귀 테스트로 재현하고 수정한다.
3. Wave 순서를 지키며 작은 검토 단위로 진행한다. shared 계약 변경은 Cloud/desktop/UI/tests를 함께 갱신한다.
4. 이미 구현된 MCP OAuth, 코디 제안, 5채널 레시피를 새로 만들지 않는다. 기능 계약·실환경 준비를 보완한다.
5. 단위 테스트/Mock 성공을 실 API 또는 출시 성공으로 보고하지 않는다. 외부 입력 없이 가능한 코드·fixture·importer·운영 문서는 계속 완성한다.
6. 실 SNS 게시, 실 KYC 입력, 운영 데이터 마이그레이션, GitHub 릴리스·프로덕션 배포는 이 인수인계만으로 실행하지 않는다. 해당 실제 대상과 작업에 대한 사용자 지시를 확인한다.
7. 결과를 outputs/sol-development-progress.md에 DEV별 상태와 테스트 증거로 기록한다. 일반 작업 소스와 테스트는 해당 프로젝트 경로에 작성한다.

## 개발환경과 검증

Node 22, packageManager pnpm@10.33.0. 이 PC의 pnpm 직접 명령은 다른 버전일 수 있으므로 corepack pnpm을 사용한다. 하위 npm script가 호출하는 pnpm도 지정 버전인지 확인한다. 전역 도구 설정을 바꿔 해결하지 않는다.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @automoney/shared build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm --filter @automoney/web lint
corepack pnpm --filter @automoney/web build
corepack pnpm --filter @automoney/desktop build
```

처음에는 변경 관련 테스트부터 실행하고 통합 계약 변경 이후 전체 검증한다. 루트 build의 Windows 제외 필터는 이전 환경에서 프로젝트를 매칭하지 못했으므로 별도 workspace build를 검증하고 DEV-15에서 원인을 재현해 수정한다. shared 39/web 49/desktop 28은 이전 시점의 기준선일 뿐 현재 결과가 아니다.

로컬 E2E는 apps/web/scripts/e2e-local.mjs, e2e-mcp.mjs 및 apps/desktop/scripts/e2e-agent.mjs의 입력/초기화 동작을 먼저 읽고 격리한 로컬 Convex 대상으로 실행한다. 개발 .env.local은 이전에 localhost와 change-me로 만든 초안이며 인증/JWKS 등 초기화가 끝났다고 가정하지 않는다. secrets를 로그/문서에 기록하지 않는다.

## 최종 완료 보고

- 구현된 DEV ID와 사용자 동작 변화
- 실제 통과/실패/미실행 검증
- 데이터 마이그레이션과 v1/v2 에이전트 호환성
- 외부 입력이 필요한 항목 및 막는 출시 단계
- 남은 작업과 다음 실행 단위

이 문서는 Sol에 작업을 전달하기 위한 명세다. 이 문서를 만들었다는 사실만으로 별도 Codex 작업이 생성되거나 Sol 실행이 시작되는 것은 아니다.
