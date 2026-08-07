-- =============================================================================
-- NovaCore v1 — Migration 0041: progress estimates — the Finance write path
--
-- Tag deployed commit first, per the brief.
--
-- 0010 built progress_estimates/progress_estimate_items as a thin,
-- deliberately-unread skeleton, inferred from the General Conditions with
-- no real progress estimate seen — "Do NOT build reconciliation UI... until
-- a real progress estimate has been read and this schema has been
-- corrected against it." This brief's own description of the claimed/
-- certified/paid cycle matches that schema column-for-column, which is
-- read here as satisfying that precondition — reported to the user, not
-- silently assumed away.
--
-- THREE THINGS THIS MIGRATION DOES
--
-- 1. Fixes the write-gating right. 0010 gated INSERT/UPDATE on both tables
--    with has_right(contract_id, 'confirm_quantity') — a field-operations
--    right (the same one that gates confirming a daily quantity record),
--    borrowed by proximity to quantity_records rather than chosen for what
--    it actually gates here. Every OTHER money-writing surface in this
--    schema — item_prices (set_cost + set_unit_price), contracts.
--    tender_price (same), contracts.contract_state (manage_members) — uses
--    a right that actually governs Finance. progress_estimates carries
--    certified quantities and paid amounts, i.e. it IS Finance material
--    (0010's own SELECT policy already agrees: view_rates). Changed to
--    set_cost AND set_unit_price, matching item_prices exactly — the same
--    seat that sets rates administers the payment-certificate
--    reconciliation.
--
-- 2. Freezes a claim once it stops being a draft. "Once submitted it does
--    not move when a later record changes, because it is a statement made
--    on a date" — the brief's own words, and the same discipline
--    guard_entry_transitions() already enforces for quantity_records
--    (append-only once confirmed). guard_progress_estimate_claim() below
--    is that same pattern applied here: an UPDATE to claimed_quantity,
--    claimed_percent, or claimed_value is rejected once the PARENT
--    progress_estimates row's status is no longer 'draft'. certified_*,
--    paid_amount, disputed, and variance_note are unaffected — those
--    arrive AFTER submission and must stay writable.
--
-- 3. Adds history for the money-moving entered figures, same reasoning as
--    contract_state_history and item_price_history: entered by a person,
--    correctable, moves money. progress_estimate_items_history logs real
--    changes to certified_quantity/certified_value/paid_amount (NOT
--    claimed_* — protected by the freeze above instead, a different
--    mechanism for a different failure mode; NOT disputed/variance_note —
--    "disputed is a flag on a line and nothing more... no history", the
--    brief's own words). progress_estimate_status_history mirrors
--    contract_state_history exactly, for the draft/submitted/received/
--    reconciled transitions. Built in this migration, not deferred — the
--    write path this migration enables should never have a gap where a
--    corrected certified figure goes unlogged.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Fix the write-gating right
-- -----------------------------------------------------------------------------
alter policy progress_estimates_insert on public.progress_estimates
  with check (public.has_right(contract_id, 'set_cost') and public.has_right(contract_id, 'set_unit_price'));

alter policy progress_estimates_update on public.progress_estimates
  using (public.has_right(contract_id, 'set_cost') and public.has_right(contract_id, 'set_unit_price'))
  with check (public.has_right(contract_id, 'set_cost') and public.has_right(contract_id, 'set_unit_price'));

alter policy progress_estimate_items_insert on public.progress_estimate_items
  with check (public.has_right(contract_id, 'set_cost') and public.has_right(contract_id, 'set_unit_price'));

alter policy progress_estimate_items_update on public.progress_estimate_items
  using (public.has_right(contract_id, 'set_cost') and public.has_right(contract_id, 'set_unit_price'))
  with check (public.has_right(contract_id, 'set_cost') and public.has_right(contract_id, 'set_unit_price'));

-- -----------------------------------------------------------------------------
-- 2. Freeze claimed_* once the parent estimate leaves 'draft'
--
-- Column-scoped (`of claimed_quantity, claimed_percent, claimed_value`) so
-- an update touching only certified_*/paid_amount/disputed/variance_note
-- never even calls this function. The parent's status is looked up by
-- subquery, same cross-table-check shape has_right()'s own policies use —
-- progress_estimate_items has no status column of its own; status lives on
-- progress_estimates.
-- -----------------------------------------------------------------------------
create or replace function public.guard_progress_estimate_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status
  from public.progress_estimates
  where id = new.progress_estimate_id;

  if v_status is distinct from 'draft'
     and row(new.claimed_quantity, new.claimed_percent, new.claimed_value)
       is distinct from
       row(old.claimed_quantity, old.claimed_percent, old.claimed_value)
  then
    raise exception
      'claimed_quantity/claimed_percent/claimed_value are frozen once the '
      'progress estimate leaves draft — a claim is a statement made on a '
      'date, not a rollup that moves with later records';
  end if;

  return new;
end;
$$;

create trigger progress_estimate_items_guard_claim
  before update of claimed_quantity, claimed_percent, claimed_value
  on public.progress_estimate_items
  for each row execute function public.guard_progress_estimate_claim();

-- -----------------------------------------------------------------------------
-- 3a. progress_estimate_items_history — certified_quantity, certified_value,
--     paid_amount only. Update-only (never fires on INSERT): a proposed
--     line's certified fields start null — there is nothing worth logging
--     until the Ministry's figures actually arrive as a real UPDATE.
-- -----------------------------------------------------------------------------
create table public.progress_estimate_items_history (
  id                      uuid primary key default gen_random_uuid(),
  progress_estimate_item_id uuid not null,
  contract_id             uuid not null,
  changed_at              timestamptz not null default now(),
  changed_by              uuid references public.profiles(id),
  old_certified_quantity  numeric,
  new_certified_quantity  numeric,
  old_certified_value     numeric,
  new_certified_value     numeric,
  old_paid_amount         numeric,
  new_paid_amount         numeric,
  foreign key (progress_estimate_item_id)
    references public.progress_estimate_items (id) on delete cascade
);

create index progress_estimate_items_history_item_idx
  on public.progress_estimate_items_history (progress_estimate_item_id, changed_at desc);

comment on table public.progress_estimate_items_history is
  'Append-only log of every real change to progress_estimate_items.'
  'certified_quantity, certified_value, or paid_amount — written only by '
  'log_progress_estimate_item_change() (security definer), never directly. '
  'Mirrors item_price_history''s own reasoning: these figures are entered '
  'by a person, correctable, and move money.';

create or replace function public.log_progress_estimate_item_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if row(new.certified_quantity, new.certified_value, new.paid_amount)
     is distinct from
     row(old.certified_quantity, old.certified_value, old.paid_amount) then
    insert into public.progress_estimate_items_history
      (progress_estimate_item_id, contract_id, changed_by,
       old_certified_quantity, new_certified_quantity,
       old_certified_value, new_certified_value,
       old_paid_amount, new_paid_amount)
    values
      (new.id, new.contract_id, auth.uid(),
       old.certified_quantity, new.certified_quantity,
       old.certified_value, new.certified_value,
       old.paid_amount, new.paid_amount);
  end if;
  return new;
end;
$$;

create trigger progress_estimate_items_history_log
  after update of certified_quantity, certified_value, paid_amount
  on public.progress_estimate_items
  for each row execute function public.log_progress_estimate_item_change();

alter table public.progress_estimate_items_history enable row level security;
revoke all on public.progress_estimate_items_history from anon, authenticated;
grant select on public.progress_estimate_items_history to authenticated;

create policy progress_estimate_items_history_select_right on public.progress_estimate_items_history
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates'));

-- -----------------------------------------------------------------------------
-- 3b. progress_estimate_status_history — mirrors contract_state_history
--     exactly, for draft/submitted/received/reconciled.
-- -----------------------------------------------------------------------------
create table public.progress_estimate_status_history (
  id                    uuid primary key default gen_random_uuid(),
  progress_estimate_id  uuid not null,
  contract_id           uuid not null,
  changed_at            timestamptz not null default now(),
  changed_by            uuid references public.profiles(id),
  old_status            text,
  new_status            text,
  foreign key (progress_estimate_id)
    references public.progress_estimates (id) on delete cascade
);

create index progress_estimate_status_history_estimate_idx
  on public.progress_estimate_status_history (progress_estimate_id, changed_at desc);

comment on table public.progress_estimate_status_history is
  'Append-only log of every real change to progress_estimates.status — '
  'written only by log_progress_estimate_status_change() (security '
  'definer), never directly. Mirrors contract_state_history''s own shape.';

create or replace function public.log_progress_estimate_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status is distinct from new.status then
    insert into public.progress_estimate_status_history (progress_estimate_id, contract_id, changed_by, old_status, new_status)
    values (new.id, new.contract_id, auth.uid(), old.status, new.status);
  end if;
  return new;
end;
$$;

create trigger progress_estimates_status_history_log
  after update of status on public.progress_estimates
  for each row execute function public.log_progress_estimate_status_change();

alter table public.progress_estimate_status_history enable row level security;
revoke all on public.progress_estimate_status_history from anon, authenticated;
grant select on public.progress_estimate_status_history to authenticated;

create policy progress_estimate_status_history_select_right on public.progress_estimate_status_history
  for select to authenticated
  using (public.has_right(contract_id, 'view_rates'));

-- =============================================================================
-- Verify —
--
--   -- a seat with confirm_quantity but not set_cost+set_unit_price can no
--   -- longer write (the exact mismatch this migration fixes):
--   -- expect 403 on insert/update as such a seat
--
--   -- a seat with set_cost+set_unit_price can write:
--   -- expect success
--
--   -- the freeze: submit an estimate (status -> 'submitted'), then try to
--   -- change claimed_quantity on one of its items:
--   -- expect rejected, "frozen once the progress estimate leaves draft"
--
--   -- certified_quantity/paid_amount remain editable after submission:
--   -- expect success
--
--   -- history: change a certified_quantity, confirm a row appears in
--   -- progress_estimate_items_history with the old and new values
--
--   -- status history: change status, confirm a row appears in
--   -- progress_estimate_status_history
--
--   -- a seat without view_rates reads nothing from either history table
-- =============================================================================
