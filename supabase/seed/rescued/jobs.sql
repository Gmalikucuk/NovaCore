-- Rescued from the old schema's `jobs` table before `drop schema public cascade`
-- (2026-07-30). Reference only. No `jobs` concept exists in the new v1 schema.
insert into jobs (id, project_id, job_code, job_name, direction_scope, created_at) values
('853cb4a1-a3f7-4101-95bb-090f14a74b54', '3aa698cd-755b-485d-bcd7-341baf345b8b', '1', 'Venables Valley', null, '2026-07-05 21:52:45.82925+00'),
('aec3d98e-6319-4c75-b002-ec5a3891fbb1', 'b8b592dc-0489-48af-b49b-9b776fe3ec09', 'SANDBOX', 'UI Test Sandbox', null, '2026-07-06 00:08:09.249146+00');
