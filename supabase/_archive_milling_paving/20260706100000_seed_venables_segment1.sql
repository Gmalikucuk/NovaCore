-- BUG FIX, discovered while seeding real data: road_segments.segment_length
-- reused segmentArea.ts's 5000m ROLLOVER_THRESHOLD, but that threshold
-- means something completely different at this level. In segmentArea.ts it
-- flags an anomalous jump between two ADJACENT field width readings (which
-- should always be small — tens of metres), signalling a chainage reset.
-- Here, from_station/to_station describe a road_segment's ENTIRE nominal
-- span for a contract segment, which is routinely many kilometres (Segment
-- 1 below is 9895m). Applying the same 5000 threshold here would silently
-- zero out segment_length for any real segment longer than 5km — exactly
-- the kind of silently-wrong-data bug this schema has otherwise been
-- careful to avoid. Nothing currently reads this column's value yet (only a
-- comment in the lifecycle migration describes a future computation), so
-- this is the right time to fix it, before real data depends on it.
alter table road_segments drop column segment_length;
alter table road_segments add column segment_length numeric(12,3)
  generated always as (abs(to_station - from_station)) stored;

-- Part 1: seed real Venables Valley Segment 1 reference data.
-- Segment 2 intentionally deferred — awaiting confirmed practical station
-- ranges from Mehmet, not fabricated here.

insert into projects (contract_number, name, lane_km, company_id)
values (
  '26754-0000',
  'Hwy 1/97 Venables Valley to Jct Hwy 99',
  78.8,
  (select id from companies where name = 'Keywest Asphalt')
);

insert into project_config (
  project_id, target_application_rate_kg_m2, mix_density, lift_thickness_m,
  tack_coat_rate_l_m2, mill_to_pave_days_allowed, shouldering_days_allowed,
  joint_sealant_strategy, joint_sealant_band_width_m, joint_sealant_rate_l_m2,
  stationing_format, bonus_band_low_pct, bonus_band_high_pct,
  reject_band_low_pct, reject_band_high_pct
)
values (
  (select id from projects where contract_number = '26754-0000'),
  124.35, 2.487, 0.05, 0.26, 7, 10,
  'single_project_closeout', 0.4, 0.4,
  'lki_station', 96, 104, 85, 110
);

-- job_code/job_name weren't specified — Venables has no real Job A/B/C
-- structure (unlike Snowshed will), so there's no natural code to use here.
-- Using '1' / 'Venables Valley' as a nominal placeholder for the one
-- implicit job. Flagging this choice since it wasn't given explicitly.
insert into jobs (project_id, job_code, job_name)
values (
  (select id from projects where contract_number = '26754-0000'),
  '1',
  'Venables Valley'
);

insert into road_segment_groups (job_id, highway, from_station, to_station, lane_config)
values (
  (select id from jobs where project_id = (select id from projects where contract_number = '26754-0000')),
  'Hwy 1', 25340, 35235, '2-lane both directions'
);

insert into road_segments (segment_group_id, job_id, highway, direction, from_station, to_station)
values
(
  (select id from road_segment_groups where job_id = (select id from jobs where project_id = (select id from projects where contract_number = '26754-0000'))),
  (select id from jobs where project_id = (select id from projects where contract_number = '26754-0000')),
  'Hwy 1', 'NB', 25340, 35235
),
(
  (select id from road_segment_groups where job_id = (select id from jobs where project_id = (select id from projects where contract_number = '26754-0000'))),
  (select id from jobs where project_id = (select id from projects where contract_number = '26754-0000')),
  'Hwy 1', 'SB', 25340, 35235
);
