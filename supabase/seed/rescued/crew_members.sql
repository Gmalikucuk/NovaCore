-- Rescued from the old schema's `crew_members` table before `drop schema public
-- cascade` (2026-07-30). One real (non-test) row. Its auth_user_id no longer
-- resolves to anything meaningful post-reset — `auth.users` itself was left
-- untouched by the reset, but this crew_members row and its old role/permission
-- model don't carry forward into the v1 `profiles`/`project_members` shape.
insert into crew_members (id, name, role, active, company_id, auth_user_id) values
('1cfdeea4-42c8-4537-8234-d9942269bb18', 'Mehmet', 'coordinator', true, 'd3e21d5d-25d2-44b4-880b-b73c5eac339c', '48739fbd-b5ff-420d-8e60-538d2ed3bfd2');
