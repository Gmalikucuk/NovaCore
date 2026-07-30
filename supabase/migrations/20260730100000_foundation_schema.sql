-- =============================================================================
-- NovaCore v1 — Migration 0001: Foundation schema
-- Per NovaCore-v1-foundation-spec.md (22 July 2026), §2 and §8 step 1.
--
-- Run order: this file, then 0002_foundation_rls.sql.
-- PRECONDITION: the target Supabase project's `public` schema must be EMPTY.
-- Verify before running (see handoff §2 — this was never confirmed).
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- profiles
-- Mirrors auth.users. `global_role` is the source for owner/cfo auto-enrolment
-- (spec §2.1 — flag chosen over a separate app_roles table, fewer moving parts).
-- -----------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text,
  global_role  text check (global_role in ('owner', 'cfo')),
  created_at   timestamptz not null default now()
);

comment on column public.profiles.global_role is
  'null for ordinary users. owner/cfo are auto-enrolled into every new project.';

-- -----------------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------------
create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  contract_no  text,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  archived     boolean not null default false
);

-- -----------------------------------------------------------------------------
-- project_members — the access-control root
-- -----------------------------------------------------------------------------
create table public.project_members (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('field', 'project_manager', 'cfo', 'owner')),
  created_at  timestamptz not null default now(),
  unique (project_id, user_id)
);

create index project_members_user_idx on public.project_members (user_id);

-- -----------------------------------------------------------------------------
-- line_items — the spine. Quantity-side only; prices live in a sibling table.
--
-- The extra `unique (id, project_id)` is not redundant: it is the target for
-- composite foreign keys from line_item_prices and daily_entries, which makes
-- a cross-project mismatch structurally impossible rather than trigger-checked.
-- -----------------------------------------------------------------------------
create table public.line_items (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  item_no       text not null,
  description   text not null,
  unit          text not null,
  bid_quantity  numeric not null default 0 check (bid_quantity >= 0),
  created_at    timestamptz not null default now(),
  unique (project_id, item_no),
  unique (id, project_id)
);

-- -----------------------------------------------------------------------------
-- line_item_prices — THE FINANCE WALL
--
-- Spec §4 offered three implementations; only this one is a wall rather than a
-- policy you have to get right. `field` is denied this table outright, so there
-- is no query shape that returns a price to a field seat. project_id is carried
-- here (with a composite FK guaranteeing it matches the parent) so policies can
-- scope by project without a per-row subquery.
-- -----------------------------------------------------------------------------
create table public.line_item_prices (
  line_item_id  uuid primary key references public.line_items(id) on delete cascade,
  project_id    uuid not null,
  cost_price    numeric check (cost_price >= 0),
  sell_price    numeric check (sell_price >= 0),
  updated_by    uuid references public.profiles(id),
  updated_at    timestamptz not null default now(),
  foreign key (line_item_id, project_id)
    references public.line_items (id, project_id) on delete cascade
);

-- -----------------------------------------------------------------------------
-- daily_entries — field capture, Dexie-synced
--
-- id is CLIENT-GENERATED (spec §3): no server default, so an offline device
-- mints the uuid at capture time and a retried insert is idempotent.
-- entry_date is the WORK date, entered explicitly, never the device clock.
-- -----------------------------------------------------------------------------
create table public.daily_entries (
  id            uuid primary key,
  project_id    uuid not null references public.projects(id) on delete cascade,
  line_item_id  uuid not null,
  entry_date    date not null,
  location      text,
  quantity      numeric not null check (quantity >= 0),
  note          text,
  status        text not null default 'draft' check (status in ('draft', 'confirmed')),
  supersedes    uuid references public.daily_entries(id),
  confirmed_by  uuid references public.profiles(id),
  confirmed_at  timestamptz,
  created_by    uuid not null references public.profiles(id) default auth.uid(),
  device_id     text,
  created_at    timestamptz not null default now(),
  synced_at     timestamptz not null default now(),

  foreign key (line_item_id, project_id)
    references public.line_items (id, project_id),

  -- a row cannot replace itself
  constraint daily_entries_no_self_supersede
    check (supersedes is distinct from id),

  -- confirmation audit fields move together with status
  constraint daily_entries_confirmed_coherent
    check (
      (status = 'confirmed' and confirmed_at is not null and confirmed_by is not null)
      or
      (status = 'draft' and confirmed_at is null and confirmed_by is null)
    )
);

