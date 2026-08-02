export interface EffectiveEntryInput {
  id: string
  status: 'draft' | 'confirmed'
  supersedes: string | null
}

/**
 * Mirrors daily_entries_effective (0001 migration): an entry counts iff it's
 * confirmed AND has no CONFIRMED successor. NOT "no successor at all" — a
 * confirmed entry under review keeps counting while its correction is still
 * draft, and only drops out once the correction itself is confirmed. Getting
 * this backwards makes tonnage vanish from the dashboard during the exact
 * window the numbers are already under suspicion.
 *
 * This is the client-side twin of that view's WHERE clause, not a
 * replacement for it — the dashboard's placed-to-date figure reads the view
 * directly (see lineItemProgress.ts), never this function. This exists so
 * the rule itself has a Vitest suite, and so UI-only concerns (a
 * "superseded" badge on a locally-cached row, before a round trip to the
 * server) can apply the same logic without waiting on one.
 */
export function isEffective(entry: EffectiveEntryInput, all: readonly EffectiveEntryInput[]): boolean {
  if (entry.status !== 'confirmed') return false
  return !all.some((e) => e.supersedes === entry.id && e.status === 'confirmed')
}

/** Every entry in `all` that isEffective() — the set daily_entries_effective would return. */
export function filterEffective<T extends EffectiveEntryInput>(all: readonly T[]): T[] {
  return all.filter((e) => isEffective(e, all))
}
