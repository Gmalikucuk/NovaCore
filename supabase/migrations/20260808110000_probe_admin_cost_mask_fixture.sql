-- NovaCore v1 — Migration 0045: a priced item on PROBE-ADMIN-0000 for the
-- cost tracking mask probes (0044)
--
-- The negative case for 0044's mask (a seat holding view_rates but NOT
-- set_cost, on a contract with cost_tracking_enabled = false, requesting a
-- REAL priced item) has no home among the five existing probe-rls.sh
-- fixtures: checked every project each of the five is seated on, and none
-- combines (view_rates, no set_cost) with a priced item. readonly
-- (owner@novacore.test) already holds exactly (view_rates: true, set_cost:
-- false) on PROBE-ADMIN-0000 — the "do not use" fixture reserved for
-- exactly this kind of guard/edge-case exercise (see 0037's guard-trigger
-- fixtures on the same project) — it simply has no priced item to test
-- against; both its items (GUARD.01/GUARD.02) currently have no
-- item_prices row at all.
--
-- GUARD.01 (lump_sum) is priced here — cost_basis 'total', matching the
-- established convention for lump_sum Items (item_prices_cost_basis_
-- matches_value, 0023: the stored figures ARE the extended figures, never
-- scaled by quantity). Values are arbitrary, round numbers, matching the
-- PROBE-00N fixtures' own style — nothing about the specific figures is
-- load-bearing, only their presence and that cost_price is non-null.
insert into public.item_prices (item_id, contract_id, cost_price, cost_basis, unit_price)
values ('deadbeef-0000-0000-0000-0000000000a1', 'ba5eba11-0000-0000-0000-000000000000', 100, 'total', 200)
on conflict (item_id) do update set cost_price = excluded.cost_price, cost_basis = excluded.cost_basis, unit_price = excluded.unit_price;
