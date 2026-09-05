import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 매월 1일 18:00 UTC = 2일 03:00 KST 에 전월 정산 마감(DRAFT/HELD 생성). 수퍼어드민이 수동 재실행 가능.
crons.monthly("close previous month settlements", { day: 1, hourUTC: 18, minuteUTC: 0 }, internal.settlements.cronCloseLastMonth);

// 잡 lease 회수 · 승인 시한 만료
crons.interval("sweep agent job leases", { minutes: 1 }, internal.jobs.sweep, {});
// 예약 발행 틱
crons.interval("schedule tick", { minutes: 5 }, internal.schedules.tick, {});

// 큐레이션: 구글 트렌드(KR) RSS 6시간
crons.interval("refresh trends", { hours: 6 }, internal.curation.refreshTrends, {});

// 분석 루프: 게시 후 24h/72h/7d 창 readback
crons.interval("analytics readback tick", { hours: 1 }, internal.analytics.tick, {});
// Meta 장기 토큰 갱신(만료 7일 전)
crons.daily("meta token refresh", { hourUTC: 19, minuteUTC: 30 }, internal.meta.scheduleRefreshes, {});

export default crons;
