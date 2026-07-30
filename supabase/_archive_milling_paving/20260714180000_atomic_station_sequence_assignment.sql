-- Fixes a real race, not just bad test data: station_sequence was assigned
-- client-side from the local offline queue (existingCount + 1, see
-- enqueueWidthReading in src/lib/sync/widthReadingsSync.ts), with nothing
-- server-side preventing two clients — two devices, or one device after
-- local storage was cleared between sessions — from each computing the
-- same "next" value for the same (road_segment_id, paving_date, direction)
-- group before either had seen the other's insert. Confirmed in production
-- data: two rows for the same segment/day/direction both landed on
-- station_sequence = 1, entered ~9.5 hours apart by the same crew member —
-- consistent with a device syncing after a long gap, not a same-instant
-- collision. That then crashed calculateSegments' strict-ordering check
-- (src/lib/calculations/segmentArea.ts) for anyone who loaded the segment.
--
-- Two layers, both scoped to exclude correction rows — corrections
-- deliberately REUSE the original's station_sequence (see
-- supersedeWidthReading, same file: the corrected row takes over the
-- original's slot in field-entry order) via a two-step insert-then-update
-- that isn't atomic from the client's perspective, so a naive constraint
-- covering correction rows too would reject that insert during the brief
-- window where both the original and its replacement are active with the
-- same sequence. Excluding is_correction rows sidesteps that entirely
-- without needing to touch the existing correction flow.

-- station_sequence stays numeric, not integer, on purpose — a planned
-- future feature inserts a reading between two existing stations using a
-- fractional sequence value (e.g. 5.5 between 5 and 6), which an integer
-- column can't represent. It was declared `integer` in the original
-- migration; this widens it losslessly (every existing value is a whole
-- number) rather than letting this fix cement integer typing further.
alter table width_readings
  alter column station_sequence type numeric(10, 3);

-- Superseded by the unique index below, which covers the same lookup
-- pattern (road_segment_id, paving_date, direction, station_sequence) —
-- keeping both would be redundant.
drop index if exists idx_width_readings_segment_day_direction_seq;

-- The actual invariant that matters to every consumer (they all filter to
-- superseded_by is null before assuming strict station_sequence order —
-- see calculateSegments' callers) is "no two ACTIVE rows share a
-- sequence". Scoping to `not is_correction` rather than `superseded_by is
-- null` is a deliberately narrower, safer proxy for that: a correction row
-- is inserted with superseded_by still null (it's the new active row), so
-- a `superseded_by is null` condition would still collide against it
-- during supersedeWidthReading's insert-before-update window. Excluding
-- is_correction rows entirely avoids that, at no real cost — corrections
-- can never collide with each other in a way that matters, since each one
-- individually supersedes exactly the row whose slot it's reusing.
create unique index idx_width_readings_segment_day_direction_seq
  on width_readings (road_segment_id, paving_date, direction, station_sequence)
  where not is_correction;

-- Assigns station_sequence server-side for newly-appended (non-correction)
-- readings — the client stops being the source of truth for the persisted
-- value. It may still compute its own count locally for offline
-- ordering/display before sync (see enqueueWidthReading), but whatever it
-- sends here is overwritten unconditionally below.
create or replace function assign_width_reading_sequence()
returns trigger
language plpgsql
as $$
declare
  next_seq numeric;
begin
  -- Serializes concurrent inserts for the same (segment, date, direction)
  -- group: the second transaction blocks here until the first commits,
  -- then sees that committed row in the MAX() below, instead of both
  -- reading a stale MAX and computing the same value. pg_advisory_xact_lock
  -- is released automatically at transaction end (commit or rollback), so
  -- it can never be left stuck held by a crashed or disconnected client.
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

create trigger width_readings_assign_sequence
before insert on width_readings
for each row
when (not new.is_correction)
execute function assign_width_reading_sequence();
