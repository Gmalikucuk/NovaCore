-- =============================================================================
-- NovaCore v1 — Migration 0018: actual cost per Item
--
-- WHY THIS EXISTS
--
-- One cost number per Item does two jobs today and can only do one: cost_price
-- on item_prices is the bid estimate, entered by hand on Rates. Nothing records
-- what work actually cost. Finance's real question is whether work came in at,
-- above, or below the estimate — the variance is what tells the bidding team
-- their pricing is drifting. This migration adds actual cost as its own thing,
-- with variance derived, never stored.
--
-- THE SHAPE — proposed and reasoned here before building, per the brief
--
-- A single per-unit "actual_cost" column on item_prices — the obvious first
-- guess, mirroring cost_price exactly — is the wrong shape, and not only for
-- the reason the brief already names (actual cost accrues over time, a
-- snapshot can't represent that). Two more reasons, found while designing
-- this:
--
--   1. cost_price is inherently a PER-UNIT rate: meaningful for a unit_price
--      Item, awkward for Lump Sum (quantity is always 1, so "per unit" only
--      ever means "the whole lump") and Provisional Sum (paid on value
--      authorized, not a rate at all). Actual cost is not a rate — it is
--      money that was actually spent, a plain total. That framing is
--      MEANINGFUL for all three Item kinds equally: Mobilization has a real
--      cost regardless of being paid on percent complete. A single
--      accruing ledger, not a per-unit figure, is therefore not just more
--      correct for unit_price, it is the only shape that means anything for
--      the other two kinds at all.
--   2. A single mutable number has no source-document trail. Real actual
--      cost comes from invoices, payroll allocations, fuel receipts —
--      discrete events, each with its own date and its own paper trail. A
--      column that gets overwritten when a new number comes in loses that
--      trail the moment it happens, which is exactly backwards for the one
--      figure whose whole job is to be checked against reality.
--
-- Proposal: actual_cost_entries, an append-only ledger — one row per cost
-- event against an Item, `amount` SIGNED (not constrained >= 0). A
-- correction is a new entry with a negative amount, not an edit and not a
-- supersession chain: unlike quantity_records, an actual cost entry is
-- already a transcription of a source document at the moment it is entered
-- (an invoice, a timesheet), not a field measurement awaiting a second
-- person's review, so there is no draft/confirm workflow here — it counts
-- the moment it is inserted, same "no update or delete grant" append-only
-- posture as quantity_records for the same audit reason, without the
-- confirm step that exists there for a different one. This is a real,
-- deliberate difference in shape between the two ledgers, not an
-- inconsistency: quantity_records confirms field data because it needs
-- review before it is trusted; actual_cost_entries records something
-- someone already trusted enough to pay.
--
-- "Actual cost to date" for an Item = sum(amount) over its entries. Absent
-- (no rows) reads as null, not zero — a real zero (entries that net to
-- nothing) is a different, legitimate state. Variance is computed in the
-- view below, never stored: estimated cost to date is cost_price times
-- quantity to date for a unit_price Item, or cost_price alone for the other
-- two kinds (their "quantity" is always 1 or not quantity-based at all).
--
-- CONSTRAINTS FOLLOWED
--
--   - Finance wall: actual_cost_entries' SELECT policy requires view_rates,
--     same as item_prices. v_item_actual_cost is behind the wall BY
--     CONSTRUCTION (inner join on item_prices, exactly v_item_finance's own
--     precedent from 0009) — a seat without view_rates gets zero rows, not
--     nulls, from any query shape, including through the view.
--   - Tenancy only through is_member()/has_right()/has_global_right() — no
--     inlined subquery against contract_members anywhere below.
--     security_invoker = on on the one new view.
--   - Writing actual cost is gated by a NEW right, record_actual_cost — see
--     the reasoning immediately below for why reusing an existing one would
--     have been the wrong call, and no role helper is reintroduced.
--
-- THE RIGHT
--
-- New: contract_members.record_actual_cost. Considered and rejected:
--   set_cost         "may set the Schedule 7 unit cost" — that IS the
--                     estimate, on Rates, a single mutable number. Actual
--                     cost is a structurally different write (an
--                     append-only ledger, no Rates screen involvement) to a
--                     different table recording a different fact. Reusing
--                     set_cost would silently conflate "revise the
--                     estimate" with "record what was actually spent" —
--                     exactly the conflation this whole migration exists to
--                     undo.
--   confirm_quantity  0010's own precedent for reusing a right on a new
--                     table (progress_estimates); rejected there too in
--                     0016 for the same reason it is rejected here — this
--                     is not a quantity-confirmation concern.
-- record_actual_cost does NOT also require view_rates to insert — recording
-- what an invoice said does not require being able to read the Contractor's
-- own bid rates, and there is no structural reason (unlike item_prices'
-- shared-row set_cost + set_unit_price pairing) to require both. Reading
-- actual cost back out still requires view_rates regardless of who entered
-- it, per the finance-wall constraint above.
--
-- NOT BUILT, per the brief:
--   - the cost buildup (supplier quotes, crew rates, production
--     assumptions behind cost_price) — the costing module, out of scope.
--   - company-level cost history or any cross-contract aggregate — see the
--     report delivered alongside this migration for what that level would
--     need from this shape.
--   - any UI. This lands the data model, the wall, and the right. Seeded
--     on the sandbox project below so the shape is verifiable without one.
--
-- Requires migrations through 0017.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The new right
-- -----------------------------------------------------------------------------
alter table public.contract_members
  add column record_actual_cost boolean not null default false;

comment on column public.contract_members.record_actual_cost is
  'May insert actual_cost_entries rows against Items on this contract — a '
  'distinct write from set_cost (which sets the bid ESTIMATE). Does not by '
  'itself grant reading actual cost back out; that still requires '
  'view_rates, same finance wall as cost_price.';

grant update (create_items, set_cost, set_unit_price, enter_quantity,
              correct_quantity, confirm_quantity, view_rates, extract_report,
              manage_schedule, record_actual_cost)
  on public.contract_members to authenticated;

-- -----------------------------------------------------------------------------
-- 2. actual_cost_entries — the ledger
-- -----------------------------------------------------------------------------
create table public.actual_cost_entries (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null,
  item_id       uuid not null,
  -- Signed: a negative amount is a correction/credit against a prior entry,
  -- not an edit and not a supersession chain — see this migration's header.
  amount        numeric not null,
  incurred_date date not null,
  note          text,
  created_by    uuid not null references public.profiles(id) default auth.uid(),
  created_at    timestamptz not null default now(),

  -- Same composite-FK pattern as item_prices/pinned_items: structurally
  -- impossible for an entry to point at an Item on a different contract.
  foreign key (item_id, contract_id) references public.items (id, contract_id) on delete cascade
);

comment on table public.actual_cost_entries is
  'Append-only ledger of actual cost events against an Item — one row per '
  'invoice/payroll allocation/receipt, not a per-unit rate. Sum(amount) per '
  'item_id is actual cost to date; no rows means "not recorded yet", not '
  'zero. No update or delete grant: a correction is a new signed entry, '
  'same audit posture as quantity_records, without its draft/confirm step '
  '(see this migration''s header for why that step does not apply here).';

create index actual_cost_entries_item_idx on public.actual_cost_entries (item_id);

alter table public.actual_cost_entries enable row level security;

grant select, insert on public.actual_cost_entries to authenticated;

create policy actual_cost_entries_select_right on public.actual_cost_entries
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates'));

create policy actual_cost_entries_insert_right on public.actual_cost_entries
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.has_right(contract_id, 'record_actual_cost')
  );

