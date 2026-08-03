-- =============================================================================
-- NovaCore v1 — Migration 0009: MoTT contract vocabulary
--
-- Renames the schema to the terms the contract itself uses. Sources, all from
-- the 26607-0000 Tender Document Package:
--
--   Schedule 7            "Approximate Quantities and Unit Prices"
--   Schedule 7 headings   Item #, Description, Unit of Measure, Approx Quantity,
--                         Provisional Sum, Unit price, Extended Amount
--   GC 52.00              "PROGRESS PAYMENTS" — the monthly document is a
--                         "progress estimate", prepared by the Ministry
--                         Representative no later than seven days following the
--                         first day of each month; payment is monthly in arrears
--   GC 52.03              distinguishes Unit Price Item, Lump Sum Item and
--                         Provisional Sum Item, each paid on a DIFFERENT basis
--
-- Why bother: the people who will read this system — a PM, an estimator, a
-- Ministry Representative — all speak Schedule 7. Vocabulary that diverges from
-- the contract is where misreadings start, and a misread quantity on a unit
-- price contract is money.
--
-- Renames only. No behaviour changes. Postgres rewrites dependent views,
-- policies and constraints automatically on ALTER ... RENAME, so nothing needs
-- dropping and recreating — but every reference in application code and in the
-- probe suite must be updated by hand.
--
-- Pre-apply verification (live schema, matched against every assumption below
-- before this file touched the database): all 7 renamed columns present under
-- their pre-migration names on all 5 tables; is_member(p_project uuid) and
-- has_right(p_project uuid, p_right text) exist with exactly those signatures;
-- all 3 views (daily_entries_effective, v_line_item_finance,
-- v_line_item_progress) exist and are granted SELECT to `authenticated` only;
-- all 16 policies named in section 7's drop list match the live policy list on
-- the 5 tables exactly, no extras, no gaps; no line_items.unit value contains
-- "lump" or "prov", so the item_kind backfill is inert on current data (every
-- row becomes 'unit_price', correctly); no table outside the known 6
-- (contracts-to-be, contract_members-to-be, items-to-be, item_prices-to-be,
-- quantity_records-to-be, profiles) exists in public, so no other object holds
-- an undocumented FK or dependency into this rename.
--
-- Two corrections made before applying:
--
-- 1. Section 4 originally dropped is_member(uuid) and has_right(uuid, text)
--    before section 7 drops the 16 old policies that call them — the exact
--    dependency-ordering bug 0008 shipped with (member_role() dropped before
--    its dependent policies), which failed there with SQLSTATE 2BP01. Same
--    failure mode would hit here. Fix: no preceding DROP. These two functions
--    keep their name and argument types, so CREATE OR REPLACE alone updates
--    the body in place without ever breaking the old policies' dependency on
--    them mid-migration. The `drop function if exists` lines are removed.
--
-- 2. That first fix was tried with the parameters also renamed p_project ->
--    p_contract for readability, and Postgres rejected it outright:
--    `ERROR: cannot change name of input parameter "p_project" (SQLSTATE
--    42P13)` — CREATE OR REPLACE FUNCTION disallows renaming an existing
--    parameter, full stop, regardless of dependencies. (The push failed
--    cleanly and transactionally, same as 0008's failure — verified nothing
--    partial landed before applying the fix.) Both functions below keep the
--    parameter named p_project; only the function bodies now reference
--    contract_members / contract_id. The parameter name is internal and
--    invisible to every caller (all call sites pass positionally), so this
--    costs nothing — "renames only, no behaviour changes" holds exactly as
--    stated, just not for this one internal label.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
--
-- projects -> contracts. The Ministry awards a Contract with a number
-- (26607-0000); "project" is internal shorthand that appears nowhere in the
-- documents.
-- -----------------------------------------------------------------------------
alter table public.projects        rename to contracts;
alter table public.project_members rename to contract_members;
alter table public.line_items      rename to items;
alter table public.line_item_prices rename to item_prices;
alter table public.daily_entries   rename to quantity_records;

