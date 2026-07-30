-- =============================================================================
-- NovaCore v1 — Migration 0006: dedicated sandbox project for scripts/probe-rls.sh
--
-- The probe suite has been writing confirmed daily_entries into the live Hwy 5
-- Snowshed Hill project on every run — real placed-quantity and margin figures,
-- fabricated, accumulating with every regression check, invisible until the
-- dashboard (§8 step 5) exists to surface them. This gives it a project of its
-- own (is_sandbox = true, see 0005) and removes what it has already written to
-- Hwy 5.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The sandbox project itself
--
-- Fixed, mnemonic id (c0ffee00-c0de-...) rather than gen_random_uuid() — a
-- migration that seeds fixed test users and a fixed test project (see
-- v1_minimal_seed.sql's be9ed906-... for Hwy 5) benefits from ids a human can
-- recognize in a query result without a join, and scripts/probe-rls.sh's own
-- discovery query below needs a stable target to reason about, not a fresh
-- random id every time this file might be reviewed.
-- -----------------------------------------------------------------------------
insert into public.projects (id, name, contract_no, created_by, is_sandbox)
values (
  'c0ffee00-c0de-0000-0000-000000000000',
  'PROBE — do not use',
  null,
  null,
  true
)
on conflict (id) do nothing;

-- cfo/owner carry a global_role and are auto-enrolled by the on_project_created
-- trigger (enrol_global_roles(), see 0001) the moment the insert above commits.
-- field and project_manager have no global_role, so — same as Hwy 5's own seed
-- (v1_minimal_seed.sql) — they're seated explicitly.
insert into public.project_members (project_id, user_id, role) values
  ('c0ffee00-c0de-0000-0000-000000000000', 'ee31c560-2015-4d7a-8a1d-ea3f93a73f96', 'field'),
  ('c0ffee00-c0de-0000-0000-000000000000', '86cf63d5-d606-4ad7-924d-c4f6dda1da0b', 'project_manager')
on conflict (project_id, user_id) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Line items + prices
--
-- Three, matching the shape of Hwy 5's own minimal seed (enough to exercise
-- the finance wall from both sides) — round, obviously-fake numbers so no one
-- skimming a query result mistakes these for a real bid price.
-- -----------------------------------------------------------------------------
insert into public.line_items (id, project_id, item_no, description, unit, bid_quantity) values
  ('c0ffee00-c0de-0000-0000-000000000001', 'c0ffee00-c0de-0000-0000-000000000000', 'PROBE-001', 'Test excavation', 'm³', 1000),
  ('c0ffee00-c0de-0000-0000-000000000002', 'c0ffee00-c0de-0000-0000-000000000000', 'PROBE-002', 'Test paving', 'tonne', 1000),
  ('c0ffee00-c0de-0000-0000-000000000003', 'c0ffee00-c0de-0000-0000-000000000000', 'PROBE-003', 'Test tack coat', 'L', 1000)
on conflict (id) do nothing;

insert into public.line_item_prices (line_item_id, project_id, cost_price, sell_price) values
  ('c0ffee00-c0de-0000-0000-000000000001', 'c0ffee00-c0de-0000-0000-000000000000', 1.00, 2.00),
  ('c0ffee00-c0de-0000-0000-000000000002', 'c0ffee00-c0de-0000-0000-000000000000', 10.00, 20.00),
  ('c0ffee00-c0de-0000-0000-000000000003', 'c0ffee00-c0de-0000-0000-000000000000', 0.50, 1.00)
on conflict (line_item_id) do nothing;

-- -----------------------------------------------------------------------------
-- 3. Remove what the acceptance-testing process has already written to Hwy 5
--
-- Four device_id markers, exact match (no wildcard — 0005 used ilike for
-- free-text note/location fields where a substring match was the only option;
-- device_id is a dedicated field no real field crew ever types into, so an
-- exact enumerated list is both tighter and fully auditable from this file
-- alone):
--   'test-device-1'        — the original Step 6 raw-curl acceptance test,
--                             predates probe-rls.sh
--   'reverify-0004'        — manual re-verification when 0004 landed
--   'probe-rls'            — every scripts/probe-rls.sh seat-level run
--   'probe-rls-privileged' — probe-rls.sh's privileged-path (postgres-role) checks
--
-- confirmed-only and project-scoped, same append-only reasoning as 0005: there
-- is deliberately no delete grant on daily_entries for any authenticated role,
-- so this is the sanctioned removal path, and it's why the four markers above
-- are worth enumerating precisely rather than reached for loosely — corrections
-- are superseding rows, not deletions, for anything that isn't synthetic
-- acceptance-test data.
-- -----------------------------------------------------------------------------
delete from public.daily_entries
where project_id = 'be9ed906-6a33-4a4c-aa3e-81f5707b5684'
  and status = 'confirmed'
  and device_id in ('test-device-1', 'reverify-0004', 'probe-rls', 'probe-rls-privileged');

-- Verify: should return zero rows.
--
--   select id, entry_date, device_id, status
--   from daily_entries
--   where project_id = 'be9ed906-6a33-4a4c-aa3e-81f5707b5684'
--     and device_id in ('test-device-1', 'reverify-0004', 'probe-rls', 'probe-rls-privileged');
--
-- Verify the sandbox project itself:
--
--   select id, name, is_sandbox from projects where id = 'c0ffee00-c0de-0000-0000-000000000000';