-- -----------------------------------------------------------------------------
-- 3. v_item_actual_cost — estimate, actual, and derived variance
--
-- Inner join on item_prices, same construction as v_item_finance (0009): a
-- seat without view_rates gets zero rows from this view by construction,
-- not by a redundant has_right() check repeated here — the wall is
-- structural. actual_cost_entries' own SELECT policy independently
-- enforces the same wall underneath, belt and braces.
--
-- Estimated cost to date: cost_price × quantity to date for a unit_price
-- Item; cost_price alone for Lump Sum/Provisional Sum, whose "quantity" is
-- always 1 or not quantity-based — see this migration's header.
--
-- variance is null whenever either side is null (no actual cost recorded,
-- or no estimate set) — absent, never coerced to "equal to the estimate."
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

grant select on public.v_item_actual_cost to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Sandbox verification data — no UI exists yet to enter this through, so
-- seeded directly here on the dedicated PROBE project, same disclosed-
-- fictional umbrella as its existing invented prices. One Item gets two
-- entries (an initial cost, then a smaller correction) to prove the ledger
-- sums and variance derives correctly; a second Item is left with zero
-- entries to prove "absent, not zero."
-- -----------------------------------------------------------------------------
insert into public.actual_cost_entries (contract_id, item_id, amount, incurred_date, note, created_by)
select
  'c0ffee00-c0de-0000-0000-000000000000',
  'c0ffee00-c0de-0000-0000-000000000001',
  1250.00,
  '2026-06-15',
  'PROBE fixture — initial invoice',
  '86cf63d5-d606-4ad7-924d-c4f6dda1da0b'
where not exists (
  select 1 from public.actual_cost_entries
  where item_id = 'c0ffee00-c0de-0000-0000-000000000001'
    and note = 'PROBE fixture — initial invoice'
);

insert into public.actual_cost_entries (contract_id, item_id, amount, incurred_date, note, created_by)
select
  'c0ffee00-c0de-0000-0000-000000000000',
  'c0ffee00-c0de-0000-0000-000000000001',
  -50.00,
  '2026-06-20',
  'PROBE fixture — credit correction',
  '86cf63d5-d606-4ad7-924d-c4f6dda1da0b'
where not exists (
  select 1 from public.actual_cost_entries
  where item_id = 'c0ffee00-c0de-0000-0000-000000000001'
    and note = 'PROBE fixture — credit correction'
);

-- full (86cf63d5-...) needs record_actual_cost to exercise the insert-path
-- probes below, same reasoning as manage_schedule's own 0017 grant: a new
-- boolean column defaults to false even for a fixture meant to hold "every
-- per-project right".
update public.contract_members
set record_actual_cost = true
where contract_id = 'c0ffee00-c0de-0000-0000-000000000000'
  and user_id = '86cf63d5-d606-4ad7-924d-c4f6dda1da0b';

-- Verify:
--
--   select item_id, estimated_unit_cost, actual_cost_to_date, entry_count, cost_variance
--   from v_item_actual_cost
--   where contract_id = 'c0ffee00-c0de-0000-0000-000000000000';
--   -- item ...0001: actual_cost_to_date = 1200.00 (1250 - 50), entry_count = 2
--   -- item ...0002/0003: actual_cost_to_date null, cost_variance null (absent)
-- =============================================================================
