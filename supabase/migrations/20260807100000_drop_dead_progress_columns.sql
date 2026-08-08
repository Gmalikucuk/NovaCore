-- NovaCore v1 — Migration 0043: drop two dead columns from the progress views
--
-- Two findings from the "one figure, one path" consolidation brief:
--
--   quantity_per_working_day on v_item_progress_rate — flagged dead in an
--   earlier brief ("computed here, read nowhere but overview.test.ts's
--   fixture data") and left in place pending a decision on the view as a
--   whole (see monthlyPeriods.ts's own doc comment on ItemProgressRate).
--   That decision is this brief. Confirmed again here, fresh, before
--   touching anything: zero references anywhere in src/ outside the fetch/
--   map in monthlyPeriods.ts itself and the overview.test.ts fixture object
--   (both updated in the same commit as this migration).
--
--   record_count on v_item_progress — fetched and mapped into the
--   ItemProgress TS type (monthlyPeriods.ts) but never read by any
--   consumer. Newly found while confirming the above; same shape, same fix.
--
-- Neither view supports CREATE OR REPLACE VIEW for a column removal —
-- Postgres only allows CREATE OR REPLACE VIEW to APPEND columns at the end,
-- never drop one (SQLSTATE 42P16) — so this is DROP + CREATE, same
-- constraint v_item_finance hit doing this in 0023 (20260805100000_cost_
-- basis.sql). Per the brief's own constraint, nothing is dropped from
-- existence — v_item_progress and v_item_progress_rate are recreated
-- immediately after, minus the one column each, and every grant is
-- restated explicitly rather than assumed to survive.
--
-- THE DEPENDENCY GRAPH — the reason this migration touches four views, not
-- two. v_item_progress is not only the base of v_item_progress_rate; three
-- views join it directly: v_item_progress_rate (0013), v_item_finance
-- (0009, recreated 0023 — confirmed unused by the app, kept as the SQL-side
-- reference margin.ts's own comment says it "mirrors exactly"), and
-- v_item_actual_cost (0018). Postgres will not let a view be dropped while
-- another view depends on it (and CASCADE was deliberately not reached for
-- here — better to name every drop than risk taking something
-- unaccounted-for with it). All three dependents are dropped first, then
-- v_item_progress, then all four are recreated in dependency order.
-- v_item_finance and v_item_actual_cost are recreated with their CURRENT
-- definitions verbatim (re-pointed at the new v_item_progress, nothing else
-- changed) — copied from 20260805100000_cost_basis.sql and
-- 20260803170000_actual_cost.sql respectively, cross-checked against every
-- migration that has touched either since, to make sure neither is copying
-- a stale version.
--
-- Confirmed before writing this: neither record_count nor quantity_per_
-- working_day is referenced by column name in v_item_progress_rate,
-- v_item_finance, or v_item_actual_cost's own SELECT lists (grepped the
-- full migration history for both column names and for any `select *`/
-- `prog.*` wildcard against v_item_progress — none exists). Dropping both
-- columns changes no other view's result set.
--
-- The column-drift event trigger (guard_quantity_records_effective_columns,
-- 0037) does not apply here — it fires only on `ALTER TABLE` against
-- `public.quantity_records` specifically. This migration issues no ALTER
-- TABLE and touches no column of quantity_records; the guard is simply not
-- engaged by this change, not satisfied by it.
--
-- security_invoker = on preserved on every recreated view, unchanged from
-- each one's prior definition.

drop view if exists public.v_item_actual_cost;
drop view if exists public.v_item_finance;
drop view if exists public.v_item_progress_rate;
drop view if exists public.v_item_progress;

-- -----------------------------------------------------------------------------
-- v_item_progress — identical to its current definition except record_count
-- is gone.
-- -----------------------------------------------------------------------------
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
  max(r.work_date) as last_work_date
from public.items i
left join public.quantity_records_effective r on r.item_id = i.id
group by i.id;

-- -----------------------------------------------------------------------------
-- v_item_progress_rate — identical to its current definition except
-- quantity_per_working_day is gone. working_days_remaining's own formula
-- recomputes the last-30-days rate inline (recent.quantity_last_30 /
-- nullif(recent.working_days_last_30, 0)) rather than reading quantity_per_
-- working_day as a column, so removing that column changes nothing else in
-- this view.
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
  case
    when coalesce(recent.quantity_last_30, 0) > 0
     and prog.approximate_quantity > prog.quantity_to_date
      then ceil(
        (prog.approximate_quantity - prog.quantity_to_date)
        / (recent.quantity_last_30 / nullif(recent.working_days_last_30, 0))
      )
  end as working_days_remaining,
  case
    when prog.quantity_to_date > 0
     and prog.quantity_to_date < prog.approximate_quantity
     and recent.last_work_date < current_date - interval '14 days'
      then true
    else false
  end as is_stalled,
  case
    when prog.quantity_to_date > prog.approximate_quantity then true
    else false
  end as is_over_quantity
from public.v_item_progress prog
left join recent on recent.item_id = prog.item_id
where prog.item_kind = 'unit_price';

-- -----------------------------------------------------------------------------
-- v_item_finance — UNCHANGED, verbatim from 20260805100000_cost_basis.sql,
-- re-pointed at the new v_item_progress. Confirmed unused by the app (that
-- migration's own note, still true — zero `.from('v_item_finance')` call
-- sites in src/); kept as the SQL-side reference margin.ts's own comment
-- says it mirrors.
-- -----------------------------------------------------------------------------
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
-- v_item_actual_cost — UNCHANGED, verbatim from 20260803170000_actual_
-- cost.sql, re-pointed at the new v_item_progress.
-- -----------------------------------------------------------------------------
create view public.v_item_actual_cost
with (security_invoker = on) as
select
  p.item_id,
  p.contract_id,
  i.item_kind,
  p.cost_price                              as estimated_unit_cost,
  prog.quantity_to_date,
  agg.actual_cost_to_date,
  agg.entry_count,
  case
    when agg.actual_cost_to_date is null or p.cost_price is null then null
    else agg.actual_cost_to_date
         - p.cost_price * (case when i.item_kind = 'unit_price' then coalesce(prog.quantity_to_date, 0) else 1 end)
  end                                        as cost_variance
from public.item_prices p
join public.items i on i.id = p.item_id
left join public.v_item_progress prog on prog.item_id = p.item_id
left join (
  select item_id, sum(amount) as actual_cost_to_date, count(*) as entry_count
  from public.actual_cost_entries
  group by item_id
) agg on agg.item_id = p.item_id;

comment on view public.v_item_actual_cost is
  'Actual cost to date, the bid estimate, and their derived variance — '
  'variance is computed here, never stored (0018). Absent actual cost '
  '(no ledger entries) renders null here, not zero, and variance is null '
  'along with it rather than defaulting to "on budget".';

-- Every grant restated explicitly, per the brief's own constraint — none
-- assumed to survive the drop.
grant select on public.v_item_progress      to authenticated;
grant select on public.v_item_progress_rate to authenticated;
grant select on public.v_item_finance       to authenticated;
grant select on public.v_item_actual_cost   to authenticated;
