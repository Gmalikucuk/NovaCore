-- Section 2: Geometry — the shared "map" all activities reference.

create table road_segments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs (id),
  highway text not null,
  direction text not null check (direction in ('NB', 'SB', 'EB', 'WB')),
  from_station numeric(12,3) not null,
  to_station numeric(12,3) not null,
  lane_config text,

  -- Rollover-aware length, computed the same way as segment-level readings.
  -- The 5000 threshold mirrors ROLLOVER_THRESHOLD in
  -- src/lib/calculations/segmentArea.ts — keep both in sync if the chainage
  -- rollover point ever changes.
  segment_length numeric(12,3) generated always as (
    case when abs(to_station - from_station) > 5000 then 0
         else abs(to_station - from_station)
    end
  ) stored,

  created_at timestamptz not null default now()
);

create index idx_road_segments_job_id on road_segments (job_id);
create index idx_road_segments_from_station on road_segments (from_station);
create index idx_road_segments_to_station on road_segments (to_station);
create index idx_road_segments_direction on road_segments (direction);
