export interface EffectiveEntryInput {
  id: string
  status: 'draft' | 'confirmed'
  supersedes: string | null
}

/**
 * Mirrors quantity_records_effective (0001 migration, renamed by 0009): an entry counts iff it's
 * confirmed AND has no CONFIRMED successor. NOT "no successor at all" — a
 * confirmed entry under review keeps counting while its correction is still
 * draft, and only drops out once the correction itself is confirmed. Getting
 * this backwards makes tonnage vanish from the dashboard during the exact
 * window the numbers are already under suspicion.
 *
 * This is the client-side twin of that view's WHERE clause, deliberately
 * kept as a second expression of the same rule rather than deferring to
 * the view — it exists so the rule itself has a Vitest suite (a view's
 * WHERE clause isn't practically unit-testable in isolation), and so
 * UI-only concerns (a "superseded" badge on a locally-cached row, before a
 * round trip to the server) can apply the same logic without waiting on
 * one. Both are intentional and both must change together: if the
 * supersession rule itself ever changes, update the view's WHERE clause
 * (currently in the migration that recreates quantity_records_effective)
 * and this function in the same change, or they will quietly diverge.
 *
 * PRECONDITION: `all` must be a complete candidate set — every record that
 * could possibly supersede any record being checked must be present in it.
 * isEffective() only looks for a confirmed successor WITHIN `all`; if the
 * true successor was filtered out before this function ever saw it (by
 * date range, by pagination, by anything narrower than "every record that
 * could name this one in its own supersedes"), a superseded record can
 * wrongly read as effective. The view has no such dependency — its NOT
 * EXISTS subquery always sees the whole table. The one current caller
 * (dashboard.ts's fetchEffectiveStationRecords) satisfies this by
 * querying every confirmed record for the contract before calling in —
 * safe because supersession never crosses contracts — but that is a
 * property of how it happens to be called, not something this function
 * enforces. A future caller that filters `all` down further before
 * passing it in must re-check this precondition itself.
 */
export function isEffective(entry: EffectiveEntryInput, all: readonly EffectiveEntryInput[]): boolean {
  if (entry.status !== 'confirmed') return false
  return !all.some((e) => e.supersedes === entry.id && e.status === 'confirmed')
}

/** Every entry in `all` that isEffective() — the set quantity_records_effective would return, given the same precondition on `all` (see isEffective's doc comment). */
export function filterEffective<T extends EffectiveEntryInput>(all: readonly T[]): T[] {
  return all.filter((e) => isEffective(e, all))
}
