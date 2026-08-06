-- =============================================================================
-- NovaCore — write access for items.percent_complete / items.authorized_value
--
-- Both columns have existed since 0012 (mott_contract_vocabulary): percent_
-- complete (lump_sum only, items_percent_only_lump_sum) and authorized_value
-- (provisional_sum only, items_provisional_fields_only_provisional). Nothing
-- has ever been able to set either — Tracker already reads them (v_item_
-- progress, no rights gate, since neither column is money by itself), but
-- items_update_right (create_items) is the only UPDATE policy items has, and
-- updateItem() never touches these two columns. This migration adds the
-- write path; the "projected versus actual" brief adds the UI that uses it.
--
-- GATE: set_cost AND set_unit_price — the same right combination Rates'
-- own canEdit already requires for every other figure on that screen (cost,
-- unit price, tender price). Not create_items: entering a percent-complete
-- estimate or an authorization figure is a pricing/finance judgement, not a
-- description edit, and the person who edits an Item's description on this
-- contract is not necessarily the person who prices it (0008 removed roles
-- specifically so these stay independent).
--
-- Same column-grant + policy shape as contracts_state_update_right and
-- item_prices' own policies — an explicit `grant update (...)` on exactly
-- these two columns, not a blanket table grant, so this policy is actually
-- reachable (the documented, still-unfixed bug in the older blanket
-- contracts_update_right policy is exactly what happens without this).
--
-- No new SELECT policy: items_select_member (is_member() only, 0009) already
-- covers reading these two columns, matching Tracker's own existing
-- no-rights-gate posture for the same two fields.
--
-- Tenancy through has_right() only, unchanged. No view involved.
-- =============================================================================

grant update (percent_complete, authorized_value) on public.items to authenticated;

create policy items_earned_fields_update_right on public.items
  for update to authenticated
  using (
    public.has_right(contract_id, 'set_cost')
    and public.has_right(contract_id, 'set_unit_price')
  )
  with check (
    public.has_right(contract_id, 'set_cost')
    and public.has_right(contract_id, 'set_unit_price')
  );

-- =============================================================================
-- Verify —
--
--   -- as a seat holding set_cost + set_unit_price, on a lump_sum Item:
--   update items set percent_complete = 45 where id = '<a sandbox lump_sum item id>';
--   -- expect: succeeds
--
--   -- the existing kind constraint still holds — same seat, a unit_price Item:
--   update items set percent_complete = 45 where id = '<a sandbox unit_price item id>';
--   -- expect: rejected (items_percent_only_lump_sum, unrelated to this migration)
--
--   -- as a seat holding neither right:
--   update items set percent_complete = 10 where id = '<same lump_sum item>';
--   -- expect: 0 rows updated (RLS silently excludes)
--
--   -- authorized_value, provisional_sum Item, same seat:
--   update items set authorized_value = 5000 where id = '<a sandbox provisional_sum item id>';
--   -- expect: succeeds
-- =============================================================================
