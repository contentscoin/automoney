/** 예약 스케줄 계산 (KST). docs/05 §5 */
export type ScheduleKind = "ONE_SHOT" | "DAILY" | "WEEKLY";

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** "HH:MM" KST */
  timeOfDay: string;
  /** 0=일 … 6=토 (WEEKLY) */
  daysOfWeek: number[];
  /** ±지터 (분) */
  jitterMinutes: number;
  /** ONE_SHOT: 실행 일자 "YYYY-MM-DD" (KST) */
  runDate?: string | null;
}

const KST = 9 * 3600_000;

export function parseTimeOfDay(s: string): { h: number; m: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

function kstParts(ts: number) {
  const d = new Date(ts + KST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

function kstDate(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo, d, h, mi) - KST;
}

/** 결정론적 지터: 같은 (seed, 기준 시각) → 같은 오프셋. */
export function jitterFor(seed: string, baseTs: number, jitterMinutes: number): number {
  if (jitterMinutes <= 0) return 0;
  let h = 2166136261;
  const s = `${seed}:${baseTs}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const span = jitterMinutes * 2 * 60_000;
  return (h % span) - jitterMinutes * 60_000;
}

/**
 * from 이후 첫 실행 시각(ms). 지터는 기준 슬롯에 더한다(음수 가능하지만 from 이전이면 다음 슬롯으로).
 * ONE_SHOT 은 runDate+timeOfDay 가 from 이전이면 null(만료).
 */
export function computeNextRunAt(spec: ScheduleSpec, from: number, seed: string): number | null {
  const t = parseTimeOfDay(spec.timeOfDay);
  if (!t) return null;
  if (spec.kind === "ONE_SHOT") {
    if (!spec.runDate) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec.runDate);
    if (!m) return null;
    const base = kstDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), t.h, t.m);
    const at = base + jitterFor(seed, base, spec.jitterMinutes);
    return at > from ? at : null;
  }
  const days = spec.kind === "WEEKLY" ? [...new Set(spec.daysOfWeek)].filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6];
  if (days.length === 0) return null;
  const p = kstParts(from);
  for (let i = 0; i < 15; i++) {
    const cand = new Date(Date.UTC(p.y, p.mo, p.d + i));
    if (!days.includes(cand.getUTCDay())) continue;
    const base = kstDate(cand.getUTCFullYear(), cand.getUTCMonth(), cand.getUTCDate(), t.h, t.m);
    const at = base + jitterFor(seed, base, spec.jitterMinutes);
    if (at > from) return at;
  }
  return null;
}

/** 계정별 일일 한도 체크용: KST 일자 키 */
export function kstDayKey(ts: number): string {
  const d = new Date(ts + KST);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
