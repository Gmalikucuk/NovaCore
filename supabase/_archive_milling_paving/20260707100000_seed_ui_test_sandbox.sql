-- Throwaway sandbox segment for UI/offline-queue development and testing —
-- deliberately separate from the real Venables Segment 1/2 data so test
-- entries never pollute real project records. Simple round-number stations
-- (0-1000) for easy manual testing.

insert into projects (contract_number, name, company_id)
values ('UI-TEST-SANDBOX', 'UI Test Sandbox', (select id from companies where name = 'Keywest Asphalt'));

insert into jobs (project_id, job_code, job_name)
values (
  (select id from projects where contract_number = 'UI-TEST-SANDBOX'),
  'SANDBOX',
  'UI Test Sandbox'
);

insert into road_segment_groups (job_id, highway, from_station, to_station, lane_config)
values (
  (select id from jobs where project_id = (select id from projects where contract_number = 'UI-TEST-SANDBOX')),
  'Sandbox Hwy', 0, 1000, '2-lane both directions'
);

insert into road_segments (segment_group_id, job_id, highway, direction, from_station, to_station)
values
(
  (select id from road_segment_groups where job_id = (select id from jobs where project_id = (select id from projects where contract_number = 'UI-TEST-SANDBOX'))),
  (select id from jobs where project_id = (select id from projects where contract_number = 'UI-TEST-SANDBOX')),
  'Sandbox Hwy', 'NB', 0, 1000
),
(
  (select id from road_segment_groups where job_id = (select id from jobs where project_id = (select id from projects where contract_number = 'UI-TEST-SANDBOX'))),
  (select id from jobs where project_id = (select id from projects where contract_number = 'UI-TEST-SANDBOX')),
  'Sandbox Hwy', 'SB', 0, 1000
);
