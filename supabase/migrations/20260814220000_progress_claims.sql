-- =============================================================================
-- NovaCore v1 — Migration 0046: the monthly progress claim (§1, §2, §3, §5)
--
-- Tag deployed commit first, per the brief — c679731/3de6cfd already carried
-- forward correctly; nothing to do there.
--
-- §4 (change orders) is explicitly NOT in this migration, on the user's own
-- instruction: "0010 is the precedent... built without seeing a real
-- progress estimate, said so in its own header, and turned out
-- substantially wrong... I have not shown you a change order." No
-- change_orders table, no change_order_number column — nothing scaffolded
-- for a shape not yet verified.
--
-- WHAT THIS MIGRATION DOES
--
-- 1. §5 — a new right, prepare_claims, replacing set_cost && set_unit_price
--    as the gate on progress_estimates/progress_estimate_items. Preparing a
--    claim needs Unit Price and quantity, not cost or margin — the old gate
--    borrowed Finance's pricing right because nothing else fit, exactly the
--    kind of gate-by-proximity 0041 already called out and fixed once for
--    confirm_quantity.
--
-- 2. §5's companion fix — v_item_prices_visible's cost mask is tightened
--    from `cost_tracking_enabled OR set_cost` to
--    `set_cost OR (cost_tracking_enabled AND view_rates)`. See the view's
--    own comment below for why this exists even though, on its own, the
--    new right's ROW access to item_prices/v_item_prices_visible was never
--    widened to include prepare_claims (see next point) — it is defence in
--    depth against a future change taking the more obvious-looking, wrong
--    path.
--
-- 3. §5's actual unit-price surface for claim prep — a NEW, narrow view,
--    v_item_unit_price_visible, NOT security_invoker. This is the one
--    deliberate deviation from this schema's "security_invoker=on always"
--    convention (see v_item_prices_visible's own comment praising that
--    default) and it is explained at the view itself, in full, because it
--    is the single most security-sensitive decision in this migration.
--
-- 4. §1 — progress_estimate_items.previous_quantity: carried forward once
--    at creation from the prior claim on the same Item, then immutable —
--    enforced by a trigger, not just a disabled input.
--
-- 5. §2 — progress_estimate_items.projected_quantity: entered by a person,
--    every claim, unit_price Items only (see the column comment for why
--    this migration does not also add a projected_percent/projected_value
--    for Lump Sum/Provisional Sum — every real figure in the brief was a
--    unit_price case).
--
-- 6. §3 — contracts.holdback_percent, contracts.gst_percent: nullable
--    contract properties, gated the same way as prepare_claims itself (the
--    population entering a claim is the population that knows these
--    figures from the contract documents). A new view,
--    v_progress_estimate_summary, computes gross/holdback/net/GST/invoiced
--    per estimate and a running holdback-retained-to-date per contract —
--    computed, not stored, same "one figure, one path" convention as
--    v_contract_month.
--
-- Requires migrations through 0045.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The new right
-- -----------------------------------------------------------------------------
alter table public.contract_members
  add column prepare_claims boolean not null default false;

comment on column public.contract_members.prepare_claims is
  'May prepare and submit the monthly progress claim (progress_estimates/'
  'progress_estimate_items) — read Unit Price (via v_item_unit_price_visible,'
  'never cost) and write claimed/projected figures. Deliberately independent'
  'of set_cost/set_unit_price: the project management team prepares claims,'
  'not Finance, and a seat holding only this right must never gain cost or'
  'margin visibility by any path.';

grant update (prepare_claims) on public.contract_members to authenticated;

