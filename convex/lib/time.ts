// Calendar day (YYYY-MM-DD) in America/Los_Angeles: budget periods and per-day usage buckets.
const LA_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function laDate(ms: number): string {
  return LA_DAY.format(new Date(ms));
}

// Monday (YYYY-MM-DD) of the LA week containing `ms`.
export function laWeekStart(ms: number): string {
  const day = new Date(`${laDate(ms)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

export type BudgetPeriodKind = "day" | "week";

// budgets.period: the LA day for daily budgets, the LA week's Monday for weekly ones (spec 07).
export function budgetPeriod(kind: BudgetPeriodKind, ms: number): string {
  return kind === "day" ? laDate(ms) : laWeekStart(ms);
}
