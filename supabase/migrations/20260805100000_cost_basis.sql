-- =============================================================================
-- NovaCore v1 — Migration 0023: cost entered as a total or per unit
--
-- TWO PROBLEMS, RELATED.
--
-- 1. A Lump Sum or Provisional Sum Item has a cost and nowhere to record it.
--    Rates has only ever listed Unit Price Items (cost_price/unit_price are
--    both per-unit figures — meaningless for a Lump Sum, whose quantity is
--    never a real measurement, per GC 52.03(b)/(c), and 0014 deliberately
--    excluded both kinds from the money views for exactly that reason).
--    Mobilization, Quality Management, Traffic Management — real costs,
--    no entry path at all.
--
-- 2. Some Unit Price Items are naturally costed as a total, not a rate. A
--    subcontract quote is a number for the whole scope. Forcing the person
--    to divide it by the Approximate Quantity themselves, and storing only
--    the result, loses the fact that the number was a total — and
--    "approximate" is in the denominator's own name. Spend $80,000 against
--    an Approximate Quantity of 20,000 t, store $4/t, place only 16,000 t:
--    NovaCore reports $64,000 of cost against $80,000 actually spent. The
--    margin reads better than it is, and the Item's own approximation
--    caused it.
--
-- THE FIX: store what was entered, plus the basis it was entered on.
-- cost_basis is 'per_unit' or 'total', recorded alongside cost_price — never
-- silently defaulted, never inferred. A total is an assertion about the
-- whole Item; a rate is an assertion per unit. They are different claims;
-- NovaCore keeps the one actually made and derives the other for DISPLAY
-- only, same rule already applied to variance (0018) and margin (0001) —
-- both computed, never stored.
--
-- Lump Sum and Provisional Sum Items become costable — they have no
-- quantity, so 'total' is the only basis that ever applies to them; nothing
-- here offers 'per_unit' for them (enforced in the UI; the database doesn't
-- need to forbid a state that has no write path to it, but the money views
-- below double-check item_kind anyway rather than trusting cost_basis alone
-- — belt and braces, same posture as every other guard in this schema).
--
-- Absent means nothing entered yet, on EITHER basis — not zero. The
-- consistency check below (cost_price is null) = (cost_basis is null)
-- makes that a structural guarantee, not a convention client code has to
-- remember.
--
-- CONSTRAINTS FOLLOWED
--   - Finance wall unchanged: set_cost to write, view_rates to read.
--     item_prices_insert_right/update_right currently require BOTH set_cost
--     AND set_unit_price (0011 — "the two values share a row and PostgREST
--     cannot enforce per-column writes"). That reasoning holds for a Unit
--     Price Item, where unit_price is a real, relevant column. It does NOT
--     hold for a Lump Sum/Provisional Sum Item, which never has a
--     unit_price at all — requiring set_unit_price to record a Mobilization
--     cost would gate a write on a right that column will never use. Both
--     policies are narrowed: set_unit_price is required only when the
--     target Item is actually unit_price. Same item_kind-lookup-against-
--     items pattern pinned_items already established (0015) — a
--     referential-correctness check, not a tenancy check, so it doesn't
--     fall under the is_member()/has_right()-only rule.
--   - Tenancy through is_member()/has_right()/has_global_right() only. No
--     inlined subquery against contract_members anywhere below.
--   - Every view touched keeps security_invoker = on.
--
-- Requires migrations through 0022.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. cost_basis — the assertion the figure actually makes
-- -----------------------------------------------------------------------------
alter table public.item_prices
  add column cost_basis text check (cost_basis in ('per_unit', 'total'));

-- Existing cost_price values were always entered as a per-unit rate — the
-- only basis this screen has ever offered until now. Backfilled explicitly,
-- not left to a default that would later read as "nobody knows" — an
-- unrecorded basis on a value that undeniably has one is worse than no
-- value at all, since it looks complete.
update public.item_prices
set cost_basis = 'per_unit'
where cost_price is not null
  and cost_basis is null;

alter table public.item_prices
  add constraint item_prices_cost_basis_matches_value
  check ((cost_price is null) = (cost_basis is null));

comment on column public.item_prices.cost_basis is
  'How cost_price was entered: per_unit (a rate) or total (a number for the '
  'whole Item, e.g. a subcontract quote). Never inferred, never defaulted — '
  'the two are different claims and this records which one was actually '
  'made. Always set together with cost_price (see '
  'item_prices_cost_basis_matches_value): absent means nothing entered yet, '
  'on either basis.';

comment on column public.item_prices.cost_price is
  'Contractor internal cost — a per-unit rate or a total, per cost_basis. '
  'Never divide this by a quantity and store the result, or multiply it by '
  'one and store that either: the basis stays attached to the figure, and '
  'the other reading is derived for display only (same rule as margin/'
  'variance, computed and never stored).';

-- -----------------------------------------------------------------------------
-- 2. Write policy — set_unit_price required only when it's a real column
--    for this Item
-- -----------------------------------------------------------------------------
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
  );