comment on table public.contracts is
  'A Ministry contract, identified by contract_no (e.g. 26607-0000).';
comment on table public.items is
  'A Schedule 7 Item. Kind determines the payment basis under GC 52.03.';
comment on table public.quantity_records is
  'Quantity of Work performed, as recorded by the Contractor. Append-only: a '
  'correction is a new row superseding the old. Note this is the CONTRACTOR''S '
  'record, not the Ministry Representative''s progress estimate — the two are '
  'reconciled, not assumed equal (GC 52.04: progress estimates do not represent '
  'a final determination of quantities).';

-- -----------------------------------------------------------------------------
-- 2. Columns
-- -----------------------------------------------------------------------------
alter table public.contracts        rename column name to contract_name;

alter table public.contract_members rename column project_id to contract_id;
alter table public.items            rename column project_id to contract_id;
alter table public.item_prices      rename column project_id to contract_id;
alter table public.quantity_records rename column project_id to contract_id;

alter table public.items rename column item_no      to item_number;
alter table public.items rename column bid_quantity to approximate_quantity;

alter table public.item_prices rename column sell_price to unit_price;
-- cost_price keeps its name: the Contractor's cost has NO contract vocabulary.
-- The Ministry sees Unit Price only. That asymmetry is precisely why the finance
-- wall exists, and the naming should reflect that these are different worlds.

-- Missing from the migration as drafted: item_prices.line_item_id was never
-- renamed, even though the identical column on quantity_records (below) was.
-- v_item_finance (section 6) joins v_item_progress on p.item_id — that column
-- didn't exist without this, and the push failed with 42703 before this line
-- was added. Same column, same table family, same treatment.
alter table public.item_prices rename column line_item_id to item_id;

alter table public.quantity_records rename column line_item_id to item_id;
alter table public.quantity_records rename column entry_date   to work_date;

comment on column public.items.approximate_quantity is
  'Schedule 7 Approx Quantity. Approximate by contract design: GC 52.03(a) pays '
  'a Unit Price Item on the total quantity of Work actually performed, not on '
  'this figure.';
comment on column public.item_prices.unit_price is
  'Schedule 7 Unit Price — the tendered rate. Extended Amount is '
  'approximate_quantity * unit_price and is derived, never stored.';
comment on column public.item_prices.cost_price is
  'Contractor internal cost per unit. Appears nowhere in the contract; the '
  'Ministry never sees it.';

-- -----------------------------------------------------------------------------
-- 3. Item kind — a real contract concept, not a formatting hint
--
-- GC 52.03 pays each kind on a different basis:
--   (a) Unit Price Item       total quantity of Work performed, less previously
--                             paid
--   (b) Lump Sum Item         PERCENTAGE COMPLETE, less percentage complete on
--                             previous progress estimates
--   (c) Provisional Sum Item  total value of Work AUTHORIZED IN ADVANCE by the
--                             Ministry Representative, less previously paid
--
-- Kind was previously inferred from the unit string ('Lump Sum', 'Prov. Sum'),
-- which is fragile and cannot express (c) at all — a Provisional Sum Item is
-- paid on authorized value, and nothing in the schema records authorization.
--
-- Backfilled from the unit string, which is correct for the data as it stands.
-- -----------------------------------------------------------------------------
alter table public.items
  add column item_kind text not null default 'unit_price'
    check (item_kind in ('unit_price', 'lump_sum', 'provisional_sum'));

update public.items set item_kind =
  case
    when unit ilike '%lump%'        then 'lump_sum'
    when unit ilike '%prov%'        then 'provisional_sum'
    else 'unit_price'
  end;

comment on column public.items.item_kind is
  'GC 52.03 payment basis. unit_price: paid on quantity performed. lump_sum: '
  'paid on percentage complete. provisional_sum: paid on value authorized in '
  'advance by the Ministry Representative.';

-- Percent complete for Lump Sum Items. Null for every other kind — a percentage
-- against a Unit Price Item is meaningless, and quantity_records are the wrong
-- instrument for a Lump Sum Item.
alter table public.items
  add column percent_complete numeric
    check (percent_complete is null
           or (percent_complete >= 0 and percent_complete <= 100));

