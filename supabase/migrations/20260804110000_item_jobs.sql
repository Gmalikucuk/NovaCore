-- =============================================================================
-- NovaCore v1 — Migration 0019: item_jobs join table
--
-- WHY THIS EXISTS
--
-- items.job_id (0016) carries exactly one Job per Item. Real Schedule 7 data
-- broke that assumption the moment it was checked against the actual tender
-- document: 03.01.02 "Asphalt Medium Mix Aggregate Job B and C" is ONE
-- Schedule 7 line, ONE Unit Price, and BOTH Job B and Job C. There is no
-- single job_id value that expresses that correctly — it was left null
-- (unassigned) rather than picking one Job arbitrarily, which is honest but
-- loses real information the tender document actually states.
--
-- Splitting 03.01.02 into two Items (one per Job) was considered and
-- rejected: it invents a Schedule 7 structure the contract doesn't have (one
-- priced line becomes two), and whichever half is the NEW row starts with no
-- item_prices history — silently orphaning half of whatever rate is entered
-- against the original row. Once real rates exist that is exactly the kind
-- of loss this pre-flight work exists to prevent.
--
-- A join table has neither problem: it expresses "this Item belongs to these
-- Jobs" directly, as a many-to-many fact, without ever touching items.id —
-- so item_prices (keyed on item_id, never job_id) is completely unaffected
-- by anything this migration does. No cascade risk, and unlike the
-- description/unit fixes from the fidelity audit, no deadline relative to
-- rates being entered.
--
-- job_id ITSELF: RETAINED, NOT DROPPED, by this migration.
--
-- Every application code path today (both seed scripts) still reads and
-- writes items.job_id, and grep confirms no frontend code references job_id
-- or jobs at all — there is no UI built against either yet. Dropping job_id
-- in the same migration that introduces its replacement is exactly the
-- "rename sweep nobody can verify" 0009's own header already warned against
-- for a much smaller rename (two right-column names) — this is a bigger
-- change (a column moving to a table) touching the same number of call
-- sites with no probe coverage of the old path to compare against yet.
-- item_jobs is backfilled from job_id below and both seed scripts are
-- updated to write both, so the two stay in sync going forward; job_id
-- should be dropped in its OWN follow-up migration once every reader (there
-- are none today outside the seed scripts) is confirmed to be reading
-- item_jobs instead, with the probe suite green on both sides of that
-- change — the same sequencing 0011 used for its own two-column rename.
--
-- TENANCY RULE, UNCHANGED: is_member()/has_right() only, no inlined
-- subquery against contract_members.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. items needs (id, contract_id) as a composite unique target — jobs
-- already has this (0016, for items.job_id's own composite FK); items never
-- needed it before because nothing referenced items by anything but its
-- plain primary key until now.
-- -----------------------------------------------------------------------------
alter table public.items
  add constraint items_id_contract_unique unique (id, contract_id);

-- -----------------------------------------------------------------------------
-- 2. item_jobs — many-to-many, Item <-> Job
--
-- contract_id is denormalized here rather than derived through a join —
-- same reason every other per-contract table in this schema carries its own
-- contract_id (is_member()/has_right() take it directly; a policy may never
-- inline a subquery against contract_members to derive one). The two
-- composite foreign keys below are what actually GUARANTEE that
-- denormalized value is correct: (item_id, contract_id) can only reference
-- an items row whose own contract_id matches, and the same for job_id — so
-- an Item from one contract can never be joined to a Job from another, and
-- this row's own contract_id can never disagree with either side. No
-- trigger needed for that guarantee; the composite FKs are the constraint.
--
-- Primary key is (item_id, job_id) — the pair itself is the whole fact this
-- table records. No surrogate id, no other column, so there is nothing to
-- UPDATE in place; an assignment is created or removed, never edited (see
-- the RLS grants below — select/insert/delete only).
-- -----------------------------------------------------------------------------
create table public.item_jobs (
  item_id     uuid not null,
  job_id      uuid not null,
  contract_id uuid not null,

  primary key (item_id, job_id),
  foreign key (item_id, contract_id) references public.items (id, contract_id) on delete cascade,
  foreign key (job_id, contract_id)  references public.jobs  (id, contract_id) on delete cascade
);

comment on table public.item_jobs is
  'Item <-> Job assignment, many-to-many. Replaces items.job_id''s single-'
  'value limitation for the real case that broke it: 03.01.02 "Asphalt '
  'Medium Mix Aggregate Job B and C" is one Schedule 7 line assigned to both '
  'Job B and Job C. items.job_id is retained in parallel during the '
  'transition (see this migration''s header) — do not read job_id as the '
  'sole source of truth once this table has rows for an Item.';

comment on column public.item_jobs.contract_id is
  'Denormalized from either FK for is_member()/has_right() — see this '
  'table''s comment. Enforced equal to both items.contract_id and '
  'jobs.contract_id by the two composite foreign keys above, not by a '
  'trigger.';

-- -----------------------------------------------------------------------------
-- 3. Backfill — every existing items.job_id assignment, unchanged
-- -----------------------------------------------------------------------------
insert into public.item_jobs (item_id, job_id, contract_id)
select id, job_id, contract_id
from public.items
where job_id is not null
on conflict (item_id, job_id) do nothing;

-- -----------------------------------------------------------------------------
-- 4. RLS — same shape as jobs (0016): select on mere membership (a Job
-- assignment carries no money, same reasoning as a Job itself); write
-- gated on manage_schedule, which already implies membership. No update
-- grant: see this table's own comment on why there is nothing to update.
-- -----------------------------------------------------------------------------
alter table public.item_jobs enable row level security;

grant select, insert, delete on public.item_jobs to authenticated;

create policy item_jobs_select_member on public.item_jobs
  for select to authenticated
  using (public.is_member(contract_id));

create policy item_jobs_insert_right on public.item_jobs
  for insert to authenticated
  with check (public.has_right(contract_id, 'manage_schedule'));

create policy item_jobs_delete_right on public.item_jobs
  for delete to authenticated
  using (public.has_right(contract_id, 'manage_schedule'));

-- Verify:
--
--   select count(*) from item_jobs; -- expect 18 (16 Hwy 5 + 2 Hwy 97C demo,
--                                       matching items.job_id's own current
--                                       non-null count on both contracts)
--
--   select i.item_number, j.name from item_jobs ij
--   join items i on i.id = ij.item_id
--   join jobs j on j.id = ij.job_id
--   join contracts c on c.id = ij.contract_id
--   where c.contract_no = '26607-0000'
--   order by i.item_number;
--
--   -- Every row above should match the corresponding items.job_id join:
--   select i.item_number, j.name from items i
--   join jobs j on j.id = i.job_id
--   join contracts c on c.id = i.contract_id
--   where c.contract_no = '26607-0000' and i.job_id is not null
--   order by i.item_number;
-- =============================================================================
