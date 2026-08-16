/**
 * Every rate in the cost registers is time-keyed, not a flat current
 * value — a bid priced in 2024 read 2024 rates, and comparing that
 * estimate against actual cost later means reading the rate that was
 * CURRENT WHEN THE ESTIMATE WAS MADE, not whatever the register holds
 * today. These two functions are the only sanctioned way to resolve a
 * rate from a history array, and neither one lets a caller ask "what is
 * it" without also saying "as of when":
 *
 *   currentByYear/currentByDate   — "as of right now" (today), for a
 *                                    maintenance screen showing/editing
 *                                    the latest entry.
 *   asOfYear/asOfDate             — "as of THIS specific point," for any
 *                                    consumer reading a rate against a
 *                                    bid date, a work date, or any other
 *                                    moment that isn't today. This is the
 *                                    one a bid or a DWR must use.
 *
 * Deliberately NO bare "the rate" accessor exists — every call site has
 * to pick one of the four above and therefore has to say which moment it
 * means. A future consumer reaching for "just give me the rate" should
 * hit a wall here, not a convenient shortcut that quietly means "today"
 * until the day it's read against last year's bid.
 *
 * Neither function resolves a book_year from a calendar date, or an
 * effective_date from one either — that mapping is a person's judgement
 * (which Blue Book edition did we actually price against), never
 * inferred, same standing rule as tender_price and contract_state.
 */

export function currentByYear<T extends { bookYear: number }>(rows: readonly T[]): T | null {
  return rows.reduce<T | null>((latest, row) => (latest === null || row.bookYear > latest.bookYear ? row : latest), null)
}

/** The most recent row at or before bookYear — never a future one, and never the nearest by distance. */
export function asOfYear<T extends { bookYear: number }>(rows: readonly T[], bookYear: number): T | null {
  return rows.filter((row) => row.bookYear <= bookYear).reduce<T | null>((latest, row) => (latest === null || row.bookYear > latest.bookYear ? row : latest), null)
}

export function currentByDate<T extends { effectiveDate: string }>(rows: readonly T[]): T | null {
  return rows.reduce<T | null>((latest, row) => (latest === null || row.effectiveDate > latest.effectiveDate ? row : latest), null)
}

/** The most recent row at or before asOfDate (ISO 'YYYY-MM-DD', string-comparable) — never a future one. */
export function asOfDate<T extends { effectiveDate: string }>(rows: readonly T[], asOfDate: string): T | null {
  return rows.filter((row) => row.effectiveDate <= asOfDate).reduce<T | null>((latest, row) => (latest === null || row.effectiveDate > latest.effectiveDate ? row : latest), null)
}