alter table public.items
  add constraint items_percent_only_lump_sum
  check (percent_complete is null or item_kind = 'lump_sum');

comment on column public.items.percent_complete is
  'GC 52.03(b): a Lump Sum Item is paid on percentage complete as estimated by '
  'the Ministry Representative. Only ever set for lump_sum items.';

-- Provisional Sum Items: the Schedule 7 "Provisional Sum" column, and the
-- authorized-to-date value. GC 47.01: no payment for Work against a Provisional
-- Sum Item without advance authorization.
alter table public.items
  add column provisional_sum numeric check (provisional_sum >= 0),
  add column authorized_value numeric check (authorized_value >= 0);

alter table public.items
  add constraint items_provisional_fields_only_provisional
  check (
    (provisional_sum is null and authorized_value is null)
    or item_kind = 'provisional_sum'
  );

comment on column public.items.provisional_sum is
  'Schedule 7 Provisional Sum column — the allowance (e.g. 150,000.00 for '
  'SP 1.31 Site Modifications).';
comment on column public.items.authorized_value is
  'Value authorized in advance by the Ministry Representative under GC 32.01 / '
  'GC 47.01. Payment cannot exceed this.';

-- -----------------------------------------------------------------------------
-- 4. Functions
--
-- CREATE OR REPLACE only — no preceding DROP. Both functions keep their name
-- and argument types (the p_project -> p_contract rename below is a parameter
-- label only, invisible to callers), so REPLACE updates the body in place
-- without ever breaking the old policies' dependency on them mid-migration.
-- See the note at the top of this file for why the drop-first version (as
-- originally drafted) would have failed.
--
-- THE STANDING RULE IS UNCHANGED: the tenancy boundary and every right are
-- expressed ONLY through these functions. No policy, view or query may inline a
-- subquery against contract_members.
-- -----------------------------------------------------------------------------
create or replace function public.is_member(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.contract_members
    where contract_id = p_project and user_id = auth.uid()
  );
$$;