-- -----------------------------------------------------------------------------
-- 3. v_item_finance — basis-aware cost/margin. Scope UNCHANGED (0014's own
--    unit_price-only restriction stands: a Lump Sum/Provisional Sum Item
--    still has no quantity-to-date to report "to date" figures against, so
--    it still has no place in a view framed that way — its cost belongs on
--    Rates and in v_item_actual_cost, both basis-aware, not here).
--
--    cost_to_date: quantity_to_date x cost_price when per_unit (unchanged
--    behaviour for every row that predates this migration); cost_price
--    itself, flat, when total — a lump total does not scale with quantity
--    placed, it was already spent as a whole. item_kind is checked again
--    here alongside cost_basis (belt and braces, not trust in cost_basis
--    alone) even though this view is already restricted to unit_price Items
--    by its own WHERE clause.
--
--    margin_proportion generalised to margin / value_of_work_to_date rather
--    than the old (unit_price - cost_price) / unit_price shortcut — the two
--    are identical when cost is per-unit (margin/value = qty(unit-cost) /
--    qty*unit = (unit-cost)/unit) and the new form is also correct when
--    cost is a flat total, which the old shortcut never was.
-- -----------------------------------------------------------------------------
-- DROP + CREATE, not CREATE OR REPLACE: cost_basis sits between cost_price
-- and unit_price in the column list below (matching item_prices' own
-- column order), and CREATE OR REPLACE VIEW only ever permits appending
-- columns at the END — inserting one in the middle reads as an attempt to
-- RENAME every column after it, which Postgres rejects outright (SQLSTATE
-- 42P16, hit while first drafting this migration). Nothing else in the
-- schema references this view (confirmed unused by the app, 0014's own
-- note), so dropping it first costs nothing.
drop view if exists public.v_item_finance;

create view public.v_item_finance
with (security_invoker = on) as
select
  p.item_id,
  p.contract_id,
  p.cost_price,
  p.cost_basis,
  p.unit_price,
  prog.quantity_to_date,
  prog.approximate_quantity * p.unit_price       as extended_amount,
  case
    when p.cost_price is null then null
    when p.cost_basis = 'per_unit' and prog.item_kind = 'unit_price' then prog.quantity_to_date * p.cost_price
    else p.cost_price
  end                                             as cost_to_date,
  prog.quantity_to_date * p.unit_price           as value_of_work_to_date,
  case
    when p.cost_price is null then null
    else prog.quantity_to_date * p.unit_price
         - (case
              when p.cost_basis = 'per_unit' and prog.item_kind = 'unit_price' then prog.quantity_to_date * p.cost_price
              else p.cost_price
            end)
  end                                             as margin,
  case
    when p.cost_price is null or prog.quantity_to_date * p.unit_price <= 0 then null
    else (
      prog.quantity_to_date * p.unit_price
      - (case
           when p.cost_basis = 'per_unit' and prog.item_kind = 'unit_price' then prog.quantity_to_date * p.cost_price
           else p.cost_price
         end)
    ) / (prog.quantity_to_date * p.unit_price)
  end                                             as margin_proportion
from public.item_prices p
join public.v_item_progress prog on prog.item_id = p.item_id
where prog.item_kind = 'unit_price';

comment on view public.v_item_finance is
  'value_of_work_to_date is quantity recorded x Unit Price: the Contractor''s '
  'internal expectation. It is NOT a progress estimate and NOT an amount the '
  'Ministry has approved. GC 52.01 places the progress estimate with the '
  'Ministry Representative; GC 52.04 states progress estimates are not a final '
  'determination of quantities. Restricted to unit_price Items (0014) — a '
  'Lump Sum or Provisional Sum Item is never priced or measured by quantity '
  'per GC 52.03. cost_to_date/margin/margin_proportion are basis-aware '
  '(0023): a total cost_basis reads as the flat figure, never scaled by '
  'quantity_to_date.';

