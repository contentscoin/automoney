const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 타임스탬프(ms)를 KST 기준 "YYYY-MM" 으로. */
export function kstMonth(ts: number): string {
  const d = new Date(ts + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
