-- =============================================================================
-- NovaCore v1 — Migration 0025: a Lump Sum Item on the sandbox contract
--
-- 0023/0024 make Lump Sum/Provisional Sum Items costable — but the sandbox
-- (PROBE) contract has never had one: every non-unit_price Item quantities
-- can see lives on Hwy 5 (a real contract), which the standing rule in
-- README.md now forbids writing to for verification. Without a Lump Sum
-- Item ON the sandbox contract, scripts/probe-rls.sh has nowhere to
-- exercise the new cost-write surface without breaking that rule. One
-- fixed-id Item, matching the existing PROBE-00N naming and the
-- fixed-mnemonic-id convention (0006) so a query result is recognizable
-- without a join.
--
-- Requires migrations through 0024.
-- =============================================================================

-- PROBE-001 through PROBE-005 are already taken (PROBE-004/005 seeded later
-- by an unrelated migration under generated, non-mnemonic ids) — PROBE-LS-001
-- avoids the collision while staying obviously part of the same family.
insert into public.items (id, contract_id, item_number, description, unit, approximate_quantity, item_kind)
values (
  'c0ffee00-c0de-0000-0000-000000000004',
  'c0ffee00-c0de-0000-0000-000000000000',
  'PROBE-LS-001',
  'Test mobilization (Lump Sum)',
  'Lump Sum',
  0,
  'lump_sum'
)
on conflict (id) do nothing;

-- Verify:
--
--   select id, item_number, item_kind, approximate_quantity
--   from items where id = 'c0ffee00-c0de-0000-0000-000000000004';
-- =============================================================================
