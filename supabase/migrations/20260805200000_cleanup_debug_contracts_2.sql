-- =============================================================================
-- NovaCore v1 — Migration 0033: one more stray from the 0031 diagnosis
--
-- Missed by 0032 — the Prefer: return=minimal probe that first isolated the
-- RETURNING-vs-AFTER-INSERT-trigger race also landed a real, non-sandbox
-- row (return=minimal suppresses the response body, so its id wasn't known
-- until queried after the fact). Same shape as 0032: no Items, no Unit
-- Prices, only the auto-enrol baseline.
--
-- Requires migrations through 0032.
-- =============================================================================

delete from public.contracts
where id = '88ae9039-2b6d-4ef1-90c0-88b96aa19135'; -- "return=minimal test"
