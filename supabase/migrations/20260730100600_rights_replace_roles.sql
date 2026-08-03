-- =============================================================================
-- NovaCore v1 — Migration 0008: rights replace roles
--
-- Supersedes 0007's role model entirely. Roles are removed as a concept: a user
-- holds a set of rights, and any combination is valid. The same person can hold
-- several rights on the same project — which the single `role` column could not
-- express, and which is why it is going.
--
-- 0007 was drafted but never applied to this database or committed to this repo
-- — confirmed live before writing this file: `supabase migration list` shows
-- the last applied migration as 0006 (20260730100500), and the current schema
-- is still exactly 0002's role model (project_members.role in
-- 'field'/'project_manager'/'cfo'/'owner', profiles.global_role in
-- 'owner'/'cfo', policies named projects_insert_owner /
-- project_members_manage / project_members_remove, member_role() and
-- can_see_finance() both present). This file goes straight from that real
-- state to the rights model — it does not assume 0007 ran. Two amendments
-- from the version as drafted, both because 0007 never touched this database:
--
--   1. Section 2's company-wide backfill checked `global_role = 'admin'`,
--      a value that has never existed here (0007 would have introduced it).
--      The only real values are 'owner' and 'cfo', and only 'owner' ever had
--      create/manage authority (see 0002's projects_insert_owner). Backfills
--      from 'owner' instead — 'cfo' stays visibility-only, matching its
--      original scope.
--
--   2. Section 6 originally only dropped 0007's hypothetical '_admin'-suffixed
--      policy names (projects_insert_admin, projects_update_admin,
--      project_members_manage_admin, project_members_remove_admin) — all
--      guarded with IF EXISTS, all no-ops here since 0007 never created them.
--      The REAL policies live from 0002 — projects_insert_owner,
--      project_members_manage, project_members_remove — were never targeted
--      and are dropped explicitly below.
--
--   3. Confirmed the hard way: the file as drafted dropped member_role() in
--      section 4, BEFORE section 6 drops the six 0002 policies that still
--      call it (line_items_write_pm, line_items_update_pm, prices_insert_pm,
--      prices_update_pm, entries_insert_writer, entries_confirm_pm — plus
--      project_members_manage/remove from amendment 2 above). Postgres
--      refuses a DROP FUNCTION while any live policy still depends on it —
--      `supabase db push` failed cleanly on this exact error on the first
--      attempt (SQLSTATE 2BP01), transactional, zero schema change. Re-ran
--      the policy/column/function checks below afterward to confirm nothing
--      moved. Fixed by moving both old-function drops (member_role,
--      can_see_finance) to the end of section 6, after every policy that
--      could reference them has already been dropped.
--
-- Spec §7 anticipated this and called it "a migration, not a rewrite". True of
-- the schema. Every policy still has to be rewritten, because each one reads
-- member_role() today.
--
-- THE RIGHTS
--
-- Per-project, on the membership row:
--   create_line_items    add/edit line item definitions (e.g. a change order)
--   set_cost             set unit cost
--   set_bid_rate         set bid rate
--   enter_quantity       create daily entries
--   correct_quantity     create a superseding entry (NOT an in-place edit —
--                        the table is append-only; "edit" is not available to
--                        anyone at any right level)
--   confirm_quantity     move an entry to confirmed, where it counts
--   view_rates           see cost and bid rate, and therefore margin. Margin
--                        requires both, so one flag covers it.
--   extract_report       export to file. Separate from view_rates on purpose:
--                        reading a rate sheet on screen and walking out with
--                        the spreadsheet are different exposures.
--
-- Company-wide, on profiles:
--   create_projects      a project cannot be created "on" a project
--   manage_members       seat people and set their rights
--
-- NOT rights, deliberately:
--   view quantities      implicit in project membership. If you are seated on a
--                        project you see its quantities.
--   dashboard access     the dashboard shows quantities and, if view_rates,
--                        money. Both already gated. A separate flag would allow
--                        a state where a user may see the data but not the page
--                        that shows it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Per-project rights
--
-- Default false throughout: a new membership grants visibility and nothing else.
-- Adding a right is then always a deliberate act, and a forgotten column fails
-- closed rather than open.
-- -----------------------------------------------------------------------------
alter table public.project_members
  add column create_line_items  boolean not null default false,
  add column set_cost           boolean not null default false,
  add column set_bid_rate       boolean not null default false,
  add column enter_quantity     boolean not null default false,
  add column correct_quantity   boolean not null default false,
  add column confirm_quantity   boolean not null default false,
  add column view_rates         boolean not null default false,
  add column extract_report     boolean not null default false;

-- Backfill from the roles being retired, so nobody loses access mid-migration.
update public.project_members set
  create_line_items = (role = 'project_manager'),
  set_cost          = (role = 'project_manager'),
  set_bid_rate      = (role = 'project_manager'),
  enter_quantity    = (role in ('field', 'project_manager')),
  correct_quantity  = (role in ('field', 'project_manager')),
  confirm_quantity  = (role = 'project_manager'),
  view_rates        = (role in ('project_manager', 'cfo', 'owner')),
  extract_report    = (role in ('project_manager', 'cfo', 'owner'));

-- -----------------------------------------------------------------------------
-- 2. Company-wide rights
--
-- AMENDMENT (see header): backfilled from global_role = 'owner', not 'admin'
-- — 'admin' has never been a real value here. 'cfo' is intentionally excluded:
-- it was always a visibility-only global role (auto-enrolled for view_rates /
-- extract_report per project, via the trigger in section 5), never a
-- project-creation or member-management grant — matching 0002's
-- projects_insert_owner, which checked global_role = 'owner' specifically.
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column create_projects boolean not null default false,
  add column manage_members  boolean not null default false;

update public.profiles set
  create_projects = (global_role = 'owner'),
  manage_members  = (global_role = 'owner')
where global_role is not null;

-- -----------------------------------------------------------------------------
-- 3. Retire the role columns
--
-- `global_role` is kept — not as a permission, but because the enrolment trigger
-- needs to know who should be auto-seated on every new project. Renamed in
-- meaning: it is now a scope marker, not a right. Nothing reads it to decide
-- what a user may do.
-- -----------------------------------------------------------------------------
alter table public.project_members drop column role;

comment on column public.profiles.global_role is
  'Scope marker only, NOT a permission. Determines who is auto-enrolled onto '
  'every new project. Rights are the boolean columns; nothing reads this to '
  'decide what a user may do.';

-- -----------------------------------------------------------------------------
-- 4. Helper functions
--
-- member_role() is dropped: nothing may branch on a role any more. Replaced by
-- has_right(), which every policy goes through.
--
-- THE STANDING RULE IS UNCHANGED IN SPIRIT AND NOW ALSO COVERS RIGHTS: no
-- policy, view or query may inline its own subquery against project_members.
-- Membership and rights are both expressed only through these functions. When
-- organisations arrive, or when a right is added, the change lands here and
-- nowhere else.
--
-- security definer for the same reason as before: project_members has RLS whose
-- own policy calls these, and a plain function would recurse.
-- -----------------------------------------------------------------------------

-- AMENDMENT (see header, point 3): member_role() and can_see_finance() are
-- NOT dropped here. Six 0002 policies still call member_role() at this point
-- in the file (rewritten later in section 6) — dropping it now fails the
-- whole migration on a live dependency. Both are dropped at the end of
-- section 6 instead, once every policy that could reference them is gone.

create or replace function public.has_right(p_project uuid, p_right text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ok boolean;
begin
  execute format(
    'select coalesce(bool_or(%I), false) from public.project_members
      where project_id = $1 and user_id = $2',
    p_right
  )
  into ok
  using p_project, auth.uid();
  return ok;
end;
$$;

comment on function public.has_right(uuid, text) is
  'The only sanctioned way to test a per-project right. format(%I) quotes the '
  'column identifier, so an unknown right name raises rather than silently '
  'returning false — a typo in a policy fails loudly instead of granting or '
  'denying by accident.';

create or replace function public.has_global_right(p_right text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ok boolean;
begin
  execute format(
    'select coalesce(bool_or(%I), false) from public.profiles where id = $1',
    p_right
  )
  into ok
  using auth.uid();
  return ok;
end;
$$;

-- is_member() is unchanged and still the tenancy boundary.
-- is_admin() is retired: admin is no longer a thing, manage_members is.
-- (0007 never created it here; IF EXISTS makes this a no-op, kept for parity
-- with the file as drafted and in case some other session did create it.)
drop function if exists public.is_admin();

-- -----------------------------------------------------------------------------
-- 5. Enrolment trigger — rights, not a role
--
-- Auto-enrolled users get visibility plus view_rates and extract_report, which
-- is what the finance and management seats were for. They get no write rights;
-- anything more is granted explicitly by someone holding manage_members.
-- The creator is NOT auto-seated (established in 0007 and still correct):
-- creating a project does not make you its manager.
-- -----------------------------------------------------------------------------
create or replace function public.enrol_global_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members
    (project_id, user_id, view_rates, extract_report)
  select new.id, p.id, true, true
  from public.profiles p
  where p.global_role is not null
  on conflict (project_id, user_id) do nothing;

  return new;
end;
$$;

-- =============================================================================
-- 6. POLICIES — every one rewritten
-- =============================================================================

-- projects --------------------------------------------------------------------
-- 0007's hypothetical names — guarded, no-ops here since 0007 never ran.
drop policy if exists projects_insert_admin on public.projects;
drop policy if exists projects_update_admin on public.projects;
-- AMENDMENT (see header): the REAL 0002 policy, dropped explicitly.
drop policy if exists projects_insert_owner on public.projects;

create policy projects_insert_right on public.projects
  for insert to authenticated
  with check (created_by = auth.uid() and public.has_global_right('create_projects'));

create policy projects_update_right on public.projects
  for update to authenticated
  using (public.has_global_right('manage_members'))
  with check (public.has_global_right('manage_members'));

-- project_members -------------------------------------------------------------
-- 0007's hypothetical names — guarded, no-ops here since 0007 never ran.
drop policy if exists project_members_manage_admin on public.project_members;
drop policy if exists project_members_remove_admin on public.project_members;
-- AMENDMENT (see header): the REAL 0002 policies, dropped explicitly.
drop policy if exists project_members_manage on public.project_members;
drop policy if exists project_members_remove on public.project_members;

create policy members_insert_right on public.project_members
  for insert to authenticated
  with check (public.has_global_right('manage_members'));

create policy members_update_right on public.project_members
  for update to authenticated
  using (public.has_global_right('manage_members'))
  with check (public.has_global_right('manage_members'));

create policy members_remove_right on public.project_members
  for delete to authenticated
  using (public.has_global_right('manage_members'));

grant update (create_line_items, set_cost, set_bid_rate, enter_quantity,
              correct_quantity, confirm_quantity, view_rates, extract_report)
  on public.project_members to authenticated;

-- line_items ------------------------------------------------------------------
drop policy if exists line_items_write_pm on public.line_items;
drop policy if exists line_items_update_pm on public.line_items;

create policy line_items_insert_right on public.line_items
  for insert to authenticated
  with check (public.has_right(project_id, 'create_line_items'));

create policy line_items_update_right on public.line_items
  for update to authenticated
  using (public.has_right(project_id, 'create_line_items'))
  with check (public.has_right(project_id, 'create_line_items'));

-- line_item_prices — THE FINANCE WALL -----------------------------------------
--
-- Read is one flag, because margin needs both numbers and there is no useful
-- state where a user sees cost but not bid rate.
--
-- Write is two flags, because cost and bid rate are set by different people:
-- the bid rate comes off the tendered submission, the cost off the estimate.
-- Since both live in one row, PostgREST cannot enforce per-column writes — so a
-- write requires BOTH flags. Splitting the table would be the alternative and is
-- not worth it in v1; note it if the separation is ever needed in practice.
drop policy if exists prices_select_finance on public.line_item_prices;
drop policy if exists prices_insert_pm on public.line_item_prices;
drop policy if exists prices_update_pm on public.line_item_prices;

create policy prices_select_right on public.line_item_prices
  for select to authenticated
  using (public.has_right(project_id, 'view_rates'));

create policy prices_insert_right on public.line_item_prices
  for insert to authenticated
  with check (
    public.has_right(project_id, 'set_cost')
    and public.has_right(project_id, 'set_bid_rate')
  );

create policy prices_update_right on public.line_item_prices
  for update to authenticated
  using (
    public.has_right(project_id, 'set_cost')
    and public.has_right(project_id, 'set_bid_rate')
  )
  with check (
    public.has_right(project_id, 'set_cost')
    and public.has_right(project_id, 'set_bid_rate')
  );

-- daily_entries ---------------------------------------------------------------
--
-- enter_quantity covers an original entry; correct_quantity covers a superseding
-- one. The two are separable: a reviewer may be allowed to correct without being
-- the person who logs production.
drop policy if exists entries_insert_writer on public.daily_entries;
drop policy if exists entries_confirm_pm on public.daily_entries;

create policy entries_insert_right on public.daily_entries
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      (supersedes is null     and public.has_right(project_id, 'enter_quantity'))
      or
      (supersedes is not null and public.has_right(project_id, 'correct_quantity'))
    )
  );

create policy entries_confirm_right on public.daily_entries
  for update to authenticated
  using (public.has_right(project_id, 'confirm_quantity'))
  with check (public.has_right(project_id, 'confirm_quantity'));

-- AMENDMENT (see header, point 3): every policy that could reference these is
-- gone by this point (all six 0002 policies dropped above, in this section).
-- Safe to drop now.
drop function if exists public.member_role(uuid);
drop function if exists public.can_see_finance(uuid);

-- =============================================================================
-- 7. PROBE SUITE — must be rewritten, not adjusted
--
-- The seats are no longer roles. Keep the four existing test users as fixtures
-- with deliberately narrow, awkward right sets — a single all-rights account
-- cannot prove the wall holds, because proving it requires a seat that lacks a
-- right and gets nothing back.
--
-- Suggested fixtures:
--   probe-quantities   enter + correct only            (the old field seat)
--   probe-full         every per-project right         (the old PM seat)
--   probe-viewer       view_rates + extract only       (the old cfo seat)
--   probe-readonly     no rights at all, seated        (tests that membership
--                                                       alone grants nothing)
--
-- Probes that must exist:
--   - probe-quantities SELECT line_item_prices              -> EMPTY
--   - probe-quantities SELECT v_line_item_finance           -> EMPTY
--   - probe-quantities embed line_items?select=*,prices(*)  -> prices EMPTY
--   - probe-readonly   SELECT line_item_prices              -> EMPTY
--   - probe-readonly   SELECT daily_entries                 -> rows (membership
--                                                              grants visibility)
--   - probe-readonly   INSERT daily_entries                 -> rejected
--   - probe-viewer     SELECT line_item_prices              -> rows
--   - probe-viewer     INSERT/UPDATE anything               -> rejected
--   - probe-quantities INSERT entry (supersedes null)       -> succeeds
--   - a seat with correct_quantity but NOT enter_quantity:
--       INSERT with supersedes null                         -> rejected
--       INSERT with supersedes set                          -> succeeds
--     This pair is the one most likely to break under a later change and the
--     one a role-based suite could not express at all.
--   - probe-full but WITHOUT create_projects: INSERT project -> rejected
--     (per-project rights must not imply company-wide ones)
--
-- Positive controls stay mandatory: a suite where everything is expected empty
-- passes just as well when authentication is silently broken.
-- =============================================================================
