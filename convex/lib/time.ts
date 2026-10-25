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
