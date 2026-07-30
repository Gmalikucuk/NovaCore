-- =============================================================================
-- NovaCore v1 — Migration 0004: structured station capture
--
-- 0001 stored location as free text, per the spec's deliberate simplification.
-- The field entry UI captures either a single station or a from–to reach, which
-- means real structure was being flattened into a string on the way in.
--
-- These columns are CAPTURED, not computed. No area, no width, no application
-- rate — those are a later increment and deliberately absent here. The point is
-- that when that increment arrives, the numbers are already in the database in
-- a form that can be queried, rather than needing to be parsed back out of
-- text nobody validated.
--
-- `location` is kept as the free-text site / reach label (e.g. "Job B Reach 1",
-- "Coldwater NB"). No project_sites table in v1: a segment table earns its
-- place once something computes against it.
-- =============================================================================

alter table public.daily_entries
  add column station_from numeric,
  add column station_to   numeric;

comment on column public.daily_entries.station_from is
  'Chainage in km, as entered. A single-station entry sets this and leaves '
  'station_to null.';
comment on column public.daily_entries.station_to is
  'Chainage in km for the far end of a reach. Null for a single station. '
  'NOT constrained to be greater than station_from — stations legitimately run '
  'in opposite directions on opposing segments (e.g. Hwy 5 Job B NB 2090 vs '
  'SB 2091), so ordering carries meaning and must not be normalised away.';

-- A far end with no near end is meaningless.
alter table public.daily_entries
  add constraint daily_entries_station_pair
  check (station_to is null or station_from is not null);

-- The append-only guard in 0003 enumerates the columns that may not change on
-- an existing row. The two new columns must join that list, or a confirmed
-- entry's stations could be edited in place while its quantity could not.
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
         new.location, new.note, new.supersedes, new.created_by, new.device_id,
         new.station_from, new.station_to)
     is distinct from
     row(old.project_id, old.line_item_id, old.entry_date, old.quantity,
         old.location, old.note, old.supersedes, old.created_by, old.device_id,
         old.station_from, old.station_to)
  then
    raise exception
      'daily_entries rows are append-only; correct by inserting a superseding row';
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
