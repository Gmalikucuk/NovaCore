import { supabase } from './client'

export interface ProjectApplicationRateConfig {
  targetRateKgM2: number
  bonusBandLowPct: number | null
  bonusBandHighPct: number | null
  rejectBandLowPct: number | null
  rejectBandHighPct: number | null
}

/**
 * Powers the Paving Stage 3 live application-rate checkpoint. Returns null
 * when there's nothing meaningful to compute a rate against — either the
 * project has no project_config row at all, or it has one but
 * target_application_rate_kg_m2 itself was never set (both nullable at the
 * schema level, e.g. a project not yet fully configured) — so the UI can
 * branch on a single "checkpoint unavailable for this project" state rather
 * than juggling two different kinds of missingness. Band thresholds stay
 * independently nullable in the returned shape: a project can have a target
 * rate but incomplete bands, in which case the rate number itself should
 * still display, just without color classification.
 */
export async function fetchProjectApplicationRateConfig(projectId: string): Promise<ProjectApplicationRateConfig | null> {
  const { data, error } = await supabase
    .from('project_config')
    .select('target_application_rate_kg_m2, bonus_band_low_pct, bonus_band_high_pct, reject_band_low_pct, reject_band_high_pct')
    .eq('project_id', projectId)
    .maybeSingle()
  if (error) throw error
  if (!data || data.target_application_rate_kg_m2 === null) return null

  return {
    targetRateKgM2: Number(data.target_application_rate_kg_m2),
    bonusBandLowPct: data.bonus_band_low_pct === null ? null : Number(data.bonus_band_low_pct),
    bonusBandHighPct: data.bonus_band_high_pct === null ? null : Number(data.bonus_band_high_pct),
    rejectBandLowPct: data.reject_band_low_pct === null ? null : Number(data.reject_band_low_pct),
    rejectBandHighPct: data.reject_band_high_pct === null ? null : Number(data.reject_band_high_pct),
  }
}
