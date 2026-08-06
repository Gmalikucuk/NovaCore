-- =============================================================================
-- NovaCore — item_prices history
--
-- Tag deployed commit first, per the brief.
--
-- WHAT HAPPENED
--
-- A bulk load of Hwy 5's 48 unit prices nulled cost_price on three Items,
-- because the writing path never read back the columns it wasn't setting.
-- Nothing in the database recorded that it happened. It was found only by
-- chance — a subtitle count changed from 7 to 4 — and the previous values
-- are gone for good. item_prices has updated_by/updated_at (who touched it
-- last, stamp_price_update()) but no record of what it overwrote.
--
-- CHANGE LOG, NOT FULL HISTORY — chosen over the alternative, argued below
--
-- Two shapes were on the table: full history (a row per change, current
-- value read from the latest — quantity_records' own shape) or a change log
-- (item_prices stays the current value; a separate append-only table
-- records what every change replaced).
--
-- item_prices is a lookup table, not an event log. Every screen that reads
-- a price — Rates on every render, v_item_finance, v_contract_month,
-- v_item_actual_cost, the exports — wants "the current cost/unit price for
-- this item", one row per item, and gets it today from a table whose
-- primary key IS item_id. quantity_records earns its append-only shape
-- because every row is independently meaningful: a stretch placed on a
-- date is a fact that stays true forever, and "current total" is a SUM
-- over facts. A price has no equivalent per-row meaning — a superseded
-- rate isn't a fact that contributed to anything, it's just wrong now.
-- Converting item_prices to full-history would force every one of those
-- read paths to resolve "latest row per item" before they could do
-- anything else, for a table that is joined, viewed, and exported more
-- than almost anything else in this schema. That is a materially bigger
-- change than the brief's "no change to how Rates reads or writes prices
-- in the normal path" allows, for no reader-facing benefit — nobody reads
-- item_prices to see its history, they read it to see the number.
--
-- A change log gets the same protection — a destructive overwrite becomes
-- visible and recoverable after the fact — without moving the read path at
-- all. item_prices keeps meaning exactly what it means today; this table
-- only ever gets read when someone is specifically asking "what did this
-- used to be", which is rare and always deliberate.
--
-- CAPTURING NULL — the actual failure mode
--
-- The trigger below logs both old_* and new_* on every real change,
-- including a value going from something to null. That is not a special
-- case in the trigger — row(...) IS DISTINCT FROM row(...) already treats
-- value -> null as a change like any other — but it is the entire reason
-- this migration exists, so it gets its own probe (scripts/probe-rls.sh)
-- rather than trusting the general case implicitly.
--
-- THE READ-BACK GUARD (brief's "Also" section) — NOT IMPLEMENTED HERE
--
-- commitRate() already reads back the existing cost before calling
-- upsertItemPrice specifically to avoid clobbering; that guarantee lives in
-- the app, and the bulk-load path that caused the incident bypassed it by
-- not going through commitRate at all. Moving the read-back into a
-- database trigger/function would make the guarantee hold regardless of
-- caller — but it is a materially different, higher-stakes change than
-- this one: a plain `UPDATE item_prices SET cost_price = null` is
-- indistinguishable at the SQL level between the accidental case (the
-- actual bug) and a legitimate one (RatesScreen's own changeBasis() clears
-- cost_price on purpose when a basis changes and the old figure no longer
-- applies). A passive log can't get that wrong — it just records what
-- happened. A guard that silently refuses or silently re-fills a null
-- WOULD get it wrong, for the second case, on every intentional clear that
-- exists today. Per the brief: reported, not built. Needs its own decision
-- about how a legitimate clear is supposed to look before it's safe to
-- write.
--
-- SHAPE
--
-- item_price_history: one row per real change to cost_price, cost_basis,
-- or unit_price on item_prices — insert or update, old_* null on the very
-- first row for an item (nothing existed before). No row is written when
-- an update touches item_prices without actually changing any of the three
-- tracked columns (row(...) IS DISTINCT FROM row(...) below) — re-saving
-- unchanged values isn't a change worth logging.
--
-- log_item_price_change(): security definer + set search_path = public,
-- the same convention every trigger function in this schema follows
-- (guard_entry_transitions(), stamp_price_update(), and others) — needed
-- here for a different reason than usual: item_price_history has NO direct
-- insert/update/delete grant to authenticated at all, so the only way a
-- row ever gets written is this function running as its owner, regardless
-- of who or what triggered item_prices' own change. No caller, app-level
-- or otherwise, can bypass the log the way the bulk load bypassed
-- commitRate's read-back.
--
-- RLS: item_price_history is finance data — reading it requires the same
-- view_rates right that reading a price does, mirrored directly from
-- item_prices_select_right (0009). No insert/update/delete policy exists
-- for authenticated at all; the table is trigger-write-only.
--
-- Tenancy through is_member()/has_right() only, unchanged. No view
-- involved, so security_invoker doesn't apply here.
-- =============================================================================

create table public.item_price_history (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null,
  contract_id    uuid not null,
  changed_at     timestamptz not null default now(),
  changed_by     uuid references public.profiles(id),
  old_cost_price numeric,
  new_cost_price numeric,
  old_cost_basis text,
  new_cost_basis text,
  old_unit_price numeric,
  new_unit_price numeric,
  foreign key (item_id, contract_id)
    references public.items (id, contract_id) on delete cascade
);

create index item_price_history_item_idx
  on public.item_price_history (item_id, changed_at desc);

comment on table public.item_price_history is
  'Append-only log of every real change to item_prices.cost_price, '
  'cost_basis, or unit_price — written only by log_item_price_change() '
  '(security definer), never directly. old_* is null on an item''s first '
  'priced row (nothing existed before); a value replaced by null is '
  'recorded like any other change, which is the case that motivated this '
  'table (a bulk load once nulled three Items'' cost_price with nothing '
  'anywhere recording it happened).';

-- -----------------------------------------------------------------------------
-- Trigger — logs INSERT unconditionally (old_* stays null, there is nothing
-- to compare against) and UPDATE only when a tracked column actually
-- changed, same row(...) IS DISTINCT FROM row(...) scoped-change pattern
-- guard_entry_transitions() already uses for multi-column comparisons.
-- -----------------------------------------------------------------------------
create or replace function public.log_item_price_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.item_price_history
      (item_id, contract_id, changed_by,
       old_cost_price, new_cost_price,
       old_cost_basis, new_cost_basis,
       old_unit_price, new_unit_price)
    values
      (new.item_id, new.contract_id, auth.uid(),
       null, new.cost_price,
       null, new.cost_basis,
       null, new.unit_price);
    return new;
  end if;

  if row(new.cost_price, new.cost_basis, new.unit_price)
     is distinct from
     row(old.cost_price, old.cost_basis, old.unit_price) then
    insert into public.item_price_history
      (item_id, contract_id, changed_by,
       old_cost_price, new_cost_price,
       old_cost_basis, new_cost_basis,
       old_unit_price, new_unit_price)
    values
      (new.item_id, new.contract_id, auth.uid(),
       old.cost_price, new.cost_price,
       old.cost_basis, new.cost_basis,
       old.unit_price, new.unit_price);
  end if;

  return new;
end;
$$;

create trigger item_prices_history_log
  after insert or update on public.item_prices
  for each row execute function public.log_item_price_change();

-- -----------------------------------------------------------------------------
-- RLS — same visibility as a price, no write surface for authenticated at all
-- -----------------------------------------------------------------------------
alter table public.item_price_history enable row level security;

revoke all on public.item_price_history from anon, authenticated;
grant select on public.item_price_history to authenticated;

create policy item_price_history_select_right on public.item_price_history
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates'));

-- =============================================================================
-- Verify —
--
--   -- change a price on the sandbox, confirm the trigger logged it:
--   update item_prices set cost_price = 71000
--   where item_id = '<a sandbox item id>';
--   select old_cost_price, new_cost_price from item_price_history
--   where item_id = '<same item id>' order by changed_at desc limit 1;
--   -- expect old_cost_price = the previous value, new_cost_price = 71000
--
--   -- null out a cost, confirm the previous value is recoverable:
--   update item_prices set cost_price = null, cost_basis = null
--   where item_id = '<same item id>';
--   select old_cost_price, new_cost_price from item_price_history
--   where item_id = '<same item id>' order by changed_at desc limit 1;
--   -- expect old_cost_price = 71000, new_cost_price = null — this is the
--   -- exact shape of the incident that motivated this migration
--
--   -- a seat without view_rates cannot read the history table:
--   curl "$API/item_price_history?select=*" -H "apikey: $ANON" \
--     -H "Authorization: Bearer <token with no view_rates>"
--   -- expect 200, []
--
--   -- no direct write path exists for anyone:
--   curl -X POST "$API/item_price_history" -H "apikey: $ANON" \
--     -H "Authorization: Bearer <any token>" \
--     -H "Content-Type: application/json" -d '{"item_id":"...","contract_id":"...","new_cost_price":1}'
--   -- expect rejected (no insert grant to authenticated)
-- =============================================================================
