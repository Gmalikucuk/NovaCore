import { supabase } from './client'

/**
 * 'area' or 'length' — which figure a rule's coefficient multiplies. Not a
 * free-text unit: the coefficient's own denominator (L/m2 vs L per linear
 * metre) IS the basis, and the derived Item's own `unit` column already
 * carries the result unit. See 0039 and calculations/derivation.ts.
 */
export type DerivationBasis = 'area' | 'length'

export interface DerivationRule {
  itemId: string
  contractId: string
  coefficient: number
  basis: DerivationBasis
  /** Which OTHER Items' same-date records this rule sums — a plain inclusion set, never a description or unit match. */
  sourceItemIds: string[]
}

interface RawRuleRow {
  item_id: string
  contract_id: string
  coefficient: string
  basis: DerivationBasis
}

interface RawSourceRow {
  rule_item_id: string
  source_item_id: string
}

/** Every derivation rule on a contract, with its sources. An Item with no rule simply has no row — the common case, never inferred. */
export async function fetchDerivationRules(contractId: string): Promise<DerivationRule[]> {
  const [{ data: ruleRows, error: ruleErr }, { data: sourceRows, error: sourceErr }] = await Promise.all([
    supabase.from('item_derivation_rules').select('item_id, contract_id, coefficient, basis').eq('contract_id', contractId),
    supabase.from('item_derivation_sources').select('rule_item_id, source_item_id').eq('contract_id', contractId),
  ])
  if (ruleErr) throw ruleErr
  if (sourceErr) throw sourceErr

  const sourcesByRule = new Map<string, string[]>()
  for (const row of (sourceRows ?? []) as RawSourceRow[]) {
    const list = sourcesByRule.get(row.rule_item_id) ?? []
    list.push(row.source_item_id)
    sourcesByRule.set(row.rule_item_id, list)
  }

  return ((ruleRows ?? []) as RawRuleRow[]).map((row) => ({
    itemId: row.item_id,
    contractId: row.contract_id,
    coefficient: Number(row.coefficient),
    basis: row.basis,
    sourceItemIds: sourcesByRule.get(row.item_id) ?? [],
  }))
}

export interface DerivationRuleInput {
  coefficient: number
  basis: DerivationBasis
  sourceItemIds: string[]
}

/**
 * Writes the rule, then replaces its source set wholesale — delete then
 * insert, not a diff. A rule's source list is a handful of Items at most,
 * so this stays simple and is always correct regardless of what the
 * previous set was.
 */
export async function upsertDerivationRule(itemId: string, contractId: string, input: DerivationRuleInput): Promise<void> {
  const { error: ruleErr } = await supabase
    .from('item_derivation_rules')
    .upsert({ item_id: itemId, contract_id: contractId, coefficient: input.coefficient, basis: input.basis }, { onConflict: 'item_id' })
  if (ruleErr) throw ruleErr

  const { error: deleteErr } = await supabase.from('item_derivation_sources').delete().eq('rule_item_id', itemId)
  if (deleteErr) throw deleteErr

  if (input.sourceItemIds.length > 0) {
    const { error: insertErr } = await supabase
      .from('item_derivation_sources')
      .insert(input.sourceItemIds.map((sourceItemId) => ({ rule_item_id: itemId, source_item_id: sourceItemId, contract_id: contractId })))
    if (insertErr) throw insertErr
  }
}

/** Clears a rule entirely — an Item can go back to having none, same as area_basis can go back to Unclassified. Sources cascade via FK. */
export async function deleteDerivationRule(itemId: string): Promise<void> {
  const { error } = await supabase.from('item_derivation_rules').delete().eq('item_id', itemId)
  if (error) throw error
}

/**
 * A design application rate and bonus band from the Special Provisions
 * (e.g. 124.35 kg/m2, band 96-104%) — unrelated to derivation rules, see
 * 0039's header for why. Stored only; no document in this codebase reads
 * it yet.
 */
export interface ApplicationRateTarget {
  itemId: string
  contractId: string
  targetRate: number
  bandLowPercent: number | null
  bandHighPercent: number | null
}

interface RawTargetRow {
  item_id: string
  contract_id: string
  target_rate: string
  band_low_percent: string | null
  band_high_percent: string | null
}

export async function fetchApplicationRateTargets(contractId: string): Promise<ApplicationRateTarget[]> {
  const { data, error } = await supabase
    .from('item_application_rate_targets')
    .select('item_id, contract_id, target_rate, band_low_percent, band_high_percent')
    .eq('contract_id', contractId)
  if (error) throw error
  return ((data ?? []) as RawTargetRow[]).map((row) => ({
    itemId: row.item_id,
    contractId: row.contract_id,
    targetRate: Number(row.target_rate),
    bandLowPercent: row.band_low_percent === null ? null : Number(row.band_low_percent),
    bandHighPercent: row.band_high_percent === null ? null : Number(row.band_high_percent),
  }))
}

export interface ApplicationRateTargetInput {
  targetRate: number
  bandLowPercent: number | null
  bandHighPercent: number | null
}

export async function upsertApplicationRateTarget(itemId: string, contractId: string, input: ApplicationRateTargetInput): Promise<void> {
  const { error } = await supabase
    .from('item_application_rate_targets')
    .upsert(
      { item_id: itemId, contract_id: contractId, target_rate: input.targetRate, band_low_percent: input.bandLowPercent, band_high_percent: input.bandHighPercent },
      { onConflict: 'item_id' },
    )
  if (error) throw error
}

export async function deleteApplicationRateTarget(itemId: string): Promise<void> {
  const { error } = await supabase.from('item_application_rate_targets').delete().eq('item_id', itemId)
  if (error) throw error
}
