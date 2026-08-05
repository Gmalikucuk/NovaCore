-- =============================================================================
-- NovaCore v1 — Migration 0026: viewer gains set_cost on the sandbox
-- contract only — the fixture 0023/0024 actually need
--
-- No existing fixture holds set_cost WITHOUT set_unit_price: quantities/
-- correct_only/readonly hold neither, full holds both. 0023's real change —
-- a Lump Sum/Provisional Sum Item's cost is writable with set_cost ALONE,
-- unlike a Unit Price Item, which still needs both — has no seat that can
-- isolate it: proving it with `full` would only prove the write is
-- reachable, not that set_unit_price was the thing NOT required, since full
-- has that too.
--
-- Granting viewer (cfo@novacore.test) set_cost on the sandbox contract only
-- creates exactly that seat, permanently, without a new auth account (this
-- repo's own README documents why hand-creating one is fiddly and easy to
-- get subtly wrong) and without disturbing viewer's existing role in this
-- suite: viewer's PRE-EXISTING "update item_prices rejected" probe targets
-- LINE_ITEM_ID, a unit_price Item — under the new policy that still
-- requires set_unit_price, which viewer still lacks, so that check's
-- outcome (rejected) is unchanged. This grant only opens a door on a
-- Lump Sum/Provisional Sum Item specifically, which is exactly the new
-- surface worth proving.
--
-- Requires migrations through 0025.
-- =============================================================================

update public.contract_members
set set_cost = true
where contract_id = 'c0ffee00-c0de-0000-0000-000000000000'
  and user_id = 'dffa8cc9-f5e8-4ac8-b83d-e7bb9f30beb3';

-- Verify:
--
--   select set_cost, set_unit_price, view_rates from contract_members
--   where contract_id = 'c0ffee00-c0de-0000-0000-000000000000'
--     and user_id = 'dffa8cc9-f5e8-4ac8-b83d-e7bb9f30beb3';
--   -- expect set_cost = true, set_unit_price = false, view_rates = true
-- =============================================================================
