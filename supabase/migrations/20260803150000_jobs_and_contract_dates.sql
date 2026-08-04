-- =============================================================================
-- NovaCore v1 — Migration 0016: jobs and contract dates
--
-- WHY THIS EXISTS
--
-- Two different sets of dates are in play. The Contract sets its own period —
-- the Ministry's dates, given and fixed. Within those, Keywest chooses its own
-- planned start and end and holds teams accountable to them; that is the KPI.
-- Nothing in NovaCore records either today, which is why no honest rate-of-
-- progress figure can be computed: there is no denominator. This migration
-- adds the DATA, not the figure — no rate-of-progress, no percent-of-elapsed-
-- time, no forecast finish date, no completion metric of any kind is computed
-- anywhere in this file.
--
-- THE SHAPE
--
--   contracts.contract_start / contract_end   the Ministry's given period
--   contracts.planned_start  / planned_end    Keywest's own planned commitment,
--                                              contract-level
--   jobs                                       optional, per contract — e.g. Hwy
--                                              5 Snowshed Hill's Job A/B/C. Each
--                                              may carry its own planned_start/
--                                              planned_end, which becomes the
--                                              level the KPI is measured at
--                                              where jobs exist. A contract with
--                                              no jobs rows behaves exactly as
--                                              before.
--   items.job_id                               nullable. Null = "belongs to the
--                                              contract directly" — the only
--                                              state possible before this
--                                              migration, and still correct for
--                                              every contract with no jobs, and
--                                              for any Item on a jobbed contract
--                                              not yet assigned to one.
--
-- Jobs do not exist anywhere in the schema today — they live in the tender
-- documents. This migration is two pieces, jobs as a concept and dates on
-- them, and the first is the larger one.
--
-- MIGRATION PATH FOR ITEMS ON A CONTRACT THAT LATER GAINS JOBS
--
-- Adding jobs to a contract is purely additive: inserting into `jobs` never
-- touches an existing Item row. Every Item that existed before stays exactly
-- as it was — contract_id unchanged, job_id null. That null is not an error
-- state to migrate away from automatically; it means "not yet assigned to a
-- Job," and it is deliberately left that way here for Hwy 5's own 48 Items
-- below, because the true Item-to-Job mapping is not derivable from anything
-- already in this schema (it lives in the tender documents, which this
-- migration does not have). Reassigning a specific Item to a specific Job is
-- an ordinary `items` UPDATE — already gated by the existing create_items
-- right, since job_id is just another field on an Item's definition — not a
-- new permission, and not a migration step. A blanket "every Item must have a
-- job_id once the contract has any jobs" invariant was considered and
-- rejected for exactly this reason: it would make Hwy 5's own honest,
-- not-yet-assigned state illegal the moment its three real Jobs are seeded
-- below.
--
-- THE CONTAINMENT RULE — WARNING TODAY, NOT A HARD BLOCK
--
-- Keywest's planned dates should sit inside the Contract's period, and a
-- Job's planned dates inside Keywest's contract-level pair. This migration
-- does NOT enforce either nesting at the database level — deliberately, per
-- brief: "a warning the PM can proceed past, not a hard block."
--
-- Where the warning belongs TODAY: PostgREST does not surface a plain
-- `RAISE WARNING` back to an API caller (it goes to the Postgres log, not the
-- response body), so a database-side warning would be invisible to the one
-- person who needs to see it. The brief itself says the bounds "should be
-- visible at the point of entry" — that is a client-side concern, in the
-- (not-yet-built) admin UI's date-entry form, which already has the parent's
-- planned_start/planned_end on hand (both are plain SELECT-able columns, no
-- new grant needed) to compare against as the PM types. No schema object is
-- needed to make that possible; it already is.
--
-- Where the HARD block would go, if this is ever promoted: a BEFORE INSERT OR
-- UPDATE trigger on `jobs` (job vs its contract's planned_start/planned_end)
-- and on `contracts` (planned_start/planned_end vs contract_start/
-- contract_end), each raising an EXCEPTION — the exact mechanism this schema
-- already uses for cross-row integrity (see check_supersede_target() and
-- guard_entry_transitions() in 0001/0009). That is a database-level check,
-- and it is the honest place for the RULE once it needs teeth: containment is
-- inherently a parent-row comparison, which a plain CHECK constraint cannot
-- express (it only ever sees one row), but a trigger can. Turning the warning
-- into a hard block later is exactly: add those two trigger functions and
-- attach them — no policy, view, or application code changes required. Not
-- built now, because building it would make this a hard block today, which
-- the brief explicitly says not to do.
--
-- THE RIGHT THAT GATES WRITING DATES
--
-- New: contract_members.manage_schedule. Gates (a) writing Keywest's
-- contract-level planned_start/planned_end, and (b) creating or updating
-- Jobs, including their planned dates.
--
-- Considered and rejected:
--   create_items    "add/edit Schedule 7 Item definitions" — a Job is not an
--                   Item, and overloading this would let anyone who can
--                   amend a line item also redraw the Contractor's own
--                   schedule commitment, two genuinely different decisions.
--   confirm_quantity  0010's progress_estimates reused this for a new table
--                   on the reasoning that whoever confirms quantity owns
--                   reconciliation. Dates are not a quantity-confirmation
--                   concern at all — a PM might schedule work without ever
--                   touching confirm_quantity, and vice versa.
--   manage_members  company-wide, owner-level, and already (see below) the
--                   gate on the Ministry's OWN contract_start/contract_end,
--                   which are "given," not the Contractor's own planning
--                   decision. Reusing it for Keywest's planned dates and
--                   Jobs would put a PM-level, per-contract, revised-as-work-
--                   proceeds action behind a company-wide administrative
--                   right, and would remove the only lever a PM could ever
--                   hold to manage their own schedule without also being
--                   able to reseat members or edit the Ministry's dates.
--
-- The Ministry's contract_start/contract_end stay gated by the EXISTING
-- contracts_update_right policy (manage_members) — they are "given, entered
-- when contract data is entered," the same moment and the same company-wide
-- administrative act as creating the contract row and seating its members.
-- No new right for those two columns.
--
-- Both pairs live on the SAME `contracts` row, and Postgres RLS policies
-- apply per-ROW, not per-column — two permissive UPDATE policies with
-- different rights would let EITHER one touch ALL granted columns, not just
-- its own. The column-level GRANT below narrows what is touchable via the API
-- at all (to exactly the four date columns — contract_name/contract_no/
-- is_sandbox/archived remain ungrantable for UPDATE, unchanged); the new
-- trigger below is what then splits WHICH of those four columns each right
-- may actually move, mirroring guard_entry_transitions()'s own "some columns
-- move for one actor, not for another" shape on quantity_records.
--
-- DISCOVERED IN WRITING THIS: `contracts_update_right` (0009, gated on
-- manage_members) has never been reachable — 0002's base grant on `contracts`
-- (then `projects`) is `select, insert` only, no UPDATE at all, and no later
-- migration added one. That policy is not touched here (it is exactly correct
-- for whenever a future migration grants broader UPDATE access, e.g. the
-- queued contract-admin UI) but is worth recording: nothing has ever been
-- able to edit a contract's own name/number/sandbox flag via the API, only
-- via a migration or the seed scripts, and that remains true after this file.
--
-- TENANCY RULE, UNCHANGED: every check below goes through is_member()/
-- has_right()/has_global_right() only. No policy or query here inlines a
-- subquery against contract_members. Every new view (none in this migration)
-- would be security_invoker = on; noted because there are none to forget it
-- on.
--
-- Requires migrations through 0015.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. jobs — optional, per contract
--
-- Deliberately as thin as `items`: no created_by/created_at, matching that
-- table's own shape rather than inventing audit columns the closest existing
-- analog doesn't have. `unique (id, contract_id)` exists for exactly one
-- reason — it is the composite-FK target from items.job_id below, the same
-- pattern items itself already provides for item_prices/pinned_items.
-- -----------------------------------------------------------------------------
create table public.jobs (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null references public.contracts(id) on delete cascade,
  name          text not null,
  planned_start date,
  planned_end   date,

  unique (contract_id, name),
  unique (id, contract_id),

  constraint jobs_planned_pair_coherent
    check ((planned_start is null) = (planned_end is null)),
  constraint jobs_planned_start_before_end
    check (planned_start is null or planned_start <= planned_end)
);

comment on table public.jobs is
  'An optional grouping of Items within a contract, below the contract and '
  'above the Item — e.g. Hwy 5 Snowshed Hill''s Job A/B/C. Not in the tender '
  'schema as its own table; exists here only where the Contractor chooses to '
  'track work at this level. A contract with no rows in this table behaves '
  'exactly as it did before this migration: every Item belongs to the '
  'contract directly.';

comment on column public.jobs.planned_start is
  'Keywest''s own planned start for this Job — the level the (not-yet-built) '
  'schedule KPI is measured at once a contract has jobs. Optional even then '
  '("may carry its own planned start and end"). Should sit within the '
  'contract''s own planned_start/planned_end; not enforced at the database '
  'level today — see this migration''s header for where a hard constraint '
  'would go if that changes.';

-- -----------------------------------------------------------------------------
-- 2. items.job_id
-- -----------------------------------------------------------------------------
alter table public.items
  add column job_id uuid;

alter table public.items
  add constraint items_job_same_contract
  foreign key (job_id, contract_id) references public.jobs (id, contract_id);

comment on column public.items.job_id is
  'Which Job this Item belongs to, where the contract has any. Null means '
  '"belongs to the contract directly" — see this migration''s header for the '
  'full reasoning on why that is the correct, deliberate state for every '
  'existing Item after this migration, not a gap to backfill.';

-- -----------------------------------------------------------------------------
-- 3. contracts — both date pairs
-- -----------------------------------------------------------------------------
alter table public.contracts
  add column contract_start date,
  add column contract_end   date,
  add column planned_start  date,
  add column planned_end    date;

alter table public.contracts
  add constraint contracts_given_pair_coherent
    check ((contract_start is null) = (contract_end is null)),
  add constraint contracts_given_start_before_end
    check (contract_start is null or contract_start <= contract_end),
  add constraint contracts_planned_pair_coherent
    check ((planned_start is null) = (planned_end is null)),
  add constraint contracts_planned_start_before_end
    check (planned_start is null or planned_start <= planned_end);

comment on column public.contracts.contract_start is
  'The Ministry''s given period — fixed, not the Contractor''s to set. '
  'Nullable: not every contract''s dates are known to NovaCore yet (see Hwy '
  '5''s own seed, which leaves this null rather than inventing a figure — '
  'same standing rule as never inventing a Unit Price). Writable only by '
  'manage_members, same right and same moment as creating the contract row '
  'itself; see guard_contract_date_columns() below.';
comment on column public.contracts.contract_end is
  'Paired with contract_start — see that column''s comment.';
comment on column public.contracts.planned_start is
  'Keywest''s own planned start — the Contractor''s commitment, not the '
  'Ministry''s. Should sit within contract_start/contract_end (advised, not '
  'enforced — see this migration''s header). Writable by manage_schedule, a '
  'per-contract right, independent of manage_members.';
comment on column public.contracts.planned_end is
  'Paired with planned_start — see that column''s comment.';

-- -----------------------------------------------------------------------------
-- 4. contract_members.manage_schedule — the new right
-- -----------------------------------------------------------------------------
alter table public.contract_members
  add column manage_schedule boolean not null default false;

comment on column public.contract_members.manage_schedule is
  'May set Keywest''s own planned_start/planned_end on the contract, and '
  'create or edit Jobs on it (including their planned dates). Deliberately '
  'separate from create_items (Schedule 7 Item definitions — a Job is not an '
  'Item), from confirm_quantity (0010 reused it for progress_estimates; '
  'dates are not a quantity-confirmation concern), and from the company-wide '
  'manage_members, which alone can set the Ministry''s given '
  'contract_start/contract_end. See this migration''s header for the full '
  'reasoning.';

grant update (create_items, set_cost, set_unit_price, enter_quantity,
              correct_quantity, confirm_quantity, view_rates, extract_report,
              manage_schedule)
  on public.contract_members to authenticated;

-- -----------------------------------------------------------------------------
-- 5. contracts — column-scoped UPDATE grant + split-right policy + guard
--
-- The grant is additive and narrow: only the four date columns become
-- updatable via the API. contract_name/contract_no/is_sandbox/archived/
-- created_by remain exactly as unreachable for UPDATE as they were before
-- this migration (see this migration's header — that gap already existed,
-- untouched here).
-- -----------------------------------------------------------------------------
grant update (contract_start, contract_end, planned_start, planned_end)
  on public.contracts to authenticated;

create policy contracts_dates_update_right on public.contracts
  for update to authenticated
  using (
    public.is_member(id)
    and (public.has_global_right('manage_members') or public.has_right(id, 'manage_schedule'))
  )
  with check (
    public.is_member(id)
    and (public.has_global_right('manage_members') or public.has_right(id, 'manage_schedule'))
  );

-- The policy above decides WHETHER an update on the granted columns may
-- happen at all; it cannot decide WHICH of the four a given actor may move
-- (RLS is row-scoped, not column-scoped). This trigger is that split: a
-- manage_schedule holder without manage_members may move planned_start/
-- planned_end freely, but touching contract_start/contract_end raises —
-- same "some columns move for one actor, not another" shape as
-- guard_entry_transitions() already uses on quantity_records.
create or replace function public.guard_contract_date_columns()
returns trigger
language plpgsql
as $$
begin
  if not public.has_global_right('manage_members') then
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

create trigger contracts_guard_date_columns
  before update on public.contracts
  for each row execute function public.guard_contract_date_columns();

-- -----------------------------------------------------------------------------
-- 6. jobs — RLS
--
-- Select: mere membership, same as items — a Job carries no money, and a
-- field seat reasonably needs to know what Job they're working on.
-- Insert/update: manage_schedule, which already implies membership (it is a
-- column on the membership row itself — has_right() returns false with no
-- membership row to read).
-- -----------------------------------------------------------------------------
alter table public.jobs enable row level security;

grant select, insert, update on public.jobs to authenticated;

create policy jobs_select_member on public.jobs
  for select to authenticated
  using (public.is_member(contract_id));

create policy jobs_insert_right on public.jobs
  for insert to authenticated
  with check (public.has_right(contract_id, 'manage_schedule'));

create policy jobs_update_right on public.jobs
  for update to authenticated
  using (public.has_right(contract_id, 'manage_schedule'))
  with check (public.has_right(contract_id, 'manage_schedule'));

-- No delete policy or grant: matches items (also no delete path via the
-- API) — out of scope for a data-model-only migration with no admin UI yet.

-- =============================================================================
-- PROBES to add (scripts/probe-rls.sh) — see the script itself for the ones
-- actually added; kept here as the source-of-truth list this migration was
-- written against.
--
--   - full: insert a Job on a contract it holds manage_schedule on -> 201
--   - full: update contracts.planned_start/planned_end -> 200, changed
--   - full: update contracts.contract_start/contract_end (manage_schedule
--     only, NOT manage_members) -> rejected by the trigger (500-class from
--     the raised exception, not a bare RLS 403 — worth asserting the
--     distinction so a future refactor to a hard RLS-only block doesn't go
--     unnoticed)
--   - full: a Job's planned dates OUTSIDE its contract's planned range still
--     succeeds -> 201 (proves "warning, not a hard block" is real today, not
--     just asserted in a comment)
--   - quantities (no manage_schedule): insert a Job -> rejected
--   - quantities: update contracts.planned_start -> rejected
--   - readonly (seated, zero rights): select jobs -> rows (membership, not a
--     right — matches items/quantity_records' own positive control)
-- =============================================================================
