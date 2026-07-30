-- Rescued from the old schema's `projects` table before `drop schema public cascade`
-- (2026-07-30). Reference only — old table shape, not the new v1 `projects` table
-- (which has no company_id/lane_km and uses contract_no not contract_number).
insert into projects (id, contract_number, name, lane_km, start_date, target_completion_date, company_id, created_at) values
('3aa698cd-755b-485d-bcd7-341baf345b8b', '26754-0000', 'Hwy 1/97 Venables Valley to Jct Hwy 99', 78.800, null, null, 'd3e21d5d-25d2-44b4-880b-b73c5eac339c', '2026-07-05 21:52:45.82925+00'),
('b8b592dc-0489-48af-b49b-9b776fe3ec09', 'UI-TEST-SANDBOX', 'UI Test Sandbox', null, null, null, 'd3e21d5d-25d2-44b4-880b-b73c5eac339c', '2026-07-06 00:08:09.249146+00');
