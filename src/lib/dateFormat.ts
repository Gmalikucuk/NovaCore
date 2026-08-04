export function todayLocalDateString(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** "2026-07-10" -> "Fri, Jul 10" — parsed as a local date, not UTC, so the day never shifts by a timezone offset. */
export function formatDayLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Whole days between `dateStr` and today (positive when dateStr is in the past) — parsed as local dates, not UTC, same timezone-safe approach as formatDayLabel. Rounded rather than floored/truncated so a DST transition day can't quietly shift the count by an hour's worth of a day. */
export function daysAgo(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((startOfToday.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
}

/** A confirmed_at timestamptz as the moment it actually was, not just which day — "Aug 3, 2026, 2:14 PM". The one place this app shows WHEN data was last confirmed rather than which work_date it's for. */
export function formatConfirmedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
