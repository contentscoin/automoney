import { afterEach, describe, expect, it, vi } from "vitest";
import { computeNextRunAt } from "@automoney/shared";
import { api } from "../convex/_generated/api";
import { makeT, signup } from "./helpers";

const NOW = Date.parse("2026-10-09T10:00:00+09:00");

async function setup() {
  const t = makeT();
  const user = await signup(t, "schedule-validation@automoney.test");
  const spaceId = await t.run((ctx) => ctx.db.insert("spaces", {
    userId: user.userId, platform: "THREADS", name: "검증 계정", handle: "schedule_validation",
    pinned: false, sessionState: "HEALTHY", dailyPostLimit: 10, createdAt: NOW,
  }));
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const input = {
    spaceId, kind: "ONE_SHOT" as const, timeOfDay: "10:01", daysOfWeek: [] as number[], runDate: "2026-10-09",
    jitterMinutes: 0, text: "예약할 콘텐츠입니다.", mediaUrls: [] as string[], autoApprove: false,
  };
  return { t, user, spaceId, clock, input };
}

afterEach(() => vi.restoreAllMocks());

describe("schedule input validation and expired slots", () => {
  it("rejects expired one-shot creation and leaves an existing schedule intact after an invalid edit", async () => {
    const { t, user, input } = await setup();
    await expect(user.as.mutation(api.schedules.upsert, { ...input, runDate: "2026-10-08" })).rejects.toThrow(/미래에 실행할 시각이 없습니다/);
    expect(await user.as.query(api.schedules.listMine, {})).toHaveLength(0);
    const created = await user.as.mutation(api.schedules.upsert, input);
    const before = await t.run((ctx) => ctx.db.get(created.scheduleId));
    await expect(user.as.mutation(api.schedules.upsert, { ...input, id: created.scheduleId, timeOfDay: "09:00" })).rejects.toThrow(/미래에 실행할 시각이 없습니다/);
    expect(await t.run((ctx) => ctx.db.get(created.scheduleId))).toEqual(before);
  });

  it.each(["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-12", "2026-12-00", "2026-4-10", "not-a-date"])("rejects a malformed or nonexistent calendar date: %s", async (runDate) => {
    const { user, input } = await setup();
    await expect(user.as.mutation(api.schedules.upsert, { ...input, runDate })).rejects.toThrow(/실제 존재하는 날짜/);
  });

  it("accepts a real leap day with a future execution time", async () => {
    const { user, input } = await setup();
    const created = await user.as.mutation(api.schedules.upsert, { ...input, runDate: "2028-02-29", timeOfDay: "12:30" });
    expect(created.nextRunAt).toBe(Date.parse("2028-02-29T12:30:00+09:00"));
  });

  it.each([-1, 7, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("requires integral weekdays in the supported range: %s", async (day) => {
    const { user, input } = await setup();
    await expect(user.as.mutation(api.schedules.upsert, { ...input, kind: "WEEKLY", runDate: undefined, daysOfWeek: [day] })).rejects.toThrow(/요일은 0/);
  });

  it.each([-1, 121, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("requires finite integral jitter from zero to 120 minutes: %s", async (jitterMinutes) => {
    const { user, input } = await setup();
    await expect(user.as.mutation(api.schedules.upsert, { ...input, jitterMinutes })).rejects.toThrow(/시간 편차는 0~120분 사이의 정수/);
  });

  it("rejects a future base slot when jitter places the actual execution in the past", async () => {
    const { user, spaceId, clock, input } = await setup();
    const spec = { ...input, jitterMinutes: 120 };
    const chosenNow = Array.from({ length: 1_000 }, (_, index) => NOW + index)
      .find((now) => computeNextRunAt(spec, now, `${spaceId}:${now}`) === null);
    expect(chosenNow).toBeDefined();
    clock.mockReturnValue(chosenNow!);
    expect(Date.parse(`${input.runDate}T${input.timeOfDay}:00+09:00`)).toBeGreaterThan(chosenNow!);
    await expect(user.as.mutation(api.schedules.upsert, spec)).rejects.toThrow(/시간 편차를 줄이세요/);
    expect(await user.as.query(api.schedules.listMine, {})).toHaveLength(0);
  });

  it("rejects resuming an expired one-shot without enabling it and still permits stopping legacy invalid schedules", async () => {
    const { t, user, input, clock } = await setup();
    const created = await user.as.mutation(api.schedules.upsert, input);
    await user.as.mutation(api.schedules.setEnabled, { id: created.scheduleId, enabled: false });
    const stopped = await t.run((ctx) => ctx.db.get(created.scheduleId));
    clock.mockReturnValue(NOW + 2 * 60_000);
    await expect(user.as.mutation(api.schedules.setEnabled, { id: created.scheduleId, enabled: true })).rejects.toThrow(/재개할 수 없습니다/);
    expect(await t.run((ctx) => ctx.db.get(created.scheduleId))).toEqual(stopped);
    await t.run((ctx) => ctx.db.patch(created.scheduleId, { enabled: true, runDate: "2026-02-30" }));
    await user.as.mutation(api.schedules.setEnabled, { id: created.scheduleId, enabled: false });
    await expect(user.as.mutation(api.schedules.setEnabled, { id: created.scheduleId, enabled: true })).rejects.toThrow(/실제 존재하는 날짜/);
    expect(await t.run((ctx) => ctx.db.get(created.scheduleId))).toMatchObject({ enabled: false });
  });

  it("returns successful idempotent requests after expiry and refuses changed input under the same key", async () => {
    const { t, user, input, clock } = await setup();
    const args = { ...input, clientRequestId: "expired_retry_001" };
    const first = await user.as.mutation(api.schedules.upsert, args);
    clock.mockReturnValue(NOW + 2 * 60_000);
    expect(await user.as.mutation(api.schedules.upsert, args)).toEqual(first);
    expect(await user.as.query(api.schedules.listMine, {})).toHaveLength(1);
    await expect(user.as.mutation(api.schedules.upsert, { ...args, text: "새 내용" })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    await expect(user.as.mutation(api.schedules.upsert, { ...args, clientRequestId: "expired_retry_002" })).rejects.toThrow(/미래에 실행할 시각이 없습니다/);

    clock.mockReturnValue(NOW);
    const edit = { ...input, id: first.scheduleId, timeOfDay: "10:02", clientRequestId: "schedule_edit_001" };
    const edited = await user.as.mutation(api.schedules.upsert, edit);
    const revision = (await t.run((ctx) => ctx.db.get(first.scheduleId)))?.revision;
    clock.mockReturnValue(NOW + 3 * 60_000);
    expect(await user.as.mutation(api.schedules.upsert, edit)).toEqual(edited);
    expect((await t.run((ctx) => ctx.db.get(first.scheduleId)))?.revision).toBe(revision);
  });
});
