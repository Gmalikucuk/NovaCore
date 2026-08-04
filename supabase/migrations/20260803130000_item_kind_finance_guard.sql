-- =============================================================================
-- NovaCore v1 — Migration 0014: item_kind guard on the money views
--
-- Nothing in the schema stops a Lump Sum or Provisional Sum Item from also
-- getting an item_prices row (no CHECK constraint ties item_prices to
-- item_kind) or a quantity_records row (quantity_records_insert_right, 0012,
-- has no item_kind clause). GC 52.03 pays a Unit Price Item on quantity, a
-- Lump Sum Item on percentage complete (52.03(b)), and a Provisional Sum Item
-- on value authorized in advance (52.03(c)/47.01) — a quantity_records row
-- against either of the latter two is not a measurement of anything, and
-- multiplying it by a Unit Price it should never have had is not a number
-- that means anything either.
--
-- v_item_progress_rate already carries `where prog.item_kind = 'unit_price'`
-- (0013) — but that view has no money column. The two views that DO compute
-- money join item_prices/v_item_month purely on item_id, with no item_kind
-- predicate at all:
--
--   v_item_finance    (0012) — value_of_work_to_date, cost_to_date, margin.
--                       Currently unqueried anywhere in the app (grepped:
--                       zero `.from('v_item_finance')` call sites) — this
--                       fix is correctness/hygiene, not a live bug.
--   v_contract_month  (0013) — value_in_period, cost_in_period,
--                       margin_in_period. Read by fetchContractMonths() and
--                       rendered UNGATED in OverviewScreen's Band 3 KPIs
--                       (the "Value of Work this month"/"Margin this month"
--                       cards read straight off this view's row, with no
--                       itemKind check anywhere between the query and the
--                       screen) — this IS the one place in the app that
--                       would show an inflated figure to the CFO if a stray
--                       priced Lump Sum/Provisional Sum item ever picked up
--                       a quantity_records row.
--
-- Every other money computation in the app (OverviewScreen's own month
-- table, TrackerScreen, trackerExport.ts) already re-derives an
-- `itemKind === 'unit_price'` gate client-side before multiplying — this
-- migration closes the two spots that don't, at the source, so nothing
-- downstream has to keep re-deriving it correctly to stay safe.
--
-- CREATE OR REPLACE VIEW, not DROP + CREATE: the column list is unchanged
-- (only a WHERE predicate is added), and nothing else in the schema
-- references either view, so no dependency-ordering hazard here.
-- =============================================================================

create or replace view public.v_item_finance
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
join public.v_item_progress prog on prog.item_id = p.item_id
where prog.item_kind = 'unit_price';

comment on view public.v_item_finance is
  'value_of_work_to_date is quantity recorded x Unit Price: the Contractor''s '
  'internal expectation. It is NOT a progress estimate and NOT an amount the '
  'Ministry has approved. GC 52.01 places the progress estimate with the '
  'Ministry Representative; GC 52.04 states progress estimates are not a final '
  'determination of quantities. Restricted to unit_price Items (0014) — a '
  'Lump Sum or Provisional Sum Item is never priced or measured by quantity '
  'per GC 52.03, so it has no place in this view regardless of what '
  'item_prices/quantity_records happen to hold for it.';

create or replace view public.v_contract_month
with (security_invoker = on) as
select
  m.contract_id,
  m.period_month,
  count(distinct m.item_id)                     as items_worked,
  sum(m.quantity_in_period * p.unit_price)      as value_in_period,
  sum(m.quantity_in_period * p.cost_price)      as cost_in_period,
  sum(m.quantity_in_period * (p.unit_price - p.cost_price)) as margin_in_period,
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
  'progress estimate is not a final determination of quantities. Migration '
  '0010 holds the reconciliation tables for when real estimates arrive. '
  'Restricted to unit_price Items (0014) — this is the view OverviewScreen''s '
  'Band 3 money cards read directly with no client-side item_kind gate of '
  'their own, so the filter belongs here, at the source.';
