-- Mirror of insert_width_reading_between (see 20260716200000) for the
-- other direction: inserting a reading BEFORE an existing one, for a
-- station the crew missed on the near side instead of the far side.
--
-- Mirror-image edge case: insert_width_reading_between falls back to a
-- plain append (after_row.station_sequence + 1) when there's nothing after
-- the target reading yet, since there's no "next neighbor" to compute a
-- midpoint against. Inserting before the FIRST reading in a session has
-- the same problem in the other direction — no PRIOR neighbor to compute a
-- midpoint from — so it falls back the same way: one below the current
-- minimum (before_row.station_sequence - 1) rather than a midpoint, since
-- there's nothing to be a midpoint between. station_sequence has no
-- positivity constraint, so this can go negative across repeated
-- before-inserts at the head of a session without issue — only relative
-- ordering matters anywhere this column is read.
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

  -- Same per-group lock assign_width_reading_sequence and
  -- insert_width_reading_between both take, so a concurrent append and
  -- this midpoint computation can never race against the same group's
  -- current ordering.
  perform pg_advisory_xact_lock(hashtextextended(
    before_row.road_segment_id::text || '|' || before_row.paving_date::text || '|' || before_row.direction,
    0
  ));

  select max(station_sequence) into prev_seq
  from width_readings
  where road_segment_id = before_row.road_segment_id
    and paving_date = before_row.paving_date
    and direction = before_row.direction
    and station_sequence < before_row.station_sequence;

  if prev_seq is null then
    -- Nothing before this reading yet — see the header comment.
    new_seq := before_row.station_sequence - 1;
  else
    -- Rounded to the column's own scale (numeric(10,3)) BEFORE comparing —
    -- same reasoning as insert_width_reading_between: an unrounded
    -- midpoint can look strictly between the two neighbors while still
    -- rounding to exactly one of them once stored.
    new_seq := round((prev_seq + before_row.station_sequence) / 2, 3);
    if new_seq <= prev_seq or new_seq >= before_row.station_sequence then
      raise exception 'No room left to insert a reading between station_sequence % and %', prev_seq, before_row.station_sequence;
    end if;
  end if;

  perform set_config('app.width_reading_manual_sequence', 'true', true);

  insert into width_readings (road_segment_id, paving_date, direction, station_sequence, station, width, is_correction)
  values (before_row.road_segment_id, before_row.paving_date, before_row.direction, new_seq, new_station, new_width, false)
  returning * into result;

  return result;
end;
$$;
