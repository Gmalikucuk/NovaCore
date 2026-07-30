-- Restructure road_segments to sit under road_segment_groups: the physical
-- road (both directions), which is only "complete" once both directions are
-- done for a given station range.

create table road_segment_groups (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs (id) on delete restrict,
  highway text not null,
  from_station numeric(12,3) not null,
  to_station numeric(12,3) not null,
  lane_config text,
  created_at timestamptz not null default now()
);

create index idx_road_segment_groups_job_id on road_segment_groups (job_id);
create index idx_road_segment_groups_from_station on road_segment_groups (from_station);
create index idx_road_segment_groups_to_station on road_segment_groups (to_station);

-- road_segments (0 rows currently, confirmed live before writing this — no
-- backfill needed) keeps its own from_station/to_station/direction exactly as
-- before: one direction can roll over at a different point than its
-- counterpart on the same group.
alter table road_segments add column segment_group_id uuid not null references road_segment_groups (id) on delete restrict;
create index idx_road_segments_segment_group_id on road_segments (segment_group_id);

-- Shoulder work is identified purely by which directional road_segment it
-- belongs to (in Canada the shoulder is always the right-hand edge relative
-- to that direction of travel), so the separate "side" attribute is redundant
-- and removed.
alter table surface_lifecycle_events drop constraint surface_lifecycle_events_side_only_for_shoulder;
alter table surface_lifecycle_events drop column side;

-- road_segment_groups gets the same broad-access RLS treatment as
-- road_segments (same "reference geometry" category, protected from
-- accidental deletion by the ON DELETE RESTRICT FKs pointing into it).
alter table road_segment_groups enable row level security;

create policy road_segment_groups_select on road_segment_groups for select to anon, authenticated using (true);
create policy road_segment_groups_insert on road_segment_groups for insert to anon, authenticated with check (true);
create policy road_segment_groups_update on road_segment_groups for update to anon, authenticated using (true) with check (true);
create policy road_segment_groups_delete on road_segment_groups for delete to anon, authenticated using (true);

grant select, insert, update, delete on road_segment_groups to anon, authenticated;

-- LIMITATION worth flagging: surface_lifecycle_events has no station-range
-- columns of its own (only road_segment_id / event_type / event_date /
-- quantity), so "covering their full station range" can't be verified
-- literally — there's nothing to check the range against. This view instead
-- checks "at least one event of that type exists for this directional
-- road_segment", which is the closest available proxy given the current
-- schema. If per-event station ranges are ever added to
-- surface_lifecycle_events, this view should be tightened to actually verify
-- range coverage.
--
-- Also requires a group to have at least 2 road_segments before claiming
-- anything is complete — not explicitly requested, but without it a group
-- with only one direction entered so far (e.g. NB only, SB not yet created)
-- could otherwise read as "both directions milled" off a single row.
create view segment_group_completion_status as
with per_group as (
  select
    sg.id as segment_group_id,
    sg.job_id,
    sg.highway,
    sg.from_station,
    sg.to_station,
    count(rs.id) as segment_count,
    (count(rs.id) >= 2 and bool_and(
      exists (
        select 1 from surface_lifecycle_events sle
        where sle.road_segment_id = rs.id and sle.event_type = 'mill'
      )
    )) as both_directions_milled,
    (count(rs.id) >= 2 and bool_and(
      exists (
        select 1 from surface_lifecycle_events sle
        where sle.road_segment_id = rs.id and sle.event_type in ('top_lift', 'level_course')
      )
    )) as both_directions_paved,
    (count(rs.id) >= 2 and bool_and(
      exists (
        select 1 from surface_lifecycle_events sle
        where sle.road_segment_id = rs.id and sle.event_type = 'shouldering'
      )
    )) as both_directions_shouldered
  from road_segment_groups sg
  left join road_segments rs on rs.segment_group_id = sg.id
  group by sg.id, sg.job_id, sg.highway, sg.from_station, sg.to_station
)
select
  segment_group_id,
  job_id,
  highway,
  from_station,
  to_station,
  segment_count,
  both_directions_milled,
  both_directions_paved,
  both_directions_shouldered,
  (both_directions_milled and both_directions_paved and both_directions_shouldered) as fully_complete
from per_group;

revoke insert, update, delete, truncate on segment_group_completion_status from anon, authenticated;
grant select on segment_group_completion_status to anon, authenticated;
