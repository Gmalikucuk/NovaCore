-- =============================================================================
-- NovaCore v1 — Migration 0011: rights vocabulary
--
-- 0009 deliberately left the eight per-contract right columns alone, on the
-- grounds that a rename sweep touching everything at once cannot be verified.
-- The schema is now stable and the probe suite is green, so this is the moment.
--
-- Two columns carry words the contract does not use:
--   create_line_items -> create_items    ("line item" is not a MoTT term; an
--                                          Item is an Item)
--   set_bid_rate      -> set_unit_price  (Schedule 7 says Unit Price)
--
-- The other six are internal-process words with no contract equivalent and are
-- correct as they stand: set_cost, enter_quantity, correct_quantity,
-- confirm_quantity, view_rates, extract_report.
--
-- NOTE for whoever applies this: has_right() takes the right name as a STRING
-- and resolves it through format(%I). So the rename does not break the function
-- itself — it breaks every CALL SITE that passes the old string, silently
-- turning them into a raised error rather than a wrong answer (format(%I) on a
-- nonexistent column raises). That is the good failure mode, but it means the
-- policies below must be recreated in the same transaction.
--
-- Pre-apply verification (live schema, checked before this file touched the
-- database): contract_members.create_line_items and .set_bid_rate both exist
-- as boolean columns; exhaustively searched EVERY policy in the database (not
-- just items/item_prices) for the strings 'create_line_items' and
-- 'set_bid_rate' in either USING or WITH CHECK — exactly the 4 policies this
-- file drops and recreates (items_insert_right, items_update_right,
-- item_prices_insert_right, item_prices_update_right) reference them, nothing
-- else does. Current column-level grants to `authenticated` on
-- contract_members already cover INSERT/SELECT/UPDATE on both columns —
-- renaming a column preserves its attnum, so those grants carry across the
-- rename automatically; the UPDATE re-grant below is therefore not strictly
-- required to restore anything, but reissuing it is harmless (GRANT is
-- idempotent) and it's cheap insurance against relying on an assumption about
-- grant-vs-rename behavior that wasn't independently tested here.
-- =============================================================================

alter table public.contract_members
  rename column create_line_items to create_items;

alter table public.contract_members
  rename column set_bid_rate to set_unit_price;

comment on column public.contract_members.create_items is
  'May add or amend Schedule 7 Items on this contract — e.g. an Item added by '
  'change order.';
comment on column public.contract_members.set_unit_price is
  'May set the Schedule 7 Unit Price. Paired with set_cost: both are required '
  'to write item_prices, since the two values share a row and PostgREST cannot '
  'enforce per-column writes.';

-- -----------------------------------------------------------------------------
-- Recreate every policy passing a renamed right
-- -----------------------------------------------------------------------------
drop policy if exists items_insert_right on public.items;
drop policy if exists items_update_right on public.items;

create policy items_insert_right on public.items
  for insert to authenticated
  with check (public.has_right(contract_id, 'create_items'));

create policy items_update_right on public.items
  for update to authenticated
  using (public.has_right(contract_id, 'create_items'))
  with check (public.has_right(contract_id, 'create_items'));

drop policy if exists item_prices_insert_right on public.item_prices;
drop policy if exists item_prices_update_right on public.item_prices;

create policy item_prices_insert_right on public.item_prices
  for insert to authenticated
  with check (public.has_right(contract_id, 'set_cost')
              and public.has_right(contract_id, 'set_unit_price'));

create policy item_prices_update_right on public.item_prices
  for update to authenticated
  using (public.has_right(contract_id, 'set_cost')
         and public.has_right(contract_id, 'set_unit_price'))
  with check (public.has_right(contract_id, 'set_cost')
              and public.has_right(contract_id, 'set_unit_price'));

-- -----------------------------------------------------------------------------
-- The column-level UPDATE grant names the columns explicitly and must be reissued
-- -----------------------------------------------------------------------------
grant update (create_items, set_cost, set_unit_price, enter_quantity,
              correct_quantity, confirm_quantity, view_rates, extract_report)
  on public.contract_members to authenticated;

-- -----------------------------------------------------------------------------
-- Verify after applying:
--
--   select column_name from information_schema.columns
--   where table_name = 'contract_members' and column_name like '%line_item%';
--   -- expect zero rows
--
--   select polname, pg_get_expr(polqual, polrelid),
--          pg_get_expr(polwithcheck, polrelid)
--   from pg_policy where polrelid in
--     ('public.items'::regclass, 'public.item_prices'::regclass);
--   -- expect no occurrence of 'create_line_items' or 'set_bid_rate'
--
-- Then grep the application and scripts/probe-rls.sh for both old strings.
-- Because has_right() resolves the name at runtime, a missed call site raises
-- rather than silently denying — loud, but only when that code path executes.
-- The probe suite is what makes it execute.
-- =============================================================================