-- One correction per parent. Without this, two rows can supersede the same
-- entry and the effective-total query silently double-counts or drops quantity
-- depending on how the chain is walked. Same pattern as the archived build's
-- width_readings index.
create unique index daily_entries_one_correction_per_parent
  on public.daily_entries (supersedes)
  where supersedes is not null;

create index daily_entries_project_date_idx
  on public.daily_entries (project_id, entry_date);
create index daily_entries_line_item_idx
  on public.daily_entries (line_item_id);

-- =============================================================================
-- Helper functions
--
-- CRITICAL (see below): security definer is not optional here. project_members
-- has RLS enabled, and its own policy calls is_member(). A plain function would
-- re-enter that policy and recurse. security definer executes as the function
-- owner, bypassing RLS on the read, which breaks the cycle.
--
-- ARCHITECTURAL RULE — the tenancy boundary is expressed ONLY through these two
-- functions. No policy, view, or query anywhere may inline its own subquery
-- against project_members. This rule is the entire cost of keeping the door
-- open to multi-org tenancy later: when organisations arrive, the boundary
-- moves by rewriting these two functions and nothing else. One inlined
-- subquery turns that bounded change into an audit of every policy.
-- =============================================================================

create or replace function public.is_member(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.project_members
    where project_id = p_project
      and user_id = auth.uid()
  );
$$;

