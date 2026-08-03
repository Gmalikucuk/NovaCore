-- =============================================================================
-- NovaCore v1 — Migration 0010: progress estimate reconciliation
--
-- Depends on 0009. Apply after it.
--
-- WHAT THIS IS FOR
--
-- Three numbers exist for every Item in a month, and they are not the same:
--
--   1. What the Contractor recorded    -> quantity_records (already built)
--   2. What the Ministry Representative estimated
--   3. What the Ministry paid
--
-- GC 52.01 places the progress estimate with the Ministry Representative, who
-- prepares it no later than seven days following the first day of each month.
-- GC 52.03 sets the payment basis per Item kind. GC 52.04 is the load-bearing
-- clause here: progress estimates and progress payments do NOT represent a final
-- determination of quantities of Work. So (1) and (2) diverge routinely, and the
-- divergence is not an error — it is the normal state of a unit price contract,
-- and it is where money is won and lost.
--
-- NOTHING IN NOVACORE HAS EVER RECORDED (2) OR (3).
--
-- HONEST STATUS OF THIS MIGRATION
--
-- These tables are INFERRED from the General Conditions. No actual MoTT progress
-- estimate has been seen. A real one will almost certainly carry fields the GCs
-- never mention — holdback presentation, GST lines, revision numbering, the
-- Ministry's own estimate reference. Expect to alter this.
--
-- Deliberately built as a thin skeleton for exactly that reason: enough
-- structure to receive a real document, not a guess at its full shape. Do NOT
-- build reconciliation UI or dashboard columns against it until a real progress
-- estimate has been read.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. progress_estimates — one per contract per period
-- -----------------------------------------------------------------------------
create table public.progress_estimates (
  id                uuid primary key default gen_random_uuid(),
  contract_id       uuid not null references public.contracts(id) on delete cascade,

  -- The period. GC 52.02 pays monthly in arrears; period_end is the cut-off the
  -- estimate covers, and is the field everything sorts and groups by.
  period_start      date not null,
  period_end        date not null,

  -- The Ministry's own reference for this estimate, once known. Null until a
  -- real document arrives. Not assumed to be a number, or sequential, or unique
  -- across contracts — no format is documented and inventing one would be a
  -- guess that later has to be undone.
  ministry_reference text,

  -- draft:     being assembled internally, nothing received
  -- submitted: the Contractor's position has been put forward
  -- received:  a progress estimate has come back from the Ministry
  -- reconciled: differences reviewed and accepted or disputed
  status            text not null default 'draft'
                    check (status in ('draft','submitted','received','reconciled')),

  estimate_date     date,          -- date on the Ministry's document
  note              text,
  created_by        uuid references public.profiles(id) default auth.uid(),
  created_at        timestamptz not null default now(),

  constraint progress_estimates_period_ordered check (period_end >= period_start),
  unique (contract_id, period_start, period_end)
);

create index progress_estimates_contract_period_idx
  on public.progress_estimates (contract_id, period_end desc);

comment on table public.progress_estimates is
  'A monthly progress estimate under GC 52.00. The document itself originates '
  'with the Ministry Representative (GC 52.01); this table records both the '
  'Contractor''s position and what came back.';

-- -----------------------------------------------------------------------------
-- 2. progress_estimate_items — the reconciliation, per Item
--
-- Three quantity columns, deliberately separate. Collapsing any two of them
-- destroys the only information this table exists to hold.
--
-- All three are nullable: a period where an Item saw no Work has no rows, and a
-- period where the Ministry has not yet responded has claimed values with
-- certified still null. Null means "not known", never "zero".
-- -----------------------------------------------------------------------------
create table public.progress_estimate_items (
  id                    uuid primary key default gen_random_uuid(),
  progress_estimate_id  uuid not null
                        references public.progress_estimates(id) on delete cascade,
  item_id               uuid not null references public.items(id),
  contract_id           uuid not null,

  -- (1) What the Contractor recorded for this period. Populated from
  --     quantity_records_effective, but STORED rather than derived: the claim is
  --     a historical fact about what was submitted, and it must not silently
  --     change when a correction is confirmed months later. Recomputing it would
  --     rewrite history.
  claimed_quantity      numeric,

  -- (2) What the Ministry Representative estimated. GC 52.03(a).
  certified_quantity    numeric,

  -- (3) What was actually paid. Kept separate from certified because a certified
  --     quantity can be reduced by holdback, set-off, or dispute before payment.
  paid_amount           numeric,

  -- Lump Sum Items are paid on percentage complete, not quantity — GC 52.03(b).
  -- Provisional Sum Items on authorized value — GC 52.03(c). Both need their own
  -- claimed/certified pair; quantity columns are meaningless for them.
  claimed_percent       numeric check (claimed_percent   is null
                                       or (claimed_percent   between 0 and 100)),
  certified_percent     numeric check (certified_percent is null
                                       or (certified_percent between 0 and 100)),
  claimed_value         numeric,
  certified_value       numeric,

  -- Set when certified differs from claimed and the difference has been looked
  -- at. A difference is normal (GC 52.04); an unexplained one is not.
  variance_note         text,
  disputed              boolean not null default false,

  created_at            timestamptz not null default now(),

  foreign key (item_id, contract_id)
    references public.items (id, contract_id),
  unique (progress_estimate_id, item_id)
);

