-- Real interval coverage instead of existence-checking. Previously
-- segment_group_completion_status only checked "does at least one event of
-- this type exist for the segment" because surface_lifecycle_events had no
-- station range of its own. This adds that range and rewrites the view to
-- verify actual full-length coverage, with gaps correctly detected.
--
-- LIMITATION carried over from the previous migration, still applies here:
-- this does plain numeric interval math (least/greatest, no rollover
-- awareness). A segment or event that spans the chainage rollover boundary
-- would not merge/compare correctly. Flagging again since this migration
-- doesn't resolve it, just builds real coverage checking on top of the same
-- assumption.
--
-- TODO: segment_group_completion_status does not yet handle rollover-crossing
-- events correctly. Must fix before any real event is logged against a
-- Segment 2 NB road_segment whose range crosses the 45+060 to 0+000 rollover.

alter table surface_lifecycle_events add column from_station numeric(12,3) not null;
alter table surface_lifecycle_events add column to_station numeric(12,3) not null;

create index idx_surface_lifecycle_events_from_station on surface_lifecycle_events (from_station);
create index idx_surface_lifecycle_events_to_station on surface_lifecycle_events (to_station);
create index idx_surface_lifecycle_events_segment_type on surface_lifecycle_events (road_segment_id, event_type);

create or replace view segment_group_completion_status as
with segment_bounds as (
  select
    rs.id as road_segment_id,
    rs.segment_group_id,
    least(rs.from_station, rs.to_station) as seg_lo,
    greatest(rs.from_station, rs.to_station) as seg_hi
  from road_segments rs
),
-- mill / top_lift+level_course ("paved") / shouldering are the three
-- coverage types the completion view cares about; everything else
-- (tack_coat, shoulder_strip) doesn't feed a completion column.
relevant_events as (
  select
    sle.road_segment_id,
    (case
      when sle.event_type = 'mill' then 'mill'
      when sle.event_type in ('top_lift', 'level_course') then 'paved'
      when sle.event_type = 'shouldering' then 'shouldering'
    end) as coverage_type,
    least(sle.from_station, sle.to_station) as lo,
    greatest(sle.from_station, sle.to_station) as hi
  from surface_lifecycle_events sle
  where sle.event_type in ('mill', 'top_lift', 'level_course', 'shouldering')
),
-- Classic sweep-line interval merge: order by lo, track the running max hi
-- of everything seen so far (excluding the current row), and flag a new
-- merge group whenever the current lo falls strictly past that running max
-- (i.e. there's a real gap). Touching intervals (lo == running max) merge,
-- matching "next.from_station <= running_max_to_station".
ordered as (
  select
    road_segment_id,
    coverage_type,
    lo,
    hi,
    max(hi) over (
      partition by road_segment_id, coverage_type
      order by lo, hi
      rows between unbounded preceding and 1 preceding
    ) as running_max_hi
  from relevant_events
),
grouped as (
  select
    road_segment_id,
    coverage_type,
    lo,
    hi,
    sum(case when running_max_hi is null or lo > running_max_hi then 1 else 0 end)
      over (partition by road_segment_id, coverage_type order by lo, hi) as merge_group
  from ordered
),
merged_intervals as (
  select
    road_segment_id,
    coverage_type,
    min(lo) as merged_lo,
    max(hi) as merged_hi
  from grouped
  group by road_segment_id, coverage_type, merge_group
),
-- Every road_segment gets exactly one row per coverage_type (via the cross
-- join), so "no events at all for this type" correctly reads as
-- fully_covered = false rather than being silently absent.
segment_coverage as (
  select
    sb.road_segment_id,
    sb.segment_group_id,
    ct.coverage_type,
    exists (
      select 1 from merged_intervals mi
      where mi.road_segment_id = sb.road_segment_id
        and mi.coverage_type = ct.coverage_type
        and mi.merged_lo <= sb.seg_lo
        and mi.merged_hi >= sb.seg_hi
    ) as fully_covered
  from segment_bounds sb
  cross join (values ('mill'), ('paved'), ('shouldering')) as ct (coverage_type)
),
per_group as (
  select
    sg.id as segment_group_id,
    sg.job_id,
    sg.highway,
    sg.from_station,
    sg.to_station,
    count(distinct rs.id) as segment_count,
    (
      count(distinct rs.id) >= 2
      and bool_and(sc.fully_covered) filter (where sc.coverage_type = 'mill')
    ) as both_directions_milled,
    (
      count(distinct rs.id) >= 2
      and bool_and(sc.fully_covered) filter (where sc.coverage_type = 'paved')
    ) as both_directions_paved,
    (
      count(distinct rs.id) >= 2
      and bool_and(sc.fully_covered) filter (where sc.coverage_type = 'shouldering')
    ) as both_directions_shouldered
  from road_segment_groups sg
  left join road_segments rs on rs.segment_group_id = sg.id
  left join segment_coverage sc on sc.road_segment_id = rs.id
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
