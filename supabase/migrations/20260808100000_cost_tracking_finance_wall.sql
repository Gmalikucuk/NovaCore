-- NovaCore v1 — Migration 0044: enforce cost_tracking_enabled in the database
--
-- cost_tracking_enabled (0042) has been a client-only concept since it was
-- introduced — confirmed exhaustively before writing this migration: it
-- appears nowhere in any view definition, any function body, or any RLS
-- policy in the live schema. item_prices' own SELECT policy
-- (item_prices_select_right) checks only has_right(contract_id,
-- 'view_rates') — the same policy whether cost tracking is on or off.
-- Proved live: a seat holding view_rates but neither set_cost nor
-- set_unit_price received real cost_price/cost_basis/margin figures via
-- direct REST calls against item_prices, v_contract_month, and
-- v_item_finance, on a contract with cost_tracking_enabled = false. The UI
-- hides these figures; the network response never did.
--
-- RLS cannot fix this directly — item_prices_select_right's WITH CHECK
-- would have to hide cost_price/cost_basis while keeping unit_price visible
-- in the SAME ROW (unit_price drives value/earned figures everywhere and
-- must stay real regardless of cost tracking). RLS is row-level; it cannot
-- selectively null one column and keep another in the same row.
--
-- The fix is a masking VIEW sitting directly on item_prices that every
-- cost-emitting view, and the app's own read path, now goes through instead
-- of the raw table. Row-level access (can this seat see this contract's
-- prices at all) stays exactly item_prices_select_right, unchanged —
-- security_invoker = on below is what keeps that true; column-level
-- suppression (is the cost figure itself real or absent) is new, and lives
-- in exactly one place.
--
-- The mask condition is NOT simply cost_tracking_enabled — Rates' own
-- existing client rule (RatesScreen.tsx) already exempts the entry surface:
-- "Unit cost/Ext. cost stay real regardless [of the toggle], since those
-- are the entry surface itself." A set_cost holder must keep seeing what
-- they're entering, toggle or no toggle. This is not optional polish: an
-- upsert's `.select()` (prices.ts's upsertItemPrice) relies on Postgres
-- RETURNING, which requires the same SELECT-equivalent privilege as a read
-- — without the exemption, a Finance user saving a cost figure while
-- tracking is off would get null back for what they just wrote.
--
-- Scope note, not addressed here: v_item_actual_cost's cost_variance blends
-- the now-masked item_prices.cost_price (the bid estimate) with
-- agg.actual_cost_to_date, a real figure summed from actual_cost_entries —
-- a different table with its own, unaudited RLS. cost_variance itself
-- nulls correctly when cost_price is masked (its own CASE already checks
-- cost_price IS NULL), but actual_cost_to_date/entry_count are not masked
-- by this migration. Flagged, not fixed — out of scope for "the finance
-- wall on item_prices' bid-estimate columns."
--
-- Dependency graph (confirmed fresh via pg_depend before writing this, not
-- assumed): exactly three views join item_prices directly —
-- v_contract_month, v_item_finance, v_item_actual_cost — and nothing joins
-- any of those three in turn (flat, one level deep). All three keep their
-- exact current column list; only their FROM source changes (item_prices ->
-- v_item_prices_visible), which is a valid CREATE OR REPLACE VIEW (same
-- output columns, same names, same order, same types) — no DROP needed,
-- unlike 0043's column-removal case. CREATE OR REPLACE VIEW preserves the
-- view's OID, so existing grants and the `comment on view` on v_item_finance
-- survive automatically; every grant is restated explicitly below anyway,
-- matching this migration series' own convention, not because REPLACE
-- requires it.

-- -----------------------------------------------------------------------------
-- v_item_prices_visible — the one place the mask lives. security_invoker =
-- on is load-bearing, not decoration: without it, this view would run as
-- its owner (postgres), which bypasses RLS by default — item_prices_select_
-- right's view_rates check would never run for the actual caller, and every
-- authenticated seat would see every contract's prices. Getting this wrong
-- would WIDEN access, not narrow it. With it on, the view runs in the
-- caller's own security context, so item_prices' existing row-level gate
-- applies exactly as if the caller queried item_prices directly — this view
-- adds a column mask strictly on top of that, it does not replace it.
-- -----------------------------------------------------------------------------
create view public.v_item_prices_visible
with (security_invoker = on) as
select
  item_id,
  contract_id,
  case
    when c.cost_tracking_enabled or has_right(item_prices.contract_id, 'set_cost')
      then cost_price
    else null
  end as cost_price,
  unit_price,
  updated_by,
  updated_at,
  case
    when c.cost_tracking_enabled or has_right(item_prices.contract_id, 'set_cost')
      then cost_basis
    else null
  end as cost_basis
from public.item_prices
join public.contracts c on c.id = item_prices.contract_id;

