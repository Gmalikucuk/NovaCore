-- =============================================================================
-- NovaCore v1 — Migration: correct an inaccurate claim in
-- contract_force_account_terms' own table comment
--
-- 20260816210000's table comment claimed the new 0-100 range check would
-- have caught 18fc778's bug "the moment a 0.32 was typed where a 32
-- belonged." That's false, and probe-rls.sh's own test caught it: 0.32 is a
-- legal number between 0 and 100, so a mistyped fraction is indistinguishable
-- from a small legitimate percent by range alone. The range check only
-- catches a genuinely out-of-range value (130, -5) — a different, narrower
-- guarantee than the comment claimed.
--
-- This migration re-issues the table comment with that sentence corrected.
-- No column, constraint, or data change — comment only.
--
-- Requires migrations through 20260816210000.
-- =============================================================================

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
  'percent — exempt from this note. '
  'The 0-100 range check below guards against a genuinely out-of-range '
  'entry (130, -5) — it does NOT and cannot catch a mistyped fraction '
  '(0.30 where 30 belonged), since 0.30 is itself a legal value in range. '
  'The convention is enforced by this comment and by review, not by a '
  'constraint the database can fully express.';

-- =============================================================================
-- Verify —
--
--   select obj_description('public.contract_force_account_terms'::regclass);
--   -- expect: the corrected comment, ending in the "not by a constraint..." sentence
-- =============================================================================