create index progress_estimate_items_item_idx
  on public.progress_estimate_items (item_id);

comment on column public.progress_estimate_items.claimed_quantity is
  'Stored, not derived. What was claimed in this period is a fact about the '
  'submission; a later confirmed correction must not retroactively alter it.';
comment on column public.progress_estimate_items.certified_quantity is
  'The Ministry Representative''s estimate. Null until received. Null is '
  '"not yet known", never zero.';

-- items.id needs to be addressable with contract_id for the composite FK above.
-- 0001 created `unique (id, project_id)` on line_items; after 0009's rename that
-- is `unique (id, contract_id)` on items, so the reference resolves. If it does
-- not, the rename did not carry the constraint and it must be recreated before
-- this migration will apply.

-- -----------------------------------------------------------------------------
-- 3. RLS
--
-- A progress estimate is finance material: it carries certified quantities and
-- paid amounts, which reveal Unit Prices by arithmetic even without a price
-- column. So reads gate on view_rates, NOT on mere membership. A field seat that
-- can see quantities must not reach this table.
-- -----------------------------------------------------------------------------
alter table public.progress_estimates      enable row level security;
alter table public.progress_estimate_items enable row level security;

revoke all on public.progress_estimates      from anon, authenticated;
revoke all on public.progress_estimate_items from anon, authenticated;

grant select, insert, update on public.progress_estimates      to authenticated;
grant select, insert, update on public.progress_estimate_items to authenticated;

create policy progress_estimates_select on public.progress_estimates
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates'));

create policy progress_estimates_insert on public.progress_estimates
  for insert to authenticated
  with check (public.has_right(contract_id, 'confirm_quantity'));

create policy progress_estimates_update on public.progress_estimates
  for update to authenticated
  using (public.has_right(contract_id, 'confirm_quantity'))
  with check (public.has_right(contract_id, 'confirm_quantity'));

create policy progress_estimate_items_select on public.progress_estimate_items
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates'));

create policy progress_estimate_items_insert on public.progress_estimate_items
  for insert to authenticated
  with check (public.has_right(contract_id, 'confirm_quantity'));

create policy progress_estimate_items_update on public.progress_estimate_items
  for update to authenticated
  using (public.has_right(contract_id, 'confirm_quantity'))
  with check (public.has_right(contract_id, 'confirm_quantity'));

-- No delete grant and no delete policy, consistent with quantity_records. A
-- superseded estimate is a revision, not a deletion.

-- -----------------------------------------------------------------------------
-- 4. A view for the reconciliation, once data exists
-- -----------------------------------------------------------------------------
create view public.v_progress_estimate_reconciliation
with (security_invoker = on) as
select
  pei.progress_estimate_id,
  pe.contract_id,
  pe.period_start,
  pe.period_end,
  pe.status,
  i.item_number,
  i.description,
  i.unit,
  i.item_kind,
  pei.claimed_quantity,
  pei.certified_quantity,
  pei.certified_quantity - pei.claimed_quantity as quantity_variance,
  pei.claimed_percent,
  pei.certified_percent,
  pei.claimed_value,
  pei.certified_value,
  pei.paid_amount,
  pei.disputed,
  pei.variance_note
from public.progress_estimate_items pei
join public.progress_estimates pe on pe.id = pei.progress_estimate_id
join public.items i               on i.id  = pei.item_id;

grant select on public.v_progress_estimate_reconciliation to authenticated;

-- =============================================================================
-- 5. WHAT IS NOT HERE, AND WHY
--
-- No holdback modelling. GC 54.00 sets a holdback against each progress
-- payment, but its presentation on the actual document is unknown.
--
-- No GST. Schedule 7 guidance requires GST shown as a separate line item on
-- invoices and progress estimates. Its structure is unknown.
--
-- No revision handling. A progress estimate may be revised; whether MoTT issues
-- a new document or amends the existing one is unknown.
--
-- No automatic population of claimed_quantity from quantity_records. That is a
-- deliberate omission: rolling up a period's confirmed records into a claim is
-- straightforward, but doing it before seeing how a real estimate presents a
-- period means guessing at the cut-off and the rounding. Write it when the first
-- estimate is in hand.
--
-- Every one of these is a guess this migration declines to make. Read a real
-- Venables Valley progress estimate first — it is an internal Keywest document,
-- and asking to see how progress estimates are structured is an ordinary
-- request for a Project Coordinator to make.
--
-- 6. AFTER APPLYING
--
-- Nothing in the application reads these tables. That is intended. Do not build
-- reconciliation UI or dashboard columns until a real progress estimate has been
-- read and this schema has been corrected against it.
--
-- Add probes: a seat WITHOUT view_rates must get nothing from
-- progress_estimates, progress_estimate_items, and
-- v_progress_estimate_reconciliation, by any query shape. These tables carry
-- certified quantities and paid amounts, from which Unit Prices can be derived
-- by arithmetic — they are behind the finance wall, not merely near it.
-- =============================================================================
