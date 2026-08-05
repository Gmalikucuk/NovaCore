-- =============================================================================
-- NovaCore v1 — Migration 0027: restore v_item_finance's SELECT grant
--
-- 0023 dropped and recreated v_item_finance (needed to insert cost_basis in
-- the middle of the column list — CREATE OR REPLACE VIEW only permits
-- appending at the end). DROP VIEW removes every grant on the object along
-- with it; the recreate never reissued `grant select ... to authenticated`,
-- silently turning "restricted to unit_price Items, readable per the
-- finance wall" into "unreadable by anyone at all" — caught by
-- scripts/probe-rls.sh itself (a pre-existing regression check, "quantities:
-- v_item_finance", started failing with `permission denied for view`
-- instead of its expected empty result once this section of the suite
-- reached it, since a full DENY reads very differently from RLS excluding
-- every row).
--
-- Requires migrations through 0026.
-- =============================================================================

grant select on public.v_item_finance to authenticated;

-- Verify:
--
--   select has_table_privilege('authenticated', 'v_item_finance', 'SELECT');
--   -- expect true
-- =============================================================================