comment on view public.v_item_prices_visible is
  'The one place cost_tracking_enabled (0042) is actually enforced, not just '
  'read — cost_price/cost_basis mask to null unless the contract has cost '
  'tracking on, or the caller holds set_cost on it (the entry surface, '
  'exempted so a Finance user keeps seeing what they are entering regardless '
  'of the display toggle). unit_price is never masked. Every cost-emitting '
  'view (v_contract_month, v_item_finance, v_item_actual_cost) and the '
  'app''s own read path (prices.ts fetchItemPrices) read through this view, '
  'not the raw table — item_prices itself is unchanged and remains directly '
  'queryable by any view_rates holder, a known, disclosed gap this '
  'migration does not close (see report).';

grant select on public.v_item_prices_visible to authenticated;

-- -----------------------------------------------------------------------------
-- v_contract_month — identical to its current definition except the join
-- target: item_prices -> v_item_prices_visible. Every column, every
-- formula, every output name unchanged.
-- -----------------------------------------------------------------------------
create or replace view public.v_contract_month
with (security_invoker = on) as
select m.contract_id,
    m.period_month,
    count(distinct m.item_id) as items_worked,
    sum(m.quantity_in_period * p.unit_price) as value_in_period,
    sum(
        case
            when p.cost_basis = 'per_unit' then m.quantity_in_period * p.cost_price
            else null
        end) as cost_in_period,
    sum(
        case
            when p.cost_basis = 'per_unit' then m.quantity_in_period * (p.unit_price - p.cost_price)
            else null
        end) as margin_in_period,
    max(m.working_days) as working_days
from public.v_item_month m
join public.v_item_prices_visible p on p.item_id = m.item_id
join public.items i on i.id = m.item_id
where i.item_kind = 'unit_price'
group by m.contract_id, m.period_month;

-- -----------------------------------------------------------------------------
-- v_item_finance — identical to its current definition except the join
-- target. Note cost_price/cost_basis are themselves output columns here
-- (not just used in CASE expressions), so this view's own cost_price/
-- cost_basis columns are now masked the same way the raw table's would be.
-- -----------------------------------------------------------------------------
create or replace view public.v_item_finance
with (security_invoker = on) as
select p.item_id,
    p.contract_id,
    p.cost_price,
    p.cost_basis,
    p.unit_price,
    prog.quantity_to_date,
    prog.approximate_quantity * p.unit_price as extended_amount,
    case
        when p.cost_price is null then null
        when p.cost_basis = 'per_unit' and prog.item_kind = 'unit_price' then prog.quantity_to_date * p.cost_price
        else p.cost_price
    end as cost_to_date,
    prog.quantity_to_date * p.unit_price as value_of_work_to_date,
    case
        when p.cost_price is null then null
        else prog.quantity_to_date * p.unit_price - case
            when p.cost_basis = 'per_unit' and prog.item_kind = 'unit_price' then prog.quantity_to_date * p.cost_price
            else p.cost_price
        end
    end as margin,
    case
        when p.cost_price is null or (prog.quantity_to_date * p.unit_price) <= 0 then null
        else (prog.quantity_to_date * p.unit_price - case
            when p.cost_basis = 'per_unit' and prog.item_kind = 'unit_price' then prog.quantity_to_date * p.cost_price
            else p.cost_price
        end) / (prog.quantity_to_date * p.unit_price)
    end as margin_proportion
from public.v_item_prices_visible p
join public.v_item_progress prog on prog.item_id = p.item_id
where prog.item_kind = 'unit_price';

-- -----------------------------------------------------------------------------
-- v_item_actual_cost — identical to its current definition except the join
-- target for item_prices. agg.actual_cost_to_date/entry_count (from
-- actual_cost_entries) are NOT masked by this change — see the scope note
-- above.
-- -----------------------------------------------------------------------------
create or replace view public.v_item_actual_cost
with (security_invoker = on) as
select p.item_id,
    p.contract_id,
    i.item_kind,
    p.cost_price as estimated_unit_cost,
    prog.quantity_to_date,
    agg.actual_cost_to_date,
    agg.entry_count,
    case
        when agg.actual_cost_to_date is null or p.cost_price is null then null
        else agg.actual_cost_to_date - p.cost_price * case
            when i.item_kind = 'unit_price' then coalesce(prog.quantity_to_date, 0)
            else 1
        end
    end as cost_variance
from public.v_item_prices_visible p
join public.items i on i.id = p.item_id
left join public.v_item_progress prog on prog.item_id = p.item_id
left join (
    select item_id, sum(amount) as actual_cost_to_date, count(*) as entry_count
    from public.actual_cost_entries
    group by item_id
) agg on agg.item_id = p.item_id;

-- Every grant restated explicitly, per this migration series' own
-- convention — CREATE OR REPLACE VIEW preserves them automatically, this
-- is belt-and-suspenders for the paper trail, not a correction.
grant select on public.v_contract_month    to authenticated;
grant select on public.v_item_finance      to authenticated;
grant select on public.v_item_actual_cost  to authenticated;
