-- Rescued from the old schema's `road_segment_groups` table before
-- `drop schema public cascade` (2026-07-30). Reference only. THE STATION RANGES ARE
-- THE HIGH-VALUE FACTS HERE — see README.md for the plain-English table.
--
-- NOTE: no "Job B", "Reach 1"/"Reach 2", or Henning/Juliet/Brodie/Larson naming
-- exists anywhere in this data. Only Venables Valley and UI Test Sandbox were ever
-- seeded into this database.
insert into road_segment_groups (id, job_id, highway, highway_2, from_station, to_station, highway_2_from_station, highway_2_to_station, lane_config, created_at) values
('5ab756bd-800a-4850-ab55-1efe3b6990a3', '853cb4a1-a3f7-4101-95bb-090f14a74b54', 'Hwy 1', null, 25340.000, 35235.000, null, null, '2-lane both directions', '2026-07-05 21:52:45.82925+00'),
('dabbf606-32f7-48b0-8030-0960e60a0a34', '853cb4a1-a3f7-4101-95bb-090f14a74b54', 'Hwy 1', 'Hwy 97', 43170.000, 45060.000, 0.000, 11225.000, '2-lane both directions', '2026-07-05 23:31:49.037019+00'),
('bc1f6078-48bf-4e98-8c35-a0378323088f', 'aec3d98e-6319-4c75-b002-ec5a3891fbb1', 'Sandbox Hwy', null, 0.000, 1000.000, null, null, '2-lane both directions', '2026-07-06 00:08:09.249146+00');
