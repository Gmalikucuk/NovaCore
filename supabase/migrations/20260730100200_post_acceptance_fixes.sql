-- =============================================================================
-- NovaCore v1 — Migration 0003: post-acceptance corrections
--
-- Two defects found during the Step 6 acceptance test. Neither is a security
-- hole; both are latent bugs that get expensive later.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Remove the redundant single-column FK on line_item_prices.
--
-- 0001 declared line_item_id both as an inline `references line_items(id)` and
-- as part of the composite `(line_item_id, project_id) references
-- line_items(id, project_id)`. Two constraints pointing at the same table means
-- PostgREST sees two valid relationships and returns 300 on any embed between
-- them (observed during acceptance probe 2).
--
-- The composite constraint is strictly stronger — it enforces the same
-- reference AND guarantees project coherence — so the single-column one carries
-- no information. Dropping it removes the ambiguity at the source rather than
-- forcing every future query to disambiguate by constraint name.
-- -----------------------------------------------------------------------------
alter table public.line_item_prices
  drop constraint if exists line_item_prices_line_item_id_fkey;

-- Verify exactly one FK to line_items remains. Should return a single row:
-- line_item_prices_line_item_id_project_id_fkey
--
--   select conname
--   from pg_constraint
--   where conrelid = 'public.line_item_prices'::regclass
--     and confrelid = 'public.line_items'::regclass;

-- -----------------------------------------------------------------------------
-- 2. Assign confirmed_by rather than defaulting it.
--
-- The column-level grant permits an authenticated client to send confirmed_by
-- in the request body, and coalesce() lets a supplied value win — so a PM could
-- attribute a confirmation to another user. Confirmation is the single action
-- that moves quantity into the finance dashboard, so its audit trail should be
-- assigned by the database, not accepted from the caller.
--
-- Same for confirmed_at: server clock, not client clock. A device with a wrong
-- system time should not be able to backdate a confirmation.
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
      'a confirmed entry cannot be un-confirmed; supersede it instead';
  end if;

  if row(new.project_id, new.line_item_id, new.entry_date, new.quantity,
         new.location, new.note, new.supersedes, new.created_by, new.device_id)
     is distinct from
     row(old.project_id, old.line_item_id, old.entry_date, old.quantity,
         old.location, old.note, old.supersedes, old.created_by, old.device_id)
  then
    raise exception
      'daily_entries rows are append-only; correct by inserting a superseding row';
  end if;

  if old.status = 'draft' and new.status = 'confirmed' then
    -- assigned, not coalesced: the caller's values are discarded
    new.confirmed_by := auth.uid();
    new.confirmed_at := now();
  end if;

  -- a confirmed row's audit fields are immutable thereafter
  if old.status = 'confirmed' and new.status = 'confirmed' then
    new.confirmed_by := old.confirmed_by;
    new.confirmed_at := old.confirmed_at;
  end if;

  return new;
end;
$$;