create or replace function public.member_role(p_project uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.project_members
  where project_id = p_project
    and user_id = auth.uid();
$$;

-- Convenience predicate used by finance policies. Deliberately expressed in
-- terms of member_role() rather than its own subquery.
create or replace function public.can_see_finance(p_project uuid)
returns boolean
language sql
stable
as $$
  select public.member_role(p_project) in ('project_manager', 'cfo', 'owner');
$$;

-- =============================================================================
-- Triggers
-- =============================================================================

-- profile on signup ---------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- owner/cfo auto-enrolment (spec §1) ----------------------------------------
-- Global view = union of memberships, so there is no god-mode branch in any
-- policy. NOTE: this trigger is the specific thing that must change if
-- organisations are ever introduced — as written it enrols EVERY global
-- owner/cfo into EVERY new project, which is correct for one company and a
-- cross-tenant leak for many.
create or replace function public.enrol_global_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  select new.id, p.id, p.global_role
  from public.profiles p
  where p.global_role is not null
  on conflict (project_id, user_id) do nothing;

  -- the creator gets a seat too, if they aren't already enrolled above
  if new.created_by is not null then
    insert into public.project_members (project_id, user_id, role)
    values (new.id, new.created_by, 'project_manager')
    on conflict (project_id, user_id) do nothing;
  end if;

  return new;
end;
$$;

create trigger on_project_created
  after insert on public.projects
  for each row execute function public.enrol_global_roles();

-- supersession integrity ----------------------------------------------------
-- A correction must replace a row on the same line item, and must not chain
-- into a different project. The composite FK covers item↔project coherence;
-- this covers parent↔child coherence.
create or replace function public.check_supersede_target()
returns trigger
language plpgsql
as $$
declare
  parent record;
begin
  if new.supersedes is null then
    return new;
  end if;

  select project_id, line_item_id
    into parent
  from public.daily_entries
  where id = new.supersedes;

  if not found then
    raise exception 'supersedes target % does not exist', new.supersedes;
  end if;

  if parent.project_id <> new.project_id
     or parent.line_item_id <> new.line_item_id then
    raise exception
      'a correction must replace an entry on the same project and line item';
  end if;

  return new;
end;
$$;

create trigger daily_entries_supersede_integrity
  before insert or update on public.daily_entries
  for each row execute function public.check_supersede_target();

-- status transition guard ---------------------------------------------------
-- Field entries are reviewed before final status, and may be corrected after
-- it. Confirmation is therefore one-way: draft -> confirmed only. An
-- un-confirm would remove quantity from the finance dashboard with no audit
-- record, which is exactly the failure mode append-only exists to prevent.
-- Post-confirmation changes go through a superseding row instead.
create or replace function public.guard_entry_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'confirmed' and new.status = 'draft' then
    raise exception
      'a confirmed entry cannot be un-confirmed; supersede it instead';
  end if;

  -- Only status/confirmation fields may ever change on an existing row.
  -- Column-level GRANTs in 0002 are the primary enforcement; this is the
  -- backstop for anything holding wider privileges.
  if row(new.project_id, new.line_item_id, new.entry_date, new.quantity,
         new.location, new.note, new.supersedes, new.created_by, new.device_id)
     is distinct from
     row(old.project_id, old.line_item_id, old.entry_date, old.quantity,
         old.location, old.note, old.supersedes, old.created_by, old.device_id)
  then
    raise exception
      'daily_entries rows are append-only; correct by inserting a superseding row';
  end if;

  if old.status = 'draft' and new.status = 'confirmed' then
    new.confirmed_by := coalesce(new.confirmed_by, auth.uid());
    new.confirmed_at := coalesce(new.confirmed_at, now());
  end if;

  return new;
end;
$$;

create trigger daily_entries_transition_guard
  before update on public.daily_entries
  for each row execute function public.guard_entry_transitions();

-- price audit stamp ---------------------------------------------------------
create or replace function public.stamp_price_update()
returns trigger
language plpgsql
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger line_item_prices_stamp
  before insert or update on public.line_item_prices
  for each row execute function public.stamp_price_update();

-- =============================================================================
-- Effective-quantity view — the supersession rule
--
-- A row leaves the placed total only when its replacement ENTERS it. An entry
-- counts when it is confirmed and has no CONFIRMED successor.
--
-- Why this matters: a measurement review supersedes a confirmed entry with a
-- draft correction. Under a naive "exclude anything superseded" rule the
-- parent drops out immediately while the child has not yet been confirmed, so
-- the tonnage sits in neither and the margin figure is silently wrong for the
-- duration of the review — during the exact window when the numbers are
-- already under suspicion.
--
-- security_invoker = on so RLS on daily_entries applies to the CALLER, not the
-- view owner. Without it the view is a hole straight through every policy.
-- =============================================================================
create view public.daily_entries_effective
with (security_invoker = on) as
select e.*
from public.daily_entries e
where e.status = 'confirmed'
  and not exists (
    select 1
    from public.daily_entries c
    where c.supersedes = e.id
      and c.status = 'confirmed'
  );

-- quantities-only progress: safe for every role, no path to price data
create view public.v_line_item_progress
with (security_invoker = on) as
select
  li.id                as line_item_id,
  li.project_id,
  li.item_no,
  li.description,
  li.unit,
  li.bid_quantity,
  coalesce(sum(e.quantity), 0)                     as placed_to_date,
  coalesce(sum(e.quantity), 0)
    / nullif(li.bid_quantity, 0)                   as percent_complete,
  count(e.id)                                      as entry_count,
  max(e.entry_date)                                as last_entry_date
from public.line_items li
left join public.daily_entries_effective e
  on e.line_item_id = li.id
group by li.id, li.project_id, li.item_no, li.description, li.unit, li.bid_quantity;

-- finance view: reachable only by roles whose policy permits line_item_prices
create view public.v_line_item_finance
with (security_invoker = on) as
select
  p.line_item_id,
  p.project_id,
  p.cost_price,
  p.sell_price,
  prog.placed_to_date,
  prog.placed_to_date * p.cost_price               as cost_to_date,
  prog.placed_to_date * p.sell_price               as revenue_to_date,
  prog.placed_to_date * (p.sell_price - p.cost_price) as margin,
  case
    when prog.placed_to_date * p.sell_price > 0
      then (p.sell_price - p.cost_price) / p.sell_price
  end                                              as margin_percent
from public.line_item_prices p
join public.v_line_item_progress prog
  on prog.line_item_id = p.line_item_id;

comment on view public.v_line_item_finance is
  'Revenue is placed x sell_price: internal expectation, NOT Ministry-approved '
  'payment. Paid-vs-placed reconciliation is a deliberate v1 non-goal (spec §6).';
