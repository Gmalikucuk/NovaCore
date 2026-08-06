import { supabase } from './client'

/**
 * Per-user, per-scope display preferences (which columns show, sort order,
 * row counts, a toggle state) — convenience only, never load-bearing.
 * `scope` is a plain string key so other screens (the active-contract
 * selector, Portfolio's filters — both currently stuck in localStorage
 * today) can adopt this same table under their own scope value later,
 * without a schema change; not done here.
 *
 * This never carries anything that changes what data a person can reach —
 * only how it's displayed. A screen's own rights check (view_rates and so
 * on) always runs regardless of what's saved here; this module has no
 * opinion on permissions at all.
 */

interface RawPreferencesRow {
  preferences: unknown
}

/**
 * Returns null on a missing row OR anything that doesn't parse as a plain
 * object — malformed JSON, a stray array, a primitive. The caller's own
 * default must survive both cases identically; this function never throws
 * for a shape it doesn't like, only for a genuine fetch failure.
 */
export async function fetchViewPreferences(scope: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.from('user_view_preferences').select('preferences').eq('scope', scope).maybeSingle()
  if (error) throw error
  const row = data as RawPreferencesRow | null
  if (!row) return null
  const prefs = row.preferences
  return prefs !== null && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : null
}

/** user_id sent explicitly, not left to a column default — the RLS WITH CHECK is what actually confines it to the caller's own id, same pattern as pinned_items.user_id. */
export async function saveViewPreferences(scope: string, preferences: Record<string, unknown>): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in.')

  const { error } = await supabase
    .from('user_view_preferences')
    .upsert({ user_id: user.id, scope, preferences, updated_at: new Date().toISOString() }, { onConflict: 'user_id,scope' })
  if (error) throw error
}

/** Reset to default is an empty blob, not a deleted row — one fewer state (row present vs absent) for every caller's "have I loaded yet" logic to handle. */
export async function resetViewPreferences(scope: string): Promise<void> {
  await saveViewPreferences(scope, {})
}
