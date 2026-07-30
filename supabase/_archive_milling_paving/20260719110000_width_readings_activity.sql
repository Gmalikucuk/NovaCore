-- width_readings has never distinguished which activity a reading belongs
-- to — investigated directly against the live schema before writing this,
-- not assumed either way. Every one of its 16 existing rows is Milling
-- (Paving has no entry screen yet), but Paving's own design depends on
-- being able to query "this segment+direction's MILLING readings
-- specifically" as a set distinct from its own — that requires a real
-- discriminator, not an implicit "the table has only ever held one
-- activity" assumption that Paving's own first write would break.
alter table width_readings add column activity text;

update width_readings set activity = 'milling' where activity is null;

alter table width_readings alter column activity set not null;
alter table width_readings add constraint width_readings_activity_check
  check (activity in ('milling', 'paving'));

create index idx_width_readings_activity on width_readings (activity);

-- enforce_width_readings_update_columns' append-only guard predates this
-- column and doesn't know about it — without this, activity would be the
-- one column silently exempt from the "rows are append-only" rule, letting
-- an existing milling reading be flipped to paving in place.
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
     or new.activity is distinct from old.activity
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

-- The uniqueness invariant (see 20260714180000) and the sequence-assignment
-- trigger below were both scoped by (road_segment_id, paving_date,
-- direction) only — a milling walk and a paving walk sharing that same
-- segment/date/direction would otherwise draw from one shared
-- station_sequence numbering space instead of each having its own
-- independent field-entry order. Not a sorting bug (every real consumer
-- filters to one activity before sorting) but the wrong model regardless:
-- these are two unrelated walks, not one shared sequence that happens not
-- to collide.
drop index if exists idx_width_readings_segment_day_direction_seq;
create unique index idx_width_readings_segment_day_direction_seq
  on width_readings (road_segment_id, paving_date, direction, activity, station_sequence)
  where not is_correction;

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
    new.road_segment_id::text || '|' || new.paving_date::text || '|' || new.direction || '|' || new.activity,
    0
  ));

  select coalesce(max(station_sequence), 0) + 1
  into next_seq
  from width_readings
  where road_segment_id = new.road_segment_id
    and paving_date = new.paving_date
    and direction = new.direction
    and activity = new.activity;

  new.station_sequence := next_seq;
  return new;
end;
$$;

-- Same activity-scoping added to both insert-between-readings functions'
-- advisory lock key and neighbor lookups — after_row.activity/
-- before_row.activity carry through into the inserted row too, so a
-- manual insert can never silently cross activities.
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

  perform pg_advisory_xact_lock(hashtextextended(
    after_row.road_segment_id::text || '|' || after_row.paving_date::text || '|' || after_row.direction || '|' || after_row.activity,
    0
  ));

  select min(station_sequence) into next_seq
  from width_readings
  where road_segment_id = after_row.road_segment_id
    and paving_date = after_row.paving_date
    and direction = after_row.direction
    and activity = after_row.activity
    and station_sequence > after_row.station_sequence;

  if next_seq is null then
    new_seq := after_row.station_sequence + 1;
  else
    new_seq := round((after_row.station_sequence + next_seq) / 2, 3);
    if new_seq <= after_row.station_sequence or new_seq >= next_seq then
      raise exception 'No room left to insert a reading between station_sequence % and %', after_row.station_sequence, next_seq;
    end if;
  end if;

  perform set_config('app.width_reading_manual_sequence', 'true', true);

  insert into width_readings (road_segment_id, paving_date, direction, activity, station_sequence, station, width, is_correction)
  values (after_row.road_segment_id, after_row.paving_date, after_row.direction, after_row.activity, new_seq, new_station, new_width, false)
  returning * into result;

  return result;
end;
$$;

create or replace function insert_width_reading_before(
  before_reading_id uuid,
  new_station numeric,
  new_width numeric
)
returns width_readings
language plpgsql
security invoker
set search_path = public
as $$
declare
  before_row width_readings;
  prev_seq numeric;
  new_seq numeric;
  result width_readings;
begin
  select * into before_row from width_readings where id = before_reading_id;
  if not found then
    raise exception 'Reading % not found', before_reading_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    before_row.road_segment_id::text || '|' || before_row.paving_date::text || '|' || before_row.direction || '|' || before_row.activity,
    0
  ));

  select max(station_sequence) into prev_seq
  from width_readings
  where road_segment_id = before_row.road_segment_id
    and paving_date = before_row.paving_date
    and direction = before_row.direction
    and activity = before_row.activity
    and station_sequence < before_row.station_sequence;

  if prev_seq is null then
    new_seq := before_row.station_sequence - 1;
  else
    new_seq := round((prev_seq + before_row.station_sequence) / 2, 3);
    if new_seq <= prev_seq or new_seq >= before_row.station_sequence then
      raise exception 'No room left to insert a reading between station_sequence % and %', prev_seq, before_row.station_sequence;
    end if;
  end if;

  perform set_config('app.width_reading_manual_sequence', 'true', true);

  insert into width_readings (road_segment_id, paving_date, direction, activity, station_sequence, station, width, is_correction)
  values (before_row.road_segment_id, before_row.paving_date, before_row.direction, before_row.activity, new_seq, new_station, new_width, false)
  returning * into result;

  return result;
end;
$$;
