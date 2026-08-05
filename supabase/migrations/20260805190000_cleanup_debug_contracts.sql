-- =============================================================================
-- NovaCore v1 — Migration 0032: clean up contracts created while diagnosing
-- the 0031 RETURNING race
--
-- Isolating the bug fixed by 0031 required inserting real (non-fixture)
-- rows directly against the live database to reproduce it outside the
-- probe's own fixed-id PROBE-ADMIN contract — four of them landed for
-- real, three with is_sandbox = false (the column's own default, never
-- explicitly set during that diagnosis): "probe minimal readonly",
-- "diag test" (x2), and one with is_sandbox = true ("post-fix
-- representation test") confirming the fix. None carry Items, Unit Prices,
-- or any real data — only the auto-enrol trigger's own baseline grants and,
-- for the two "diag test" rows, the creator's create_items. Cascade removes
-- their contract_members rows along with them; nothing else references
-- them.
--
-- Requires migrations through 0031.
-- =============================================================================

delete from public.contracts
where id in (
  'dac282d4-5b8d-42f9-a071-5576c7bddd36', -- "probe minimal readonly"
  'a6e451b3-6613-4286-b787-394f213839ea', -- "diag test"
  '3456aaf4-8386-4144-ba2f-6f86e3681f15', -- "diag test"
  'f2538a81-dee2-4af3-92cf-b12e25f41c7a'  -- "post-fix representation test"
);
