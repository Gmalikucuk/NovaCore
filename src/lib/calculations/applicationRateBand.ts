export type ApplicationRateBand = 'bonus' | 'penalty' | 'reject' | 'unavailable'

export interface ApplicationRateBandThresholds {
  bonusBandLowPct: number | null
  bonusBandHighPct: number | null
  rejectBandLowPct: number | null
  rejectBandHighPct: number | null
}

/**
 * Classifies a live application-rate percentage against SS 502 Table 502-H's
 * bonus/penalty/reject bands, read from project_config (never hardcoded —
 * bands vary per project). 'unavailable' means the project's bands aren't
 * configured yet, not that the rate itself is bad — callers should render
 * that distinctly from an actual reject reading.
 *
 * Only the reject bounds are true rejects; everything between the reject
 * bounds and the bonus bounds is the sliding penalty band, per Table 502-H
 * (there is no explicit third pair of "penalty" thresholds in
 * project_config — the penalty region is simply whatever's left over
 * between reject and bonus).
 */
export function classifyApplicationRateBand(ratePct: number, thresholds: ApplicationRateBandThresholds): ApplicationRateBand {
  const { bonusBandLowPct, bonusBandHighPct, rejectBandLowPct, rejectBandHighPct } = thresholds
  if (bonusBandLowPct === null || bonusBandHighPct === null || rejectBandLowPct === null || rejectBandHighPct === null) {
    return 'unavailable'
  }

  if (ratePct < rejectBandLowPct || ratePct >= rejectBandHighPct) return 'reject'
  if (ratePct >= bonusBandLowPct && ratePct <= bonusBandHighPct) return 'bonus'
  return 'penalty'
}
