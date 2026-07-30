-- Rescued from the old schema's `project_config` table before `drop schema public
-- cascade` (2026-07-30). HIGHEST-VALUE ROW IN THIS RESCUE — the SS 502 Table 502-H
-- bonus/penalty/reject bands and target application/tack-coat rates, deliberately
-- never hardcoded anywhere in the old build's application code (see
-- src/lib/supabase/projectConfig.ts and applicationRateBand.ts in the archived
-- code). Only one row ever existed, for Venables Valley.
insert into project_config (
  id, project_id, target_application_rate_kg_m2, mix_density, lift_thickness_m,
  tack_coat_rate_l_m2, mill_to_pave_days_allowed, shouldering_days_allowed,
  joint_sealant_strategy, joint_sealant_band_width_m, joint_sealant_rate_l_m2,
  stationing_format, bonus_band_low_pct, bonus_band_high_pct,
  reject_band_low_pct, reject_band_high_pct, created_at
) values (
  '5739c1b2-15df-402c-85f2-fe46abe5aa2e', '3aa698cd-755b-485d-bcd7-341baf345b8b',
  124.3500, 2.4870, 0.0500, 0.2600, 7, 10,
  'single_project_closeout', 0.400, 0.4000,
  'lki_station', 96.00, 104.00, 85.00, 110.00, '2026-07-05 21:52:45.82925+00'
);
