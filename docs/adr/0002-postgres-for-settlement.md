# ADR-0002 클라우드 DB는 Postgres, 정산 데이터는 정규화·append-only

- 상태: 채택
- 맥락: blogautomcp는 SQLite(D1)와 JSON-in-TEXT 컬럼을 광범위하게 사용한다. automoney는 금전 정산을 다룬다.
- 결정: Postgres + Drizzle ORM. 주문 원장·수수료 항목·정산은 정규화 테이블, 상태 변경은 이벤트 테이블, 계산 결과는 규칙 버전과 함께 저장한다.
- 근거: 3단계 분배·역분개·리컨실은 트랜잭션과 외래키 무결성이 필요하다. 감사·분쟁 대응을 위해 재현 가능한 계산이 필요하다.
- 결과: 서버리스 전용 배포(Workers+D1) 대신 Postgres 접근 가능한 런타임이 필요하다. blogautomcp의 잡큐·OAuth 스키마는 Postgres로 이식한다.
