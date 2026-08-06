-- =============================================================================
-- NovaCore — contract_state_history
--
-- Proposed in the brief that shipped the state-change control (Portfolio's
-- "Change" link) and built here, per instruction. Same shape and reasoning
-- as item_price_history: contract_state now moves real money between
-- company-wide figures (Overview's Contract value under management,
-- Earned to date, Backlog remaining) and toggles Needs Attention's stalled
-- detection, with nothing anywhere recording who moved it or when.
--
-- FOUR THINGS SETTLED HERE
--
-- 1. Logged only on a real change. The trigger is registered
--    `after update of contract_state` — Postgres itself skips firing it
--    for an update that doesn't touch that column at all (a tender_price
--    edit, a planned_end edit, seeding a new row, none of these reach the
--    trigger body) — and the old.contract_state IS DISTINCT FROM
--    new.contract_state guard inside catches the remaining case: a caller
--    that resends the same value in an UPDATE's SET list. Single column,
--    so a plain scalar comparison, not item_price_history's ROW(...)
--    IS DISTINCT FROM ROW(...) form — that form exists there to compare
--    three columns as one unit; one column doesn't need it.
--
--    AFTER UPDATE only — not AFTER INSERT OR UPDATE, unlike
--    item_price_history. A brand-new contract is born with a state (NOT
--    NULL DEFAULT 'active' on the column itself); that starting condition
--    is not a change a person made, it is just where the row began. Only
--    an UPDATE — someone deliberately moving it later — is a fact worth
--    logging. old_state is therefore NOT NULL here (there is always a
--    real prior value once an UPDATE has fired), unlike item_price_history's
--    nullable old_* columns (which can genuinely be a first-ever value).
--
-- 2. No insert/update/delete grant to authenticated at all — only
--    log_contract_state_change() (security definer) ever writes here,
--    exactly the item_price_history posture: no caller, app-level or
--    otherwise, can write a state change without going through
--    contracts.contract_state itself, and therefore cannot bypass the log
--    the way the bulk load bypassed commitRate's read-back.
--
-- 3. Read gate: is_member(contract_id) alone — no right required. This is
--    the one place this migration diverges from item_price_history's own
--    gate (view_rates), deliberately: item_prices is finance data, walled
--    off from a field seat by design (0002's whole point). Contract state
--    is not finance data — it's a fact about the contract's own lifecycle,
--    and the CURRENT value is already visible to every member regardless
--    of rights: contracts_select_member (0009) is `is_member(id)` with no
--    right attached, which is exactly why Portfolio's ContractStateTag
--    already renders for every seat, not just seats holding some specific
--    right. A history of a fact that's unconditionally visible should be
--    unconditionally visible on the same terms — gating the history behind
--    a right the current value was never gated behind would make the past
--    less visible than the present for no reason tied to what the data
--    actually is.
--
-- 4. contracts has no updated_at/updated_by at all (confirmed: neither
--    column exists, and no trigger stamps either) — unlike item_prices,
--    which has both via stamp_price_update(). Worth adding on its own
--    merits (any column change today leaves zero trace of who touched the
--    row last, not just contract_state), but explicitly out of scope here
--    per instruction — not added in this migration.
--
-- Tenancy through is_member() only, unchanged. No view involved.
-- =============================================================================

create table public.contract_state_history (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  changed_at  timestamptz not null default now(),
  changed_by  uuid references public.profiles(id),
  old_state   text not null check (old_state in ('pipeline', 'active', 'warranty_period', 'closed_out', 'archived')),
  new_state   text not null check (new_state in ('pipeline', 'active', 'warranty_period', 'closed_out', 'archived'))
);

create index contract_state_history_contract_idx
  on public.contract_state_history (contract_id, changed_at desc);

comment on table public.contract_state_history is
  'Append-only log of every real change to contracts.contract_state — '
  'written only by log_contract_state_change() (security definer), never '
  'directly. A brand-new contract''s starting state is not logged (see '
  'this migration''s own header) — only a later, deliberate move is.';

-- -----------------------------------------------------------------------------
-- Trigger — column-scoped (`of contract_state`) so an update that never
-- touches this column never fires it at all; the IS DISTINCT FROM guard
-- inside catches the remaining case of a same-value resend.
-- -----------------------------------------------------------------------------
create or replace function public.log_contract_state_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.contract_state is distinct from new.contract_state then
    insert into public.contract_state_history (contract_id, changed_by, old_state, new_state)
    values (new.id, auth.uid(), old.contract_state, new.contract_state);
  end if;
  return new;
end;
$$;

create trigger contracts_state_history_log
  after update of contract_state on public.contracts
  for each row execute function public.log_contract_state_change();

-- -----------------------------------------------------------------------------
-- RLS — any seated member reads it (see point 3 above); no write surface
-- for authenticated at all.
-- -----------------------------------------------------------------------------
alter table public.contract_state_history enable row level security;

revoke all on public.contract_state_history from anon, authenticated;
grant select on public.contract_state_history to authenticated;

create policy contract_state_history_select_member on public.contract_state_history
  for select to authenticated
  using (public.is_member(contract_id));

-- =============================================================================
-- Verify —
--
--   -- change a sandbox contract's state, confirm the trigger logged it:
--   update contracts set contract_state = 'closed_out' where id = '<a sandbox contract id>';
--   select old_state, new_state, changed_by from contract_state_history
--   where contract_id = '<same id>' order by changed_at desc limit 1;
--   -- expect old_state = the previous value, new_state = 'closed_out'
--
--   -- a non-state update logs nothing:
--   update contracts set tender_price = 12345 where id = '<same id>';
--   -- expect no new row in contract_state_history for that contract
--
--   -- re-sending the same state logs nothing:
--   update contracts set contract_state = 'closed_out' where id = '<same id>';
--   -- expect no new row (old.contract_state = new.contract_state)
--
--   -- a seated member with no particular right can still read it:
--   curl "$API/contract_state_history?select=*&contract_id=eq.<id>" -H "apikey: $ANON" \
--     -H "Authorization: Bearer <any seated member's token>"
--   -- expect 200, rows
--
--   -- a non-member cannot:
--   -- expect 200, []
--
--   -- no direct write path exists for anyone:
--   curl -X POST "$API/contract_state_history" -H "apikey: $ANON" \
--     -H "Authorization: Bearer <any token, any rights>" \
--     -H "Content-Type: application/json" -d '{"contract_id":"...","old_state":"active","new_state":"archived"}'
--   -- expect rejected (no insert grant to authenticated)
-- =============================================================================
