-- =============================================================================
-- NovaCore v1 — Migration: fix contract_force_account_terms' percent
-- convention — fractions to raw numbers
--
-- BUG CLASS, caught before it repeated: 20260816160000 built
-- contract_force_account_terms' *_pct columns as fractions (0.30 meaning
-- 30%), the one table in the whole schema that does — every other percent
-- column (contracts.holdback_percent/gst_percent, progress_estimate_items.
-- claimed_percent/certified_percent, item_application_rate_targets.
-- band_low_percent/band_high_percent, payroll_additive_rates.percent,
-- tool_allowance_rates.percent) stores the raw number (30 meaning 30%),
-- divided by 100 wherever it's actually multiplied. Both conventions work
-- in isolation. Together, on a schema where a person moving between tables
-- has no way to tell which is which without reading the code, they are
-- exactly the shape of the 100x payroll-additive bug caught live in
-- 18fc778 (dwrCalculations.ts silently treated a raw 32 as 0.32). This
-- migration removes the one outlier rather than leave a second copy of
-- that trap sitting in the schema.
--
-- CONFIRMED SAFE: queried the live table before writing this file — one
-- row exists, on the PROBE sandbox contract (c0ffee00-c0de-0000-0000-
-- 000000000000, effective_date 2026-01-01), inserted by probe-rls.sh's own
-- fixture. No real contract has ever had a row here. This migration would
-- not run — would stop instead — if that were not true.
--
-- WHAT CHANGES
--   - Every existing row's twelve *_pct values multiplied by 100 in place
--     (0.30 becomes 30 — the same 30%, now expressed the schema's way).
--   - reduced_threshold_pct's default: 0.25 -> 25.
--   - A new range check (0-100) on all twelve columns — the same
--     defensive constraint holdback_percent/gst_percent already have,
--     and the exact thing that would have caught 18fc778's bug at the
--     database layer the moment a 0.32 was typed where a 32 belonged.
--   - subcontractor_cap_amount is untouched — a dollar figure, never a
--     percent, was never part of this bug.
--   - The table comment now states the convention explicitly, so the next
--     person adding a percent column here does not have to grep for
--     precedent (see the comment itself for the exact wording, mirrored in
--     dwrCalculations.ts at the one place these columns are actually
--     multiplied).
--
-- App-layer half of this fix lands in the same change as this migration:
-- dwrCalculations.ts divides every *_pct read by 100 before using it as a
-- multiplier (a new pctToFraction() helper, one call site per column),
-- and probe-rls.sh's own fixture insert is updated to the new convention
-- (30, not 0.30) so it keeps meaning what it always meant.
--
-- Requires migrations through 20260816200000.
-- =============================================================================

do $$
declare
  v_non_probe_rows int;
begin
  select count(*) into v_non_probe_rows
  from public.contract_force_account_terms
  where contract_id <> 'c0ffee00-c0de-0000-0000-000000000000';

  if v_non_probe_rows > 0 then
    raise exception
      'contract_force_account_terms has % row(s) outside the PROBE sandbox contract — this migration assumed none existed and must not run against real data unexamined.',
      v_non_probe_rows;
  end if;
end $$;

update public.contract_force_account_terms
set labour_basic_pct         = labour_basic_pct * 100,
    labour_reduced_pct       = labour_reduced_pct * 100,
    equipment_basic_pct      = equipment_basic_pct * 100,
    equipment_reduced_pct    = equipment_reduced_pct * 100,
    materials_basic_pct      = materials_basic_pct * 100,
    materials_reduced_pct    = materials_reduced_pct * 100,
    prep_basic_pct           = prep_basic_pct * 100,
    prep_reduced_pct         = prep_reduced_pct * 100,
    food_basic_pct           = food_basic_pct * 100,
    food_reduced_pct         = food_reduced_pct * 100,
    subcontractor_markup_pct = subcontractor_markup_pct * 100,
    reduced_threshold_pct    = reduced_threshold_pct * 100;

alter table public.contract_force_account_terms
  alter column reduced_threshold_pct set default 25;

alter table public.contract_force_account_terms
  add constraint contract_force_account_terms_pct_range check (
    labour_basic_pct         between 0 and 100 and
    labour_reduced_pct       between 0 and 100 and
    equipment_basic_pct      between 0 and 100 and
    equipment_reduced_pct    between 0 and 100 and
    materials_basic_pct      between 0 and 100 and
    materials_reduced_pct    between 0 and 100 and
    prep_basic_pct           between 0 and 100 and
    prep_reduced_pct         between 0 and 100 and
    food_basic_pct           between 0 and 100 and
    food_reduced_pct         between 0 and 100 and
    subcontractor_markup_pct between 0 and 100 and
    reduced_threshold_pct    between 0 and 100
  );

comment on table public.contract_force_account_terms is
  'GC 49.00''s markup percentages as THIS CONTRACT''S own GC/SGC package '
  'actually sets them, at a point in time — proven contract-specific, not '
  'province-wide, by reading two real DWRs from two different contracts '
  'with different reduced-markup figures. Resolved via asOfDate(work_date), '
  'same discipline as every other cost register history table — a DWR '
  'reads the terms current as at ITS work date, never today''s. '
  'reduced_threshold_pct (GC 49.04-49.05''s 25%-of-Tender-Price trigger) '
  'and subcontractor_cap_amount (GC 49.03(f)(iii)''s $100,000 cap) default '
  'to the GC''s own current published figures but are per-contract in case '
  'a future SGC amends either. '
  'PERCENT CONVENTION (20260816210000, after a real 100x bug): every '
  '*_pct column here is a RAW NUMBER — 30 means 30%, not 0.30. Same '
  'convention as contracts.holdback_percent/gst_percent, '
  'payroll_additive_rates.percent, tool_allowance_rates.percent, and '
  'progress_estimate_items.claimed_percent/certified_percent — the only '
  'convention used anywhere else in this schema. Divide by 100 at the '
  'point of use (dwrCalculations.ts''s pctToFraction()), never store the '
  'divided value. subcontractor_cap_amount is a dollar figure, not a '
  'percent — exempt from this note.';

-- =============================================================================
-- Verify —
--
--   select contract_id, effective_date, labour_basic_pct, labour_reduced_pct, reduced_threshold_pct
--   from contract_force_account_terms;
--   -- expect: the PROBE row now reads labour_basic_pct=30, labour_reduced_pct=20,
--   -- reduced_threshold_pct=25 (was 0.30, 0.20, 0.25)
--
--   insert into contract_force_account_terms
--     (contract_id, effective_date, gc_version_date, labour_basic_pct, labour_reduced_pct,
--      equipment_basic_pct, equipment_reduced_pct, materials_basic_pct, materials_reduced_pct,
--      prep_basic_pct, prep_reduced_pct, food_basic_pct, food_reduced_pct, subcontractor_markup_pct)
--   values ('c0ffee00-c0de-0000-0000-000000000000', '2099-01-01', '2026-04-01',
--           0.30, 0.20, 0.15, 0.10, 0.15, 0.15, 0.15, 0.10, 0.15, 0.15, 0.10);
--   -- expect: rejected, contract_force_account_terms_pct_range violated —
--   -- exactly the entry mistake this migration exists to catch at the database
-- =============================================================================
