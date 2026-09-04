import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 매월 1일 18:00 UTC = 2일 03:00 KST 에 전월 정산 마감(DRAFT/HELD 생성). 수퍼어드민이 수동 재실행 가능.
crons.monthly("close previous month settlements", { day: 1, hourUTC: 18, minuteUTC: 0 }, internal.settlements.cronCloseLastMonth);

// 잡 lease 회수 · 승인 시한 만료
crons.interval("sweep agent job leases", { minutes: 1 }, internal.jobs.sweep, {});
// 예약 발행 틱
crons.interval("schedule tick", { minutes: 5 }, internal.schedules.tick, {});

export default crons;
