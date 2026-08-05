-- =============================================================================
-- NovaCore v1 — Migration 0021: drafts are editable, supersession begins at
-- confirmation
--
-- THE DISTINCTION. Confirmation is the moment a quantity_record becomes a
-- claim about what happened. After that, nothing is edited — only superseded
-- — because the claim was made and someone may have relied on it. Before
-- that, it's a draft nobody has asserted, and editing it in place loses
-- nothing anyone needs.
--
-- Before this migration, a correction to an unconfirmed record created a
-- superseding row exactly as it would for a confirmed one — wrong twice: it
-- treated a draft as if it had been claimed, and it wrote permanent audit
-- history for something that never counted. The ordinary case this exists
-- for: a superintendent reviews the tablet before the session ends and says
-- the number is off. That isn't a correction to the record of the day; it's
-- the record not being finished yet.
--
-- WHAT CHANGES. An unconfirmed quantity_record is now editable in place —
-- quantity, location, note, station_from, station_to, work_date. A confirmed
-- one can only be superseded, exactly as before this migration.
--
-- Editing a draft requires enter_quantity, not correct_quantity, and any
-- seat holding enter_quantity on the contract may edit ANY draft on it — not
-- only its own author's. Field staff share tablets; the person giving the
-- feedback is often not the person who typed it. This is deliberately NOT
-- scoped by created_by, unlike the insert policy.
--
-- ENFORCEMENT, belt and braces, same pattern as 0002/0004:
--   - GRANT (belt): quantity/location/note/station_from/station_to/work_date
--     are now column-grantable to `authenticated` at all — previously they
--     were not, which alone blocked every edit regardless of policy. This
--     grant is unconditional (Postgres grants cannot be conditioned on row
--     state), so it widens WHAT COLUMNS CAN EVER BE TOUCHED, not by whom or
--     when — that narrowing is RLS's and the trigger's job.
--   - RLS (braces #1): a new permissive UPDATE policy, gated on
--     status = 'draft' (checked in BOTH using and with check, so a request
--     can neither target a confirmed row nor use this policy to leave a row
--     confirmed-but-edited) and has_right(contract_id, 'enter_quantity').
--     Permissive policies on the same table OR together — this does not
--     weaken quantity_records_confirm_right, it adds an independent path.
--   - Trigger (braces #2, the one that actually closes the gap RLS alone
--     cannot): guard_entry_transitions() no longer applies one blanket
--     append-only check to every UPDATE. It now:
--       1. always requires contract_id/item_id/supersedes/created_by/
--          device_id unchanged (identity, immutable regardless of status —
--          unaffected by this migration, just restated explicitly instead
--          of folded into the old one-size-fits-all row(...) comparison);
--       2. if OLD.status = 'confirmed', requires every capture field
--          unchanged (append-only, exactly as before this migration);
--       3. if OLD.status = 'draft' AND NEW.status = 'confirmed', ALSO
--          requires every capture field unchanged — the confirm action
--          itself is not an edit path. Without this check, a seat holding
--          confirm_quantity but not enter_quantity could pass RLS by
--          combining a status→confirmed change (which its own policy
--          permits, regardless of what else is in the same statement) with
--          a capture-field change in one PATCH — RLS alone cannot see across
--          policies to forbid that combination, since permissive policies
--          are evaluated independently and OR'd. The trigger is what
--          actually prevents "the draft-edit path becoming a route to
--          altering a confirmed one," per row state, below any policy.
--   - A draft→draft update (no status change) hits neither branch 2 nor 3,
--     so the capture fields are free to change — exactly the new behaviour,
--     and the ONLY case where they are.
--
-- Requires migrations through 0019. (0020, seating three Finance accounts on
-- Hwy 5, is prepared but intentionally not yet applied — unrelated to this
-- file, see that migration's own header.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Grant — belt. Additive: does not replace the existing
--    grant update (status, confirmed_by, confirmed_at), it supplements it.
-- -----------------------------------------------------------------------------
grant update (quantity, location, note, station_from, station_to, work_date)
  on public.quantity_records to authenticated;

-- -----------------------------------------------------------------------------
-- 2. RLS — braces #1. Tenancy expressed only through has_right(), per the
--    standing rule in 0001/0009: no inlined subquery against
--    contract_members anywhere in this file.
-- -----------------------------------------------------------------------------
create policy quantity_records_edit_draft_right on public.quantity_records
  for update to authenticated
  using (
    status = 'draft'
    and public.has_right(contract_id, 'enter_quantity')
  )
  with check (
    status = 'draft'
    and public.has_right(contract_id, 'enter_quantity')
  );

-- -----------------------------------------------------------------------------
-- 3. Trigger — braces #2. Replaces the single blanket append-only check with
--    status-conditional ones. See header for why each branch exists.
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

  -- Identity and structural columns never change after insert, draft or
  -- confirmed — which contract/Item/parent a row belongs to, who wrote it,
  -- and from which device are facts about the row's creation, not part of
  -- what a draft edit or a correction may revise.
  if row(new.contract_id, new.item_id, new.supersedes, new.created_by, new.device_id)
     is distinct from
     row(old.contract_id, old.item_id, old.supersedes, old.created_by, old.device_id)
  then
    raise exception
      'quantity_records identity columns (contract_id, item_id, supersedes, '
      'created_by, device_id) are immutable';
  end if;

  -- Confirmed rows are append-only, exactly as before this migration.
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

  -- The confirm action is not an edit path: draft -> confirmed may not
  -- smuggle a capture-field change into the same statement, even from a
  -- seat holding confirm_quantity. Edit while draft, then confirm the
  -- edited version, as two separate actions.
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

-- =============================================================================
-- Verify — a draft edited by a non-author enter_quantity seat, then blocked
-- the instant it's confirmed:
--
--   -- as a seat with enter_quantity, not the row's created_by:
--   update quantity_records set quantity = 42 where id = '<some draft id>';
--   -- expect: 1 row, succeeds
--
--   -- after that same row is confirmed:
--   update quantity_records set quantity = 43 where id = '<same id>';
--   -- expect: 0 rows visible (RLS), or, from the postgres role directly,
--   -- P0001 'append-only once confirmed'
-- =============================================================================
