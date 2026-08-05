-- =============================================================================
-- NovaCore v1 — Migration 0022: confirmation requires a witnessed version
--
-- THE PROBLEM. ConfirmQueueScreen (and every other screen's own per-row
-- Confirm button) fetches a draft once, then confirms it later by id.
-- Since 0021 made a draft editable in place, a second person's edit can
-- land in the window between that fetch and the click. confirmQuantityRecord
-- has only ever sent {status: 'confirmed'} — never the field values — so
-- the row that gets confirmed was always the current one, never a stale
-- overwrite. The defect isn't a stale WRITE. It's an unwitnessed one: the
-- PM can confirm a number she never actually saw, with nothing telling her
-- it happened. Confirmation is the moment a record becomes a claim, and the
-- claim's whole defensibility rests on someone having looked at the figure
-- being claimed. A confirmation nobody witnessed can't carry that weight.
--
-- THE FIX. A `version` column, bumped by guard_entry_transitions() itself
-- (same trigger, same place append-only and the confirm-is-not-an-edit-path
-- checks already live) whenever a draft's capture fields actually change.
-- Confirming now goes through confirm_quantity_record(id, expected_version)
-- — a single atomic UPDATE ... WHERE id = ... AND version = ... AND
-- status = 'draft'. If nothing changed since the version the caller read,
-- the row updates. If it has, zero rows match and the function raises a
-- distinct, greppable error rather than silently no-op'ing — the caller
-- cannot mistake "confirmed" for "stale, go look again."
--
-- WHY POSTGRES, NOT REACT. A React-side "is this stale?" check reads a
-- version, compares it in JS, and THEN issues a separate write — two round
-- trips with a gap between them, which is exactly the race this migration
-- exists to close, just narrowed rather than removed. It is also only a
-- courtesy: nothing stops a differently-written call site (a future screen,
-- a script, curl against the REST API) from confirming without ever reading
-- a version at all, because the write path itself doesn't require one.
-- The fix here is therefore NOT "add a version and hope every caller
-- remembers to check it" — the plain UPDATE-to-confirmed grant is REVOKED
-- outright (section 2 below) and quantity_records_confirm_right is dropped.
-- After this migration there is no way to set status = 'confirmed' on any
-- row, from any caller, other than through confirm_quantity_record(), and
-- that function will not perform the write unless the version supplied
-- matches the row's current version in the SAME atomic statement. The
-- guarantee lives in the one place a bypass can't reach it, not in the one
-- screen that happens to call it correctly today.
--
-- Same reason this function is SECURITY DEFINER as every other function in
-- this file: it needs to read past RLS to give an honest, distinguishing
-- answer (stale vs not-found vs no-permission vs already-confirmed) instead
-- of one flat "0 rows" for every case — but SECURITY DEFINER means RLS is
-- NOT applied automatically, so the function re-checks is_member()/
-- has_right() itself, explicitly, same standing rule as always: tenancy is
-- expressed ONLY through is_member()/has_right()/has_global_right(), never
-- an inlined subquery.
--
-- Append-only is unchanged: guard_entry_transitions()'s existing branches
-- (confirmed rows immutable, confirm-is-not-an-edit-path) are untouched —
-- this migration only adds a version bump alongside them.
--
-- Requires migrations through 0021.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. version — bumped only when a draft's own capture fields actually
--    change (the same six columns 0021 made editable). Never client-set:
--    no grant needed at all, since a BEFORE trigger may assign NEW.<col>
--    regardless of the invoking statement's own column grants — same as
--    confirmed_by/confirmed_at already do.
-- -----------------------------------------------------------------------------
alter table public.quantity_records
  add column version integer not null default 1;

comment on column public.quantity_records.version is
  'Bumped by guard_entry_transitions() on every real draft edit. '
  'confirm_quantity_record() requires this to match what the caller last '
  'read, atomically, so a confirmation can never sail past an edit it '
  'never saw.';

-- -----------------------------------------------------------------------------
-- 2. Revoke the plain confirm path outright — belt. Nothing may set status
--    (or the confirmation-audit columns that move with it) except the RPC
--    below and the trigger's own coalescing. Column grants for the six
--    capture fields (0021, draft editing) are untouched.
-- -----------------------------------------------------------------------------
revoke update (status, confirmed_by, confirmed_at)
  on public.quantity_records from authenticated;

drop policy if exists quantity_records_confirm_right on public.quantity_records;

