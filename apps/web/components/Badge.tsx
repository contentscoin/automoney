const TONES: Record<string, string> = {
  SUBMITTED: "bg-amber-100 text-amber-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-rose-100 text-rose-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  DISABLED: "bg-stone-200 text-stone-700",
  SUSPENDED: "bg-rose-100 text-rose-800",
  PENDING: "bg-amber-100 text-amber-800",
  PAID: "bg-sky-100 text-sky-800",
  CONFIRMED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-stone-200 text-stone-700",
  REFUNDED: "bg-rose-100 text-rose-800",
  DIRECT: "bg-emerald-100 text-emerald-800",
  INDIRECT: "bg-violet-100 text-violet-800",
  USER: "bg-stone-100 text-stone-700",
  ADMIN: "bg-sky-100 text-sky-800",
  SUPER_ADMIN: "bg-orange-100 text-orange-800",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge ${TONES[value] ?? "bg-stone-100 text-stone-700"}`}>{label ?? value}</span>;
}
