-- Multi-highway support: a segment can genuinely span two NAMED highways
-- (a highway-name change partway through, e.g. Hwy 1 becoming Hwy 97 at a
-- specific point) — a different situation from a same-road chainage
-- rollover. highway_2_* fields are nullable and only populated when this
-- actually applies.

alter table road_segment_groups add column highway_2 text;
alter table road_segment_groups add column highway_2_from_station numeric(12,3);
alter table road_segment_groups add column highway_2_to_station numeric(12,3);

-- road_segments needs the same two-highway structure as its parent group,
-- since a single direction's own span can also cross the highway boundary
-- (highway_2's NAME isn't repeated here — it's already on the parent group).
alter table road_segments add column highway_2_from_station numeric(12,3);
alter table road_segments add column highway_2_to_station numeric(12,3);

-- segment_length now sums both highways' spans when highway_2_* is set,
-- rather than a single subtraction across two different stationing
-- systems (which would produce a nonsense number, not just an imprecise
-- one — the two ranges have no numeric relationship to each other).
alter table road_segments drop column segment_length;
alter table road_segments add column segment_length numeric(12,3)
  generated always as (
    case
      when highway_2_from_station is not null and highway_2_to_station is not null
        then abs(to_station - from_station) + abs(highway_2_to_station - highway_2_from_station)
      else abs(to_station - from_station)
    end
  ) stored;

-- Segment 2's road_segment_group. lane_config matches Segment 1's seed
-- exactly ('2-lane both directions'), confirmed against the live row
-- before writing this.
insert into road_segment_groups (
  job_id, highway, from_station, to_station,
  highway_2, highway_2_from_station, highway_2_to_station, lane_config
)
values (
  (select id from jobs where project_id = (select id from projects where contract_number = '26754-0000')),
  'Hwy 1', 43170, 45060,
  'Hwy 97', 0, 11225,
  '2-lane both directions'
);

-- Segment 2's road_segments. NB is field-confirmed: Hwy 1 43+170 to
-- 45+060 (1890m), continuing Hwy 97 0+000 to 11+225 (11225m). SB mirrors
-- the same physical corridor in reverse, per your confirmation.
insert into road_segments (
  segment_group_id, job_id, highway, direction,
  from_station, to_station, highway_2_from_station, highway_2_to_station
)
values
(
  (select id from road_segment_groups where from_station = 43170 and to_station = 45060 and highway_2 = 'Hwy 97'),
  (select id from jobs where project_id = (select id from projects where contract_number = '26754-0000')),
  'Hwy 1', 'NB', 43170, 45060, 0, 11225
),
(
  (select id from road_segment_groups where from_station = 43170 and to_station = 45060 and highway_2 = 'Hwy 97'),
  (select id from jobs where project_id = (select id from projects where contract_number = '26754-0000')),
  'Hwy 1', 'SB', 45060, 43170, 11225, 0
);