-- -----------------------------------------------------------------------------
-- 3. Trigger — version bump alongside the existing branches. Only a
--    draft -> draft update whose capture fields genuinely differ bumps it;
--    confirming doesn't change what was claimed, only that it's now a claim.
-- -----------------------------------------------------------------------------
create or replace function public.guard_entry_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'confirmed' and new.status = 'draft' then
    raise exception
      'a confirmed record cannot be un-confirmed; supersede it instead';
  end if;

  if row(new.contract_id, new.item_id, new.supersedes, new.created_by, new.device_id)
     is distinct from
     row(old.contract_id, old.item_id, old.supersedes, old.created_by, old.device_id)
  then
    raise exception
      'quantity_records identity columns (contract_id, item_id, supersedes, '
      'created_by, device_id) are immutable';
  end if;

  if old.status = 'confirmed'
     and row(new.work_date, new.quantity, new.location, new.note,
             new.station_from, new.station_to)
       is distinct from
       row(old.work_date, old.quantity, old.location, old.note,
           old.station_from, old.station_to)
  then
    raise exception
      'quantity_records rows are append-only once confirmed; correct by '
      'inserting a superseding row';
  end if;

  if old.status = 'draft' and new.status = 'confirmed'
     and row(new.work_date, new.quantity, new.location, new.note,
             new.station_from, new.station_to)
       is distinct from
       row(old.work_date, old.quantity, old.location, old.note,
           old.station_from, old.station_to)
  then
    raise exception
      'cannot edit quantity_records fields in the same statement that '
      'confirms them; edit while draft, then confirm separately';
  end if;

  -- The version bump: a real draft edit, and only a real draft edit.
  if old.status = 'draft' and new.status = 'draft'
     and row(new.work_date, new.quantity, new.location, new.note,
             new.station_from, new.station_to)
       is distinct from
       row(old.work_date, old.quantity, old.location, old.note,
           old.station_from, old.station_to)
  then
    new.version := old.version + 1;
  end if;

  if old.status = 'draft' and new.status = 'confirmed' then
    new.confirmed_by := auth.uid();
    new.confirmed_at := now();
  end if;

  if old.status = 'confirmed' and new.status = 'confirmed' then
    new.confirmed_by := old.confirmed_by;
    new.confirmed_at := old.confirmed_at;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. confirm_quantity_record() — the only door left. One atomic statement:
--    the compare (version match) and the write (status -> confirmed) happen
--    together, so nothing can land in between them. A miss is diagnosed
--    (stale vs already-confirmed vs not visible at all) rather than left as
--    an ambiguous empty result — distinguishable by the message prefix, same
--    convention this repo's probes already grep on (see 0003/0004's
--    "append-only" checks).
-- -----------------------------------------------------------------------------
create or replace function public.confirm_quantity_record(p_id uuid, p_expected_version integer)
returns public.quantity_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_id     uuid;
  v_current_version integer;
  v_current_status  text;
  result            public.quantity_records;
begin
  -- SECURITY DEFINER bypasses RLS entirely — every visibility and rights
  -- decision from here on is explicit, never implicit.
  select contract_id into v_contract_id
  from public.quantity_records
  where id = p_id;

  if v_contract_id is null then
    raise exception 'not-found: no such quantity_record';
  end if;

  if not public.is_member(v_contract_id) then
    raise exception 'not-found: no such quantity_record';
  end if;

  if not public.has_right(v_contract_id, 'confirm_quantity') then
    raise exception 'not-permitted: confirm_quantity right required';
  end if;

  update public.quantity_records
  set status = 'confirmed'
  where id = p_id
    and version = p_expected_version
    and status = 'draft'
  returning * into result;

  if found then
    return result;
  end if;

  select version, status into v_current_version, v_current_status
  from public.quantity_records
  where id = p_id;

  if v_current_status <> 'draft' then
    raise exception 'already-confirmed: this record is no longer a draft';
  end if;

  raise exception
    'stale-version: this record has changed since it was loaded — reload it before confirming';
end;
$$;

comment on function public.confirm_quantity_record(uuid, integer) is
  'The only way status may become confirmed. Requires the caller''s last-read '
  'version to match the row''s current version in the same atomic statement — '
  'a confirmation can never land on a row the caller has not actually seen.';

revoke execute on function public.confirm_quantity_record(uuid, integer) from public;
grant execute on function public.confirm_quantity_record(uuid, integer) to authenticated;

-- =============================================================================
-- Verify —
--
--   select confirm_quantity_record('<draft id>', 1);
--   -- expect: succeeds, returns the row with status = confirmed, IF version
--   -- is still 1 (untouched since insert).
--
--   -- edit the same row first (bumps version to 2), then:
--   select confirm_quantity_record('<same id>', 1);
--   -- expect: raises 'stale-version: ...' — the edit was never witnessed.
--
--   select confirm_quantity_record('<same id>', 2);
--   -- expect: succeeds — this IS the version that was actually last read.
--
--   update quantity_records set status = 'confirmed' where id = '<any id>';
--   -- expect: fails outright — no UPDATE privilege on status at all anymore.
-- =============================================================================