-- -----------------------------------------------------------------------------
-- 4. v_contract_month — cost_in_period/margin_in_period become basis-aware
--    conditional sums: a total-basis Item contributes nothing to a PERIOD
--    figure (a lump total has no honest per-month allocation without
--    prorating against the Approximate Quantity — exactly the derivation
--    this migration exists to stop treating as a stored fact, and doing it
--    inside a SUM would bury which items' contributions were invented).
--    Known, accepted narrowing: a month containing period activity against
--    a total-basis Unit Price Item under-reports that month's true cost —
--    present but incomplete, not wrong. value_in_period (revenue) is
--    unaffected; it was never cost-dependent.
-- -----------------------------------------------------------------------------
create or replace view public.v_contract_month
with (security_invoker = on) as
select
  m.contract_id,
  m.period_month,
  count(distinct m.item_id)                     as items_worked,
  sum(m.quantity_in_period * p.unit_price)      as value_in_period,
  sum(case when p.cost_basis = 'per_unit' then m.quantity_in_period * p.cost_price end) as cost_in_period,
  sum(case when p.cost_basis = 'per_unit' then m.quantity_in_period * (p.unit_price - p.cost_price) end) as margin_in_period,
  max(m.working_days)                           as working_days
from public.v_item_month m
join public.item_prices p on p.item_id = m.item_id
join public.items i on i.id = m.item_id
where i.item_kind = 'unit_price'
group by m.contract_id, m.period_month;

comment on view public.v_contract_month is
  'Monthly value of Work performed at tendered Unit Prices. This is the '
  'Contractor''s own measure and NOT a progress estimate: GC 52.01 places the '
  'progress estimate with the Ministry Representative, and GC 52.04 states a '
  'progress estimate is not a final determination of quantities. Restricted '
  'to unit_price Items (0014). cost_in_period/margin_in_period (0023) '
  'exclude any Item whose cost_basis is total — a lump total has no honest '
  'per-month share, so that Item contributes nothing to these two sums '
  'rather than a prorated guess; value_in_period is unaffected. A month with '
  'period activity against a total-basis Item therefore under-reports cost '
  'for that month specifically — present but incomplete, never wrong.';

-- -----------------------------------------------------------------------------
-- 5. v_item_actual_cost — basis-aware estimate, same treatment as
--    v_item_finance's cost_to_date. Renamed estimated_unit_cost to
--    cost_price + cost_basis (honest: it is not always a unit cost) and
--    added estimated_cost_to_date as its own column rather than inlining
--    the case expression twice (once for display, once inside variance) —
--    this view has zero call sites in the app yet (0018), so the rename
--    costs nothing.
-- -----------------------------------------------------------------------------
drop view if exists public.v_item_actual_cost;

create view public.v_item_actual_cost
with (security_invoker = on) as
with estimated as (
  select
    p.item_id,
    p.contract_id,
    i.item_kind,
    p.cost_price,
    p.cost_basis,
    prog.quantity_to_date,
    case
      when p.cost_price is null then null
      when p.cost_basis = 'per_unit' and i.item_kind = 'unit_price' then p.cost_price * coalesce(prog.quantity_to_date, 0)
      else p.cost_price
    end as estimated_cost_to_date
  from public.item_prices p
  join public.items i on i.id = p.item_id
  left join public.v_item_progress prog on prog.item_id = p.item_id
)
select
  e.item_id,
  e.contract_id,
  e.item_kind,
  e.cost_price,
  e.cost_basis,
  e.quantity_to_date,
  e.estimated_cost_to_date,
  agg.actual_cost_to_date,
  agg.entry_count,
  case
    when agg.actual_cost_to_date is null or e.estimated_cost_to_date is null then null
    else agg.actual_cost_to_date - e.estimated_cost_to_date
  end as cost_variance
from estimated e
left join (
  select item_id, sum(amount) as actual_cost_to_date, count(*) as entry_count
  from public.actual_cost_entries
  group by item_id
) agg on agg.item_id = e.item_id;

comment on view public.v_item_actual_cost is
  'Actual cost to date, the bid estimate (basis-aware, 0023), and their '
  'derived variance — variance is computed here, never stored. Absent '
  'actual cost (no ledger entries) renders null, not zero, and variance is '
  'null along with it rather than defaulting to "on budget". '
  'estimated_cost_to_date is cost_price x quantity_to_date when cost_basis '
  'is per_unit and the Item is unit_price; cost_price itself, flat, '
  'otherwise (a Lump Sum/Provisional Sum Item''s cost_basis is always '
  'total, so this is the only branch that ever applies to those two kinds).';

grant select on public.v_item_actual_cost to authenticated;

-- =============================================================================
-- Verify —
--
--   -- a Lump Sum Item, cost-only, no unit_price ever:
--   select cost_price, cost_basis, unit_price from item_prices
--   where item_id = '<a lump_sum item id>';
--   -- expect cost_basis = 'total', unit_price null
--
--   -- existing unit_price rows carried their basis forward:
--   select count(*) from item_prices where cost_price is not null and cost_basis is null;
--   -- expect 0
--
--   select item_id, cost_price, cost_basis, cost_to_date, margin, margin_proportion
--   from v_item_finance where contract_id = '<contract>';
--   -- a total-basis row's cost_to_date should equal cost_price exactly,
--   -- regardless of quantity_to_date
-- =============================================================================