create or replace function public.has_right(p_project uuid, p_right text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ok boolean;
begin
  execute format(
    'select coalesce(bool_or(%I), false) from public.contract_members
      where contract_id = $1 and user_id = $2',
    p_right
  )
  into ok
  using p_project, auth.uid();
  return ok;
end;
$$;

-- has_global_right() reads profiles only; unaffected by the rename.

-- -----------------------------------------------------------------------------
-- 5. Trigger functions referencing renamed objects
-- -----------------------------------------------------------------------------
create or replace function public.enrol_global_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.contract_members
    (contract_id, user_id, view_rates, extract_report)
  select new.id, p.id, true, true
  from public.profiles p
  where p.global_role is not null
  on conflict (contract_id, user_id) do nothing;
  return new;
end;
$$;

create or replace function public.check_supersede_target()
returns trigger
language plpgsql
as $$
declare
  parent record;
begin
  if new.supersedes is null then
    return new;
  end if;

  select contract_id, item_id into parent
  from public.quantity_records
  where id = new.supersedes;

  if not found then
    raise exception 'supersedes target % does not exist', new.supersedes;
  end if;

  if parent.contract_id <> new.contract_id or parent.item_id <> new.item_id then
    raise exception
      'a correction must replace a record on the same contract and Item';
  end if;

  return new;
end;
$$;

create or replace function public.guard_entry_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'confirmed' and new.status = 'draft' then
    raise exception
      'a confirmed record cannot be un-confirmed; supersede it instead';
  end if;

  if row(new.contract_id, new.item_id, new.work_date, new.quantity,
         new.location, new.note, new.supersedes, new.created_by, new.device_id,
         new.station_from, new.station_to)
     is distinct from
     row(old.contract_id, old.item_id, old.work_date, old.quantity,
         old.location, old.note, old.supersedes, old.created_by, old.device_id,
         old.station_from, old.station_to)
  then
    raise exception
      'quantity_records are append-only; correct by inserting a superseding row';
  end if;

  if old.status = 'draft' and new.status = 'confirmed' then
    new.confirmed_by := auth.uid();
    new.confirmed_at := now();
  end if;

  if old.status = 'confirmed' and new.status = 'confirmed' then
    new.confirmed_by := old.confirmed_by;
    new.confirmed_at := old.confirmed_at;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Views
-- -----------------------------------------------------------------------------
drop view if exists public.v_line_item_finance;
drop view if exists public.v_line_item_progress;
drop view if exists public.daily_entries_effective;

-- security_invoker = on so RLS applies to the CALLER. Without it these views are
-- a hole straight through every policy.
create view public.quantity_records_effective
with (security_invoker = on) as
select r.*
from public.quantity_records r
where r.status = 'confirmed'
  and not exists (
    select 1 from public.quantity_records c
    where c.supersedes = r.id and c.status = 'confirmed'
  );

comment on view public.quantity_records_effective is
  'A record counts when it is confirmed AND has no CONFIRMED successor. '
  'Supersession takes effect on confirmation, not insertion — otherwise a '
  'correction awaiting review removes quantity from the totals while its '
  'replacement has not yet entered them, and the figures are silently wrong '
  'during exactly the review that prompted the correction.';

create view public.v_item_progress
with (security_invoker = on) as
select
  i.id          as item_id,
  i.contract_id,
  i.item_number,
  i.description,
  i.unit,
  i.item_kind,
  i.approximate_quantity,
  i.percent_complete,
  i.provisional_sum,
  i.authorized_value,
  coalesce(sum(r.quantity), 0) as quantity_to_date,
  case
    when i.item_kind = 'lump_sum' then i.percent_complete / 100.0
    when i.approximate_quantity > 0
      then coalesce(sum(r.quantity), 0) / i.approximate_quantity
  end as proportion_complete,
  count(r.id)      as record_count,
  max(r.work_date) as last_work_date
from public.items i
left join public.quantity_records_effective r on r.item_id = i.id
group by i.id;

create view public.v_item_finance
with (security_invoker = on) as
select
  p.item_id,
  p.contract_id,
  p.cost_price,
  p.unit_price,
  prog.quantity_to_date,
  prog.approximate_quantity * p.unit_price       as extended_amount,
  prog.quantity_to_date * p.cost_price           as cost_to_date,
  prog.quantity_to_date * p.unit_price           as value_of_work_to_date,
  prog.quantity_to_date * (p.unit_price - p.cost_price) as margin,
  case
    when p.unit_price > 0 then (p.unit_price - p.cost_price) / p.unit_price
  end as margin_proportion
from public.item_prices p
join public.v_item_progress prog on prog.item_id = p.item_id;

comment on view public.v_item_finance is
  'value_of_work_to_date is quantity recorded x Unit Price: the Contractor''s '
  'internal expectation. It is NOT a progress estimate and NOT an amount the '
  'Ministry has approved. GC 52.01 places the progress estimate with the '
  'Ministry Representative; GC 52.04 states progress estimates are not a final '
  'determination of quantities.';

grant select on public.quantity_records_effective to authenticated;
grant select on public.v_item_progress           to authenticated;
grant select on public.v_item_finance            to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Policies
--
-- ALTER TABLE ... RENAME carries policies across, but their names and internal
-- column references now read wrong. Dropped and recreated so the schema says
-- what it means.
-- -----------------------------------------------------------------------------
drop policy if exists projects_select_member  on public.contracts;
drop policy if exists projects_insert_right   on public.contracts;
drop policy if exists projects_update_right   on public.contracts;
drop policy if exists project_members_select  on public.contract_members;
drop policy if exists members_insert_right    on public.contract_members;
drop policy if exists members_update_right    on public.contract_members;
drop policy if exists members_remove_right    on public.contract_members;
drop policy if exists line_items_select_member on public.items;
drop policy if exists line_items_insert_right  on public.items;
drop policy if exists line_items_update_right  on public.items;
drop policy if exists prices_select_right     on public.item_prices;
drop policy if exists prices_insert_right     on public.item_prices;
drop policy if exists prices_update_right     on public.item_prices;
drop policy if exists entries_select_member   on public.quantity_records;
drop policy if exists entries_insert_right    on public.quantity_records;
drop policy if exists entries_confirm_right   on public.quantity_records;

create policy contracts_select_member on public.contracts
  for select to authenticated using (public.is_member(id));

create policy contracts_insert_right on public.contracts
  for insert to authenticated
  with check (created_by = auth.uid()
              and public.has_global_right('create_projects'));

create policy contracts_update_right on public.contracts
  for update to authenticated
  using (public.has_global_right('manage_members'))
  with check (public.has_global_right('manage_members'));

create policy contract_members_select on public.contract_members
  for select to authenticated using (public.is_member(contract_id));

create policy contract_members_insert_right on public.contract_members
  for insert to authenticated
  with check (public.has_global_right('manage_members'));

create policy contract_members_update_right on public.contract_members
  for update to authenticated
  using (public.has_global_right('manage_members'))
  with check (public.has_global_right('manage_members'));

create policy contract_members_remove_right on public.contract_members
  for delete to authenticated
  using (public.has_global_right('manage_members'));

create policy items_select_member on public.items
  for select to authenticated using (public.is_member(contract_id));

create policy items_insert_right on public.items
  for insert to authenticated
  with check (public.has_right(contract_id, 'create_line_items'));

create policy items_update_right on public.items
  for update to authenticated
  using (public.has_right(contract_id, 'create_line_items'))
  with check (public.has_right(contract_id, 'create_line_items'));

-- THE FINANCE WALL. item_prices is a separate table precisely so that a seat
-- without view_rates cannot reach a Unit Price or a cost by ANY query shape.
create policy item_prices_select_right on public.item_prices
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates'));

create policy item_prices_insert_right on public.item_prices
  for insert to authenticated
  with check (public.has_right(contract_id, 'set_cost')
              and public.has_right(contract_id, 'set_bid_rate'));

create policy item_prices_update_right on public.item_prices
  for update to authenticated
  using (public.has_right(contract_id, 'set_cost')
         and public.has_right(contract_id, 'set_bid_rate'))
  with check (public.has_right(contract_id, 'set_cost')
              and public.has_right(contract_id, 'set_bid_rate'));

create policy quantity_records_select_member on public.quantity_records
  for select to authenticated using (public.is_member(contract_id));

create policy quantity_records_insert_right on public.quantity_records
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      (supersedes is null     and public.has_right(contract_id, 'enter_quantity'))
      or
      (supersedes is not null and public.has_right(contract_id, 'correct_quantity'))
    )
  );

