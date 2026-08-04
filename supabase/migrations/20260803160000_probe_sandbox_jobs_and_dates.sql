-- =============================================================================
-- NovaCore v1 — Migration 0017: PROBE fixture data for jobs and contract dates
--
-- 0016 added jobs and contract-level dates but seeded them only on Hwy 5 (real,
-- dates deliberately left null — see that migration) and Hwy 97C (sandbox,
-- fully seeded via seed_demo_contract.sql). Neither is guaranteed to be a
-- contract every probe fixture is seated on; scripts/probe-rls.sh's own
-- dynamic discovery has always targeted the dedicated PROBE sandbox project
-- (0006) specifically, because that is the one place the fixture accounts
-- (quantities/full/viewer/readonly/correct_only) are known to be seated with
-- controlled, narrow rights. This migration gives PROBE the same shape so
-- 0016's new surface (jobs, contract dates, manage_schedule) is reachable by
-- the probe suite the same way the rest of it already is.
--
-- Same disclosed-fictional umbrella as PROBE's own name ("PROBE — do not
-- use") and existing invented prices — nothing here claims to be real.
--
-- BUG FOUND WRITING THIS FILE: guard_contract_date_columns() (0016) checks
-- has_global_right('manage_members'), which resolves through auth.uid() —
-- null in a migration's connection (no PostgREST/JWT context), not just
-- "false". The trigger read that null as "not manage_members" and rejected
-- this file's own UPDATE of contract_start/contract_end below, even though
-- a migration runs with far more privilege than any application-level
-- right. Fixed here (CREATE OR REPLACE, same function, no signature change)
-- by only applying the restriction when auth.uid() IS NOT NULL — i.e. only
-- to an actual authenticated API caller, which is the only actor the rule
-- was ever meant to constrain. Confirmed the failure mode first: pushed
-- this file unchanged, got exactly this exception, rolled back
-- transactionally with zero schema change, then added this fix before
-- retrying — not assumed.
create or replace function public.guard_contract_date_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and not public.has_global_right('manage_members') then
    if new.contract_start is distinct from old.contract_start
       or new.contract_end is distinct from old.contract_end then
      raise exception
        'the Ministry''s contract_start/contract_end require manage_members; '
        'manage_schedule covers only planned_start/planned_end and Jobs';
    end if;
  end if;
  return new;
end;
$$;

-- full (86cf63d5-d606-4ad7-924d-c4f6dda1da0b) already holds every other
-- per-project right on PROBE (backfilled from its old project_manager role
-- in 0008) but NOT manage_schedule, which didn't exist then — a new boolean
-- column defaults to false for every existing row, deliberately (0008's own
-- "a forgotten column fails closed rather than open"). Granted explicitly
-- here so probe-rls.sh's write-path checks for 0016 have a seat to run them
-- from full is meant to hold every per-project right, and today it does not
-- without this.
-- =============================================================================

update public.contract_members
set manage_schedule = true
where contract_id = 'c0ffee00-c0de-0000-0000-000000000000'
  and user_id = '86cf63d5-d606-4ad7-924d-c4f6dda1da0b';

update public.contracts
set contract_start = '2026-04-01',
    contract_end   = '2026-12-15',
    planned_start  = '2026-04-15',
    planned_end    = '2026-11-30'
where id = 'c0ffee00-c0de-0000-0000-000000000000';

-- One Job, inside the contract's planned range — enough for probe-rls.sh to
-- exercise insert/select/update against a real row without needing to prove
-- the out-of-bounds case again (0016's own seed on Hwy 97C already proves
-- that in the browser-verifiable demo contract; PROBE's job here is a
-- stable, scriptable fixture, not a second demonstration).
insert into public.jobs (contract_id, name, planned_start, planned_end)
values (
  'c0ffee00-c0de-0000-0000-000000000000',
  'PROBE Job',
  '2026-05-01',
  '2026-09-30'
)
on conflict (contract_id, name) do update set
  planned_start = excluded.planned_start, planned_end = excluded.planned_end;

-- Verify:
--
--   select contract_start, contract_end, planned_start, planned_end
--   from contracts where id = 'c0ffee00-c0de-0000-0000-000000000000';
--
--   select name, planned_start, planned_end from jobs
--   where contract_id = 'c0ffee00-c0de-0000-0000-000000000000';
--
--   select manage_schedule from contract_members
--   where contract_id = 'c0ffee00-c0de-0000-0000-000000000000'
--     and user_id = '86cf63d5-d606-4ad7-924d-c4f6dda1da0b';
--   -- expect true
-- =============================================================================
