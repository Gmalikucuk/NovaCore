-- =============================================================================
-- NovaCore v1 — Migration 0024: per_unit cost_basis is structurally
-- unavailable to a Lump Sum/Provisional Sum Item
--
-- 0023 left this to the UI alone ("per unit shouldn't be offered" — an
-- offering is a UI concept). On reflection, while extending
-- scripts/probe-rls.sh for 0023's new reachable surface: the exact
-- item_kind-lookup-against-items pattern the write policy already uses (to
-- decide whether set_unit_price is required) closes this gap at no extra
-- cost — a Lump Sum Item has no quantity to be a rate against, so a
-- per_unit basis on one isn't just unoffered, it's meaningless, the same
-- category of thing pinned_items already refuses to let a non-unit_price
-- Item have (0015). Belt and braces, not UI-only, same posture as
-- everything else in this file.
--
-- Tenancy unchanged: is_member()/has_right() only. The item_kind check
-- queries `items`, a referential-correctness check same as 0023's own,
-- not a tenancy check.
--
-- Requires migrations through 0023.
-- =============================================================================

drop policy if exists item_prices_insert_right on public.item_prices;
drop policy if exists item_prices_update_right on public.item_prices;

create policy item_prices_insert_right on public.item_prices
  for insert to authenticated
  with check (
    public.has_right(contract_id, 'set_cost')
    and (
      public.has_right(contract_id, 'set_unit_price')
      or not exists (
        select 1 from public.items i
        where i.id = item_prices.item_id
          and i.contract_id = item_prices.contract_id
          and i.item_kind = 'unit_price'
      )
    )
    and (
      cost_basis is distinct from 'per_unit'
      or exists (
        select 1 from public.items i
        where i.id = item_prices.item_id
          and i.contract_id = item_prices.contract_id
          and i.item_kind = 'unit_price'
      )
    )
  );

create policy item_prices_update_right on public.item_prices
  for update to authenticated
  using (
    public.has_right(contract_id, 'set_cost')
    and (
      public.has_right(contract_id, 'set_unit_price')
      or not exists (
        select 1 from public.items i
        where i.id = item_prices.item_id
          and i.contract_id = item_prices.contract_id
          and i.item_kind = 'unit_price'
      )
    )
  )
  with check (
    public.has_right(contract_id, 'set_cost')
    and (
      public.has_right(contract_id, 'set_unit_price')
      or not exists (
        select 1 from public.items i
        where i.id = item_prices.item_id
          and i.contract_id = item_prices.contract_id
          and i.item_kind = 'unit_price'
      )
    )
    and (
      cost_basis is distinct from 'per_unit'
      or exists (
        select 1 from public.items i
        where i.id = item_prices.item_id
          and i.contract_id = item_prices.contract_id
          and i.item_kind = 'unit_price'
      )
    )
  );

-- =============================================================================
-- Verify —
--
--   -- as a seat holding set_cost + set_unit_price, on a Lump Sum Item:
--   insert into item_prices (item_id, contract_id, cost_price, cost_basis)
--   values ('<a lump_sum item id>', '<contract>', 10, 'per_unit');
--   -- expect: rejected (WITH CHECK failure) — per_unit is not offered to,
--   -- and not writable for, a Lump Sum/Provisional Sum Item
--
--   -- same Item, cost_basis = 'total':
--   -- expect: succeeds, exactly as 0023 intended
-- =============================================================================