create policy quantity_records_confirm_right on public.quantity_records
  for update to authenticated
  using (public.has_right(contract_id, 'confirm_quantity'))
  with check (public.has_right(contract_id, 'confirm_quantity'));

-- =============================================================================
-- 8. NOT RENAMED — deliberately, and worth knowing why
--
-- The eight per-project right columns keep their current names
-- (create_line_items, set_bid_rate, ...) even though "line item" and "bid rate"
-- are now the wrong words. Renaming them means rewriting has_right() call sites
-- in both SQL and TypeScript in the same migration that renames five tables,
-- and a rename sweep that touches everything at once is a rename sweep nobody
-- can verify. Do it as its own migration afterwards, with the probe suite green
-- on both sides of it.
--
-- 9. AFTER THIS MIGRATION
--
-- Every reference in application code and in scripts/probe-rls.sh is now broken.
-- Nothing is subtle about the failure — Postgres returns 42703 on the missing
-- columns — but it is comprehensive. Rewrite both, then run the full probe
-- suite before trusting anything.
--
-- UI vocabulary to match: Item, Item #, Description, Unit of Measure,
-- Approximate Quantity, Unit Price, Extended Amount, Quantity to Date,
-- progress estimate. Not: line item, bid quantity, sell price, monthly report.
-- =============================================================================
