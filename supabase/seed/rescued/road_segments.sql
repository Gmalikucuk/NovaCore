-- Rescued from the old schema's `road_segments` table before `drop schema public
-- cascade` (2026-07-30). Reference only — each row is one direction of travel
-- within a road_segment_group above.
insert into road_segments (id, job_id, segment_group_id, highway, direction, from_station, to_station, highway_2_from_station, highway_2_to_station, lane_config, segment_length) values
('36230021-e707-4117-b969-3fcdbd21bda1', '853cb4a1-a3f7-4101-95bb-090f14a74b54', '5ab756bd-800a-4850-ab55-1efe3b6990a3', 'Hwy 1', 'NB', 25340.000, 35235.000, null, null, null, 9895.000),
('75a5e726-41da-4e27-bf47-a2001d852da7', '853cb4a1-a3f7-4101-95bb-090f14a74b54', '5ab756bd-800a-4850-ab55-1efe3b6990a3', 'Hwy 1', 'SB', 25340.000, 35235.000, null, null, null, 9895.000),
('18b8c126-7241-4f39-a657-33c851ea9a33', '853cb4a1-a3f7-4101-95bb-090f14a74b54', 'dabbf606-32f7-48b0-8030-0960e60a0a34', 'Hwy 1', 'NB', 43170.000, 45060.000, 0.000, 11225.000, null, 13115.000),
('6069b3b1-8ed9-4dc4-b1ba-4e650fbaf515', '853cb4a1-a3f7-4101-95bb-090f14a74b54', 'dabbf606-32f7-48b0-8030-0960e60a0a34', 'Hwy 1', 'SB', 45060.000, 43170.000, 11225.000, 0.000, null, 13115.000),
('3e499016-b73c-48ef-a429-6e6b00308668', 'aec3d98e-6319-4c75-b002-ec5a3891fbb1', 'bc1f6078-48bf-4e98-8c35-a0378323088f', 'Sandbox Hwy', 'NB', 0.000, 1000.000, null, null, null, 1000.000),
('a5dc15c7-73dd-4c04-b18b-50ebea572209', 'aec3d98e-6319-4c75-b002-ec5a3891fbb1', 'bc1f6078-48bf-4e98-8c35-a0378323088f', 'Sandbox Hwy', 'SB', 0.000, 1000.000, null, null, null, 1000.000);
