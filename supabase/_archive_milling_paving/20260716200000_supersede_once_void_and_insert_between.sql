-- Three changes to width_readings, bundled because the second two both
-- extend the same append-only/correction machinery the first change closes
-- a gap in.

-- 1. superseded_by may currently be changed more than once — nothing stops
--    it going from one non-null value to a DIFFERENT non-null value (or
--    back to null), only who is allowed to change it at all. Once a
--    reading has been superseded, that link must be permanent.
create or replace function enforce_width_readings_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_coordinator boolean;
begin
  if new.road_segment_id is distinct from old.road_segment_id
     or new.paving_date is distinct from old.paving_date
     or new.direction is distinct from old.direction
     or new.station_sequence is distinct from old.station_sequence
     or new.station is distinct from old.station
     or new.width is distinct from old.width
     or new.entry_timestamp is distinct from old.entry_timestamp
     or new.entered_by is distinct from old.entered_by
     or new.is_correction is distinct from old.is_correction
  then
    raise exception 'width_readings rows are append-only; only superseded_by, is_voided, and correction_reason may be updated';
  end if;

  if new.superseded_by is distinct from old.superseded_by then
    if old.superseded_by is not null then
      raise exception 'width_readings.superseded_by may only be set once and cannot be changed';
    end if;

    select exists (
      select 1 from crew_members
      where id = public.effective_crew_member_id() and role = 'coordinator'
    ) into acting_is_coordinator;

    if not (coalesce(old.entered_by = public.effective_crew_member_id(), false) or acting_is_coordinator) then
      raise exception 'only the original entered_by crew member or a coordinator may set superseded_by';
    end if;
  end if;

  -- Voiding gets the same role gate as superseding — both are consequential,
  -- append-only-breaking-adjacent changes to a reading's status.
  if new.is_voided is distinct from old.is_voided then
    select exists (
      select 1 from crew_members
      where id = public.effective_crew_member_id() and role = 'coordinator'
    ) into acting_is_coordinator;

    if not (coalesce(old.entered_by = public.effective_crew_member_id(), false) or acting_is_coordinator) then
      raise exception 'only the original entered_by crew member or a coordinator may void a reading';
    end if;
  end if;

  return new;
end;
$$;

-- 2. Void support, same pattern truck_tickets already has (see
--    20260705120000_truck_tickets_correction_support.sql) — is_voided plus
--    the EXISTING correction_reason column, reused rather than duplicated
--    with a separate void_reason, since "why was this reading invalidated"
--    is the same question for a correction or a void. A voided reading is
--    never deleted (this table has no delete path at all) and is excluded
--    from area calculations going forward by the query layer, not by
--    hiding the row itself.
alter table width_readings add column is_voided boolean not null default false;

-- Tightens the existing check at the same time — it previously only
-- required correction_reason when is_correction was true, not when
-- superseded_by alone was set (a gap already flagged, but deliberately
-- left, in that same truck_tickets migration's comment). Fixing it here
-- since is_voided needs the same requirement anyway.
alter table width_readings drop constraint width_readings_correction_reason_required;
alter table width_readings add constraint width_readings_correction_reason_required
  check (not (is_correction or superseded_by is not null or is_voided) or correction_reason is not null);

-- 3. Inserting a reading between two existing ones, for a station a crew
--    missed the first time through. Needs its own atomic assignment — not
--    MAX(station_sequence) + 1 like a normal append (assign_width_reading_
--    sequence, see 20260714180000) but the midpoint between the two
--    neighboring sequence values, which only this function knows how to
--    compute. It still needs the row to go through the same per-group
--    advisory lock as a normal append, since a concurrent append choosing
--    its own MAX+1 at the same moment must not be able to land exactly on
--    the midpoint this function is about to choose.
--
--    The existing assign_width_reading_sequence trigger fires on every
--    non-correction insert and would otherwise clobber whatever sequence
--    value this function computes — bypassed here via a transaction-local
--    GUC flag rather than giving this row is_correction=true (it isn't a
--    correction, and needs to stay inside the same-sequence-uniqueness
--    index a correction row is deliberately exempt from).
create or replace function assign_width_reading_sequence()
returns trigger
language plpgsql
as $$
declare
  next_seq numeric;
begin
  if coalesce(current_setting('app.width_reading_manual_sequence', true), 'false') = 'true' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    new.road_segment_id::text || '|' || new.paving_date::text || '|' || new.direction,
    0
  ));

  select coalesce(max(station_sequence), 0) + 1
  into next_seq
  from width_readings
  where road_segment_id = new.road_segment_id
    and paving_date = new.paving_date
    and direction = new.direction;

  new.station_sequence := next_seq;
  return new;
end;
$$;

create or replace function insert_width_reading_between(
  after_reading_id uuid,
  new_station numeric,
  new_width numeric
)
returns width_readings
language plpgsql
security invoker
set search_path = public
as $$
declare
  after_row width_readings;
  next_seq numeric;
  new_seq numeric;
  result width_readings;
begin
  select * into after_row from width_readings where id = after_reading_id;
  if not found then
    raise exception 'Reading % not found', after_reading_id;
  end if;

  -- Same per-group lock assign_width_reading_sequence takes, so a
  -- concurrent append (MAX + 1) and this midpoint computation can never
  -- race against the same group's current ordering.
  perform pg_advisory_xact_lock(hashtextextended(
    after_row.road_segment_id::text || '|' || after_row.paving_date::text || '|' || after_row.direction,
    0
  ));

  select min(station_sequence) into next_seq
  from width_readings
  where road_segment_id = after_row.road_segment_id
    and paving_date = after_row.paving_date
    and direction = after_row.direction
    and station_sequence > after_row.station_sequence;

  if next_seq is null then
    -- Nothing after this reading yet — inserting "after" the last reading
    -- in the sequence is just a normal append.
    new_seq := after_row.station_sequence + 1;
  else
    -- Rounded to the column's own scale (numeric(10,3)) BEFORE comparing —
    -- an unrounded midpoint can look strictly between the two neighbors
    -- (e.g. 9.0005 between 9.000 and 9.001) while still rounding to
    -- exactly one of them once stored, which would otherwise surface as an
    -- opaque unique-constraint violation instead of this function's own
    -- clear "no room left" error.
    new_seq := round((after_row.station_sequence + next_seq) / 2, 3);
    if new_seq <= after_row.station_sequence or new_seq >= next_seq then
      raise exception 'No room left to insert a reading between station_sequence % and %', after_row.station_sequence, next_seq;
    end if;
  end if;

  perform set_config('app.width_reading_manual_sequence', 'true', true);

  insert into width_readings (road_segment_id, paving_date, direction, station_sequence, station, width, is_correction)
  values (after_row.road_segment_id, after_row.paving_date, after_row.direction, new_seq, new_station, new_width, false)
  returning * into result;

  return result;
end;
$$;
