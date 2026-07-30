-- Rescued from the old schema's `companies` table before `drop schema public cascade`
-- (2026-07-30). Written as literal inserts against the OLD table shape (see the
-- milling-paving-v1-archive tag / supabase/_archive_milling_paving/ for that schema) —
-- reference only, not meant to run against the new v1 schema, which has no
-- companies concept (single-company v1, per spec §6).
insert into companies (id, name, active, contact_email, created_at) values
('d3e21d5d-25d2-44b4-880b-b73c5eac339c', 'Keywest Asphalt', true, null, '2026-07-05 15:38:44.779057+00');
