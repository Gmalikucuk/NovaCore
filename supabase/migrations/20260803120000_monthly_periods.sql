-- =============================================================================
-- NovaCore v1 — Migration 0013: monthly periods
--
-- Every figure in the app is to-date. Both the CFO and the owner need a period:
-- the CFO because GC 52.02 pays monthly in arrears and the question is always
-- "what did we earn in July"; the owner because a RATE of progress is what
-- shows slippage, and a rate needs two points in time.
--
-- This is not scope creep. The Google Sheets tracker being replaced had monthly
-- rollup tabs, and GC 52.01 puts the Ministry Representative's progress estimate
-- on a monthly cycle. Month is the contract's own unit of time.
--
-- Views only. No new tables, no new writes. `work_date` already carries
-- everything needed; nothing about how records are captured changes.
--
-- IMPORTANT: these read quantity_records_effective, so the supersession rule
-- holds — a record counts when confirmed AND without a confirmed successor.
-- A correction confirmed in October does NOT retroactively alter September's
-- figures here, because the corrected record carries the ORIGINAL work_date.
-- That is correct: the work happened in September.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Per Item, per month
-- -----------------------------------------------------------------------------
create view public.v_item_month
with (security_invoker = on) as
select
  r.contract_id,
  r.item_id,
  date_trunc('month', r.work_date)::date as period_month,
  sum(r.quantity)                        as quantity_in_period,
  count(*)                               as record_count,
  min(r.work_date)                       as first_work_date,
  max(r.work_date)                       as last_work_date,
  count(distinct r.work_date)            as working_days
from public.quantity_records_effective r
group by r.contract_id, r.item_id, date_trunc('month', r.work_date);

comment on view public.v_item_month is
  'Confirmed quantity per Item per calendar month. Month is derived from '
  'work_date, which is the date the Work was performed — entered explicitly, '
  'never taken from a device clock. An overnight shift belongs to its start '
  'date, so it lands in the month it started.';

-- -----------------------------------------------------------------------------
-- Contract level, per month, with finance
--
-- Behind the finance wall by construction: it joins item_prices, whose SELECT
-- policy requires view_rates. A seat without that right gets zero rows rather
-- than nulls — no partial leak.
-- -----------------------------------------------------------------------------
create view public.v_contract_month
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
group by m.contract_id, m.period_month;

comment on view public.v_contract_month is
  'Monthly value of Work performed at tendered Unit Prices. This is the '
  'Contractor''s own measure and NOT a progress estimate: GC 52.01 places the '
  'progress estimate with the Ministry Representative, and GC 52.04 states a '
  'progress estimate is not a final determination of quantities. Migration '
  '0010 holds the reconciliation tables for when real estimates arrive.';

-- -----------------------------------------------------------------------------
-- Rate of progress — the owner's view
--
-- "Wants to know in advance so he can push the teams" is not a request for
-- progress to date. It is a request for slippage. Progress to date says where
-- you have been; a rate says where you will be.
--
-- Deliberately simple: recent observed rate, projected forward linearly. Paving
-- is seasonal and weather-bound, so this WILL be wrong in detail. It is an
-- early-warning indicator, not a forecast, and the UI must present it as one.
-- A sophisticated model would be more wrong and harder to argue with.
-- -----------------------------------------------------------------------------
create view public.v_item_progress_rate
with (security_invoker = on) as
with recent as (
  select
    r.item_id,
    r.contract_id,
    sum(r.quantity) filter (
      where r.work_date >= current_date - interval '30 days'
    ) as quantity_last_30,
    count(distinct r.work_date) filter (
      where r.work_date >= current_date - interval '30 days'
    ) as working_days_last_30,
    max(r.work_date) as last_work_date
  from public.quantity_records_effective r
  group by r.item_id, r.contract_id
)
select
  prog.item_id,
  prog.contract_id,
  prog.item_number,
  prog.description,
  prog.unit,
  prog.item_kind,
  prog.approximate_quantity,
  prog.quantity_to_date,
  prog.proportion_complete,
  greatest(prog.approximate_quantity - prog.quantity_to_date, 0) as quantity_remaining,
  coalesce(recent.quantity_last_30, 0)   as quantity_last_30,
  recent.working_days_last_30,
  recent.last_work_date,

  -- Daily rate over days actually worked, not calendar days. A crew that paved
  -- four days out of thirty has a daily rate based on four.
  case
    when coalesce(recent.working_days_last_30, 0) > 0
      then recent.quantity_last_30 / recent.working_days_last_30
  end as quantity_per_working_day,

  -- Working days still required at the observed rate.
  case
    when coalesce(recent.quantity_last_30, 0) > 0
     and prog.approximate_quantity > prog.quantity_to_date
      then ceil(
        (prog.approximate_quantity - prog.quantity_to_date)
        / (recent.quantity_last_30 / nullif(recent.working_days_last_30, 0))
      )
  end as working_days_remaining,

  -- Idle: worked at some point, nothing in 14 days, not finished. The signal
  -- the owner is actually asking for.
  case
    when prog.quantity_to_date > 0
     and prog.quantity_to_date < prog.approximate_quantity
     and recent.last_work_date < current_date - interval '14 days'
      then true
    else false
  end as is_stalled,

  -- Recorded beyond the Approximate Quantity. On a unit price contract this is
  -- work performed that may not be paid without an approved change order.
  case
    when prog.quantity_to_date > prog.approximate_quantity then true
    else false
  end as is_over_quantity

from public.v_item_progress prog
left join recent on recent.item_id = prog.item_id
where prog.item_kind = 'unit_price';

comment on view public.v_item_progress_rate is
  'Early-warning indicator, NOT a forecast. Linear projection from the last 30 '
  'days over days actually worked. Paving is seasonal and weather-bound, so '
  'this is directionally useful and specifically unreliable. The UI must not '
  'present a projected completion date as a commitment.';

grant select on public.v_item_month          to authenticated;
grant select on public.v_contract_month      to authenticated;
grant select on public.v_item_progress_rate  to authenticated;

-- =============================================================================
-- PROBES to add
--
-- v_contract_month joins item_prices, so:
--   probe-quantities SELECT v_contract_month  -> EMPTY
--   probe-readonly   SELECT v_contract_month  -> EMPTY
--   probe-viewer     SELECT v_contract_month  -> rows
--
-- v_item_month and v_item_progress_rate carry no money and should be readable
-- by any member:
--   probe-quantities SELECT v_item_month           -> rows
--   probe-quantities SELECT v_item_progress_rate   -> rows
-- =============================================================================
