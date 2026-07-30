-- =============================================================================
-- NovaCore v1 — Migration 0005: sandbox flag + acceptance-test cleanup
--
-- Batched deliberately: the flag was deferred until the field entry path landed
-- so it wouldn't force a mid-task push and a re-run of the guard probes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. projects.is_sandbox
--
-- A training project — where a new superintendent can enter fake tonnage,
-- confirm it, correct it, and get it wrong without touching a live contract.
-- The archived build had exactly this ("UI Test Sandbox", segments 0–1000), so
-- the need is established rather than speculative.
--
-- Added now, unused for the moment, because the cost is asymmetric: one boolean
-- today, versus backfilling and re-auditing every aggregate query later to
-- confirm none of them forgot the filter. A missed filter puts fabricated margin
-- into a real company-wide total, which surfaces in front of an executive rather
-- than in a test.
--
-- STANDING RULE: any query that aggregates across projects — company rollups,
-- global margin, portfolio totals — must filter `is_sandbox = false`. Per-project
-- views do not need it; a sandbox project's own dashboard should work normally.
-- -----------------------------------------------------------------------------
alter table public.projects
  add column is_sandbox boolean not null default false;

comment on column public.projects.is_sandbox is
  'Training/demo project. Excluded from any cross-project aggregate. Behaves '
  'normally when viewed on its own.';

create index projects_live_idx on public.projects (id) where is_sandbox = false;

-- No RLS change needed: visibility is still governed by project_members, so a
-- sandbox is seen by exactly the people seated on it.

-- -----------------------------------------------------------------------------
-- 2. Remove the acceptance-test entries
--
-- Two draft rows created while verifying the offline sync path. They are
-- harmless — draft status means they never counted toward placed quantity — but
-- they will appear in day lists and in any export, and explaining them is worse
-- than removing them.
--
-- Note what this is: there is deliberately NO delete grant on daily_entries for
-- any authenticated role, so a migration running as the table owner is the only
-- sanctioned way to remove an entry. That property is the point. If this pattern
-- ever gets reached for to remove real production data, something has gone wrong
-- upstream — corrections are superseding rows, not deletions.
--
-- Scoped tightly to the two known markers and to draft status, so it cannot
-- touch anything confirmed even if the text matched by accident.
-- -----------------------------------------------------------------------------
delete from public.daily_entries
where status = 'draft'
  and (
    note     ilike '%OFFLINE TEST%'
    or note     ilike '%DOUBLE SYNC TEST%'
    or location ilike '%OFFLINE TEST%'
    or location ilike '%DOUBLE SYNC TEST%'
  );

-- Verify: should return zero rows.
--
--   select id, entry_date, location, note, status
--   from daily_entries
--   where note ilike '%TEST%' or location ilike '%TEST%';
--
-- If any confirmed row matched the markers, it was NOT deleted by the clause
-- above and needs a deliberate decision — supersede it rather than removing it.