-- -----------------------------------------------------------------------------
-- 2. progress_estimates / progress_estimate_items — replace the write gate,
--    widen the read gate. Read: either the Finance right that could always
--    read this (view_rates, 0010) or the new claim-preparer right. Write:
--    prepare_claims alone — Finance no longer writes claims, matching the
--    brief ("Claims are prepared by the project management team, not by
--    Finance"), but keeps reading them for oversight.
-- -----------------------------------------------------------------------------
alter policy progress_estimates_select on public.progress_estimates
  using (public.has_right(contract_id, 'view_rates') or public.has_right(contract_id, 'prepare_claims'));

alter policy progress_estimates_insert on public.progress_estimates
  with check (public.has_right(contract_id, 'prepare_claims'));

alter policy progress_estimates_update on public.progress_estimates
  using (public.has_right(contract_id, 'prepare_claims'))
  with check (public.has_right(contract_id, 'prepare_claims'));

alter policy progress_estimate_items_select on public.progress_estimate_items
  using (public.has_right(contract_id, 'view_rates') or public.has_right(contract_id, 'prepare_claims'));

alter policy progress_estimate_items_insert on public.progress_estimate_items
  with check (public.has_right(contract_id, 'prepare_claims'));

alter policy progress_estimate_items_update on public.progress_estimate_items
  using (public.has_right(contract_id, 'prepare_claims'))
  with check (public.has_right(contract_id, 'prepare_claims'));

drop policy progress_estimate_items_history_select_right on public.progress_estimate_items_history;
create policy progress_estimate_items_history_select_right on public.progress_estimate_items_history
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates') or public.has_right(contract_id, 'prepare_claims'));

drop policy progress_estimate_status_history_select_right on public.progress_estimate_status_history;
create policy progress_estimate_status_history_select_right on public.progress_estimate_status_history
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates') or public.has_right(contract_id, 'prepare_claims'));

-- -----------------------------------------------------------------------------
-- 3. v_item_prices_visible — companion fix (§5). Tightened so the
--    cost_tracking_enabled branch only ever fires for a caller who ALSO
--    holds view_rates, not merely "whoever got past the row-level policy."
--
--    Today this is a no-op: item_prices_select_right (the row-level policy
--    this security_invoker view runs under) still gates on view_rates
--    alone, unchanged by this migration — see the next section for why
--    prepare_claims deliberately does NOT get added there. So every caller
--    who can reach this view today already holds view_rates, making the
--    added "and view_rates" check always true for them; nothing they see
--    changes.
--
--    It is shipped anyway, now, because the alternative — adding
--    prepare_claims directly to item_prices_select_right so a preparer
--    could read Unit Price through this same view — was the obvious-looking
--    design and it is wrong: item_prices_select_right is a ROW policy, and
--    RLS cannot mask a column, only hide a whole row (the same limit that
--    made v_item_prices_visible necessary in the first place, 0044). Adding
--    any right there grants that right's holder every column of the row,
--    including raw cost_price, the moment they pass the row check — there
--    is no way to let a right in "for unit_price only" at the row-policy
--    level. This fix means that if a future change ever does take that
--    wrong path by mistake, cost still will not leak to a prepare_claims-
--    only seat on a cost-tracking-enabled contract: they would need
--    view_rates too, which is exactly the population this was always meant
--    to reach.
-- -----------------------------------------------------------------------------
create or replace view public.v_item_prices_visible
with (security_invoker = on) as
select
  item_id,
  contract_id,
  case
    when has_right(item_prices.contract_id, 'set_cost')
      or (c.cost_tracking_enabled and has_right(item_prices.contract_id, 'view_rates'))
      then cost_price
    else null
  end as cost_price,
  unit_price,
  updated_by,
  updated_at,
  case
    when has_right(item_prices.contract_id, 'set_cost')
      or (c.cost_tracking_enabled and has_right(item_prices.contract_id, 'view_rates'))
      then cost_basis
    else null
  end as cost_basis
from public.item_prices
join public.contracts c on c.id = item_prices.contract_id;

comment on view public.v_item_prices_visible is
  'The one place cost_tracking_enabled (0042) is actually enforced. Mask '
  'condition (0046): set_cost holds regardless of the contract''s tracking '
  'state (the entry surface exemption, 0044); otherwise cost is visible '
  'only when the contract has tracking on AND the caller holds view_rates '
  '— view_rates is checked explicitly here, not inherited implicitly from '
  'the row policy, so this stays correct even if a later change ever widens '
  'item_prices_select_right''s row access to a right that is not supposed '
  'to carry cost visibility (0046''s own prepare_claims is the first right '
  'this had to be proven safe against — see v_item_unit_price_visible for '
  'how that right actually reads Unit Price instead: a separate, narrower '
  'view that never selects cost_price/cost_basis at all, not a wider grant '
  'here). unit_price is never masked. Every cost-emitting view '
  '(v_contract_month, v_item_finance, v_item_actual_cost) and the app''s '
  'own read path (prices.ts fetchItemPrices) read through this view, not '
  'the raw table — item_prices itself is unchanged and remains directly '
  'queryable by any view_rates holder, a known, disclosed gap this '
  'migration does not close (see 0044''s own report).';

-- -----------------------------------------------------------------------------
-- 4. v_item_unit_price_visible (§5) — the claim-preparer's actual read
--    surface for Unit Price. Deliberately NOT security_invoker: it does not
--    run under item_prices_select_right at all (that policy stays
--    view_rates-only, untouched — see the comment above for why widening it
--    would leak raw cost). Instead this view is owner-run and re-implements
--    its own, narrower row check directly in the WHERE clause below.
--
--    That is a real, deliberate departure from this schema's own stated
--    default ("security_invoker=on always" — v_item_prices_visible's
--    comment explains why that default is the safe one: getting it wrong
--    normally WIDENS access). The departure is safe here specifically
--    because of what this view's SELECT list does NOT contain: cost_price
--    and cost_basis are not selected, referenced, or joinable through this
--    view at all. A mistake in the WHERE clause below could only ever
--    over-expose unit_price to a seat that shouldn't have it — never cost,
--    because cost is not a column this view has. That is the entire safety
--    argument, and it is why this is a NEW, single-purpose view rather than
--    a change to the general-purpose one above.
--
--    has_right() is SECURITY DEFINER STABLE (0009) — safe to call from a
--    non-invoker view exactly as it already is from every RLS policy in
--    this schema; it resolves auth.uid() itself regardless of the view's
--    own security posture.
-- -----------------------------------------------------------------------------
create view public.v_item_unit_price_visible as
select item_id, contract_id, unit_price
from public.item_prices
where has_right(item_prices.contract_id, 'view_rates')
   or has_right(item_prices.contract_id, 'prepare_claims');

comment on view public.v_item_unit_price_visible is
  'Unit Price only, never cost_price/cost_basis — deliberately not even in '
  'this view''s column list, so a mistake in the row check below can only '
  'ever over-expose Unit Price, never cost. NOT security_invoker (see this '
  'migration''s own header) — the row check (view_rates OR prepare_claims) '
  'is hand-implemented here rather than inherited from item_prices_select_'
  'right, because that policy is intentionally left untouched: adding '
  'prepare_claims there would grant raw item_prices access, including real '
  'cost_price, to a right that must never see cost. Read by '
  'progressEstimates.ts''s claim-preparation screens; every other cost/'
  'margin-emitting surface keeps reading v_item_prices_visible or the views '
  'built on it, unchanged.';

grant select on public.v_item_unit_price_visible to authenticated;

-- -----------------------------------------------------------------------------
-- 5. §1 — previous_quantity. Carried forward once at creation (app-side,
--    see progressEstimates.ts) from the prior claim's own previous_quantity
--    + claimed_quantity for the same Item — then frozen outright, harder
--    than claimed_* (which only freezes once the estimate leaves draft):
--    previous_quantity is a fact copied from history, never something being
--    drafted this period, so there is no draft window where editing it is
--    legitimate.
-- -----------------------------------------------------------------------------
alter table public.progress_estimate_items
  add column previous_quantity numeric;

comment on column public.progress_estimate_items.previous_quantity is
  'Carried forward once, at creation, from the prior claim on this contract '
  'for the same Item (previous_quantity + claimed_quantity of the most '
  'recent prior progress_estimate_item row, or null if this Item has never '
  'been claimed before). Read-only afterward — enforced below, not just '
  'disabled in the UI. unit_price Items only by convention (mirrors '
  'claimed_quantity''s own scope); null and meaningless for Lump Sum/'
  'Provisional Sum rows.';

create or replace function public.guard_progress_estimate_item_previous_quantity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.previous_quantity is distinct from old.previous_quantity then
    raise exception
      'previous_quantity is immutable — carried forward once at creation '
      'from the prior claim on this contract, never edited afterward';
  end if;
  return new;
end;
$$;

create trigger progress_estimate_items_guard_previous_quantity
  before update of previous_quantity
  on public.progress_estimate_items
  for each row execute function public.guard_progress_estimate_item_previous_quantity();

-- -----------------------------------------------------------------------------
-- 6. §2 — projected_quantity. Entered by a person, every claim, never
--    computed. NOT frozen by the draft guard — unlike claimed_quantity (a
--    statement made on a date about what was recorded), a projection is
--    forward-looking judgement that may reasonably be corrected as better
--    information arrives, the same reasoning already applied to certified_*
--    and paid_amount in 0041.
--
--    unit_price Items only, same as previous_quantity above: every real
--    figure in the brief ("Lower Course... 526% of tender", "Item 26 at
--    122.5%") was a unit_price case, and Lump Sum/Provisional Sum already
--    have their own claimed/certified pair (percent, value) that this
--    column does not parallel. Not adding a projected_percent/projected_
--    value pair for them here — nothing in the brief describes what a
--    "projected final percent complete" or "projected final authorized
--    value" would even mean, and inventing one would be exactly the kind
--    of unread guess 0010''s own header warned against repeating.
-- -----------------------------------------------------------------------------
alter table public.progress_estimate_items
  add column projected_quantity numeric;

comment on column public.progress_estimate_items.projected_quantity is
  'The claim preparer''s judgement of the Item''s final quantity at contract '
  'completion — entered by a person every claim, never computed or '
  'inferred. Over Approximate Quantity is a gain, not a fault (GC 52.04 — '
  'progress estimates do not represent a final determination of '
  'quantities). NOT frozen once the estimate leaves draft, unlike '
  'claimed_quantity — a projection is correctable judgement, same as '
  'certified_*/paid_amount. unit_price Items only; null and meaningless for '
  'Lump Sum/Provisional Sum rows.';

-- -----------------------------------------------------------------------------
-- 7. §3 — holdback_percent, gst_percent. Contract properties, entered from
--    the contract documents, never hardcoded (both were 10%/5% on the one
--    real certificate read so far — that is a fact about that contract, not
--    a default worth encoding). Nullable: most contracts have no figure on
--    hand yet, same as tender_price. Readable by any member (same as
--    tender_price/contract_state — these are not cost or margin), writable
--    by prepare_claims: the population now doing this work is the
--    population that reads them off the contract documents to prepare the
--    claim, not a separate Finance-only step gating work that does not
--    itself require Finance''s pricing rights.
-- -----------------------------------------------------------------------------
alter table public.contracts
  add column holdback_percent numeric check (holdback_percent is null or (holdback_percent between 0 and 100)),
  add column gst_percent      numeric check (gst_percent      is null or (gst_percent      between 0 and 100));

comment on column public.contracts.holdback_percent is
  'The holdback percentage withheld from each progress payment (GC 54.00), '
  'entered from the contract documents — never hardcoded. Null until '
  'someone enters it, same as tender_price.';
comment on column public.contracts.gst_percent is
  'The GST rate applied to the net progress payment, entered from the '
  'contract documents — never hardcoded (5% today, but a rate, not a '
  'constant). Null until someone enters it.';

grant update (holdback_percent, gst_percent) on public.contracts to authenticated;

create policy contracts_progress_claim_fields_update_right on public.contracts
  for update to authenticated
  using (public.is_member(id) and public.has_right(id, 'prepare_claims'))
  with check (public.is_member(id) and public.has_right(id, 'prepare_claims'));

-- -----------------------------------------------------------------------------
-- 8. v_progress_estimate_summary (§3) — gross/holdback/net/GST/invoiced per
--    estimate, and holdback retained to date as a running total per
--    contract. Computed, not stored — the same "one figure, one path"
--    convention as v_contract_month. security_invoker = on: it selects only
--    from progress_estimates/progress_estimate_items (both already RLS'd on
--    view_rates OR prepare_claims above) and contracts (holdback_percent/
--    gst_percent, readable by any member) — no new masking decision is made
--    inside this view, so the safe default applies here unlike
--    v_item_unit_price_visible above.
--
--    ROUNDING NOTE, verified against a real certificate before writing this
--    view (City of Delta 25-210 River Road, Progress Payment 1):
--    gross $403,563.17, 10% holdback $40,356.32, net $363,206.85 (exact:
--    gross - holdback), 5% GST $18,160.34 (exact: net * 5%), but invoiced
--    on the real document is $381,367.20 — one cent over net + GST computed
--    here ($381,367.19). The formula below is right; the source document
--    itself rounds at an intermediate step this view does not have access
--    to (most likely GST rounded per line rather than on the net total).
--    Do not "fix" this view to chase that cent — it is the input document
--    rounding, not this arithmetic, and matching it exactly would mean
--    guessing at a per-line rounding rule no document here has shown.
-- -----------------------------------------------------------------------------
create view public.v_progress_estimate_summary
with (security_invoker = on) as
with claim_totals as (
  select progress_estimate_id, sum(claimed_value) as gross_claim
  from public.progress_estimate_items
  group by progress_estimate_id
),
with_holdback as (
  select
    pe.id as progress_estimate_id,
    pe.contract_id,
    pe.period_start,
    pe.period_end,
    pe.status,
    ct.gross_claim,
    c.holdback_percent,
    c.gst_percent,
    case
      when ct.gross_claim is null or c.holdback_percent is null then null
      else round(ct.gross_claim * c.holdback_percent / 100, 2)
    end as holdback_amount
  from public.progress_estimates pe
  left join claim_totals ct on ct.progress_estimate_id = pe.id
  join public.contracts c on c.id = pe.contract_id
),
with_net as (
  select
    *,
    case when gross_claim is null or holdback_amount is null then null else gross_claim - holdback_amount end as net_payment
  from with_holdback
),
with_gst as (
  select
    *,
    case
      when net_payment is null or gst_percent is null then null
      else round(net_payment * gst_percent / 100, 2)
    end as gst_amount
  from with_net
)
select
  progress_estimate_id,
  contract_id,
  period_start,
  period_end,
  status,
  gross_claim,
  holdback_percent,
  holdback_amount,
  net_payment,
  gst_percent,
  gst_amount,
  case when net_payment is null or gst_amount is null then null else net_payment + gst_amount end as total_invoiced,
  sum(holdback_amount) over (
    partition by contract_id order by period_end
    rows between unbounded preceding and current row
  ) as holdback_retained_to_date
from with_gst;

comment on view public.v_progress_estimate_summary is
  'Gross/holdback/net/GST/invoiced per progress estimate, computed from '
  'progress_estimate_items.claimed_value and the contract''s holdback_'
  'percent/gst_percent — never stored redundantly. holdback_retained_to_'
  'date is a running sum of holdback_amount over every estimate on the '
  'contract to date, ordered by period_end; a null holdback_amount on any '
  'one period (percent or gross not yet known) contributes nothing to the '
  'running total rather than breaking it, the same "sum what is known" '
  'convention as fetchProgressEstimateReconciliation''s own sumKnown(). See '
  'this view''s own creation comment for a one-cent rounding difference '
  'checked against a real certificate — the formula is correct, the source '
  'document rounds at a step this view cannot see.';

grant select on public.v_progress_estimate_summary to authenticated;

-- -----------------------------------------------------------------------------
-- 9. Fixtures, both on the sandbox project probe-rls.sh itself resolves at
--    runtime (oldest is_sandbox=true contract with Items — looked up the
--    same way here rather than hardcoding a UUID that could drift from
--    what the suite actually uses):
--
--    "full" (pm@novacore.test) already holds every OTHER per-project right
--    (0008's own header: "full: every per-project right, no company-
--    wide") and every existing progress_estimates/progress_estimate_items
--    write probe (0041) authenticates as it. Without this grant, every one
--    of those probes breaks the moment this migration lands — full would
--    lose write access to progress_estimates outright, since the gate this
--    migration replaces (set_cost + set_unit_price) is exactly what full
--    used to satisfy it with. Granting prepare_claims here keeps "full
--    holds every per-project right" true of the newest one too, and keeps
--    every 0041 probe passing unmodified.
--
--    "quantities" (field@novacore.test) gets prepare_claims and nothing
--    else — enter_quantity + correct_quantity already, view_rates and
--    set_cost still false — so a probe can prove a prepare_claims-ONLY
--    seat's access (real Unit Price, masked cost, write access to claims)
--    without inventing a sixth fixture user.
-- -----------------------------------------------------------------------------
update public.contract_members
set prepare_claims = true
where user_id in (
    '86cf63d5-d606-4ad7-924d-c4f6dda1da0b', -- pm@novacore.test ("full")
    'ee31c560-2015-4d7a-8a1d-ea3f93a73f96'  -- field@novacore.test ("quantities")
  )
  and contract_id = (
    select i.contract_id
    from public.items i
    join public.contracts c on c.id = i.contract_id
    where c.is_sandbox = true
    order by i.created_at asc
    limit 1
  );

-- =============================================================================
-- Verify —
--
--   -- prepare_claims write: a seat with ONLY prepare_claims can insert/
--   -- update progress_estimates and progress_estimate_items; a seat with
--   -- the OLD gate (set_cost + set_unit_price, no prepare_claims) cannot —
--   -- expect 403/0-rows respectively.
--
--   -- prepare_claims read: a seat with ONLY prepare_claims can select its
--   -- own contract's progress_estimates/progress_estimate_items and both
--   -- history tables. A seat with neither view_rates nor prepare_claims
--   -- gets nothing from any of the four, by any query shape.
--
--   -- v_item_unit_price_visible: a prepare_claims-only seat reads real
--   -- unit_price for a priced Item, on a contract with cost_tracking_
--   -- enabled = TRUE. Same seat against v_item_prices_visible and item_
--   -- prices directly for the same Item: zero rows from both (row-level
--   -- policy excludes them — proves the leak this migration exists to
--   -- prevent does not exist).
--
--   -- v_item_prices_visible companion fix, regression: a view_rates
--   -- holder on a cost_tracking_enabled = true contract still sees real
--   -- cost (unaffected) — the entry-surface set_cost exemption still holds
--   -- regardless of tracking state (unaffected).
--
--   -- previous_quantity: update it on any progress_estimate_items row —
--   -- expect rejected outright, any status, with the "immutable" message.
--
--   -- projected_quantity: writable by a prepare_claims holder even after
--   -- the parent estimate leaves draft — expect success (NOT frozen,
--   -- unlike claimed_quantity).
--
--   -- holdback_percent/gst_percent: a prepare_claims holder can set both;
--   -- a seat with neither prepare_claims nor the old set_cost+set_unit_
--   -- price combination cannot; any member can read them regardless of
--   -- rights.
--
--   -- v_progress_estimate_summary: create two estimates on a contract with
--   -- holdback_percent/gst_percent set and claimed_value on their lines —
--   -- confirm gross/holdback/net/GST/invoiced match hand arithmetic, and
--   -- holdback_retained_to_date on the second equals the sum of both
--   -- periods' holdback_amount.
-- =============================================================================
