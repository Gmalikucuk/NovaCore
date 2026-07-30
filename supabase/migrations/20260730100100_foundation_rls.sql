-- =============================================================================
-- NovaCore v1 — Migration 0002: RLS policies and grants
-- Per spec §4 and §8 step 2.
--
-- The security model lives HERE, never in React. PostgREST returns whatever the
-- policy allows.
--
-- DO NOT PROCEED PAST THIS FILE UNTIL THE FIELD-SEAT TEST AT THE BOTTOM PASSES.
-- =============================================================================

alter table public.profiles          enable row level security;
alter table public.projects          enable row level security;
alter table public.project_members   enable row level security;
alter table public.line_items        enable row level security;
alter table public.line_item_prices  enable row level security;
alter table public.daily_entries     enable row level security;

-- -----------------------------------------------------------------------------
-- Base grants
--
-- Supabase grants broadly to `authenticated` by default. Everything below
-- narrows that. Note especially daily_entries: UPDATE is granted at COLUMN
-- level only, so no privilege exists to alter a quantity in place regardless of
-- what any policy says. That is belt (grant) and braces (trigger in 0001).
-- -----------------------------------------------------------------------------
revoke all on public.profiles         from anon, authenticated;
revoke all on public.projects         from anon, authenticated;
revoke all on public.project_members  from anon, authenticated;
revoke all on public.line_items       from anon, authenticated;
revoke all on public.line_item_prices from anon, authenticated;
revoke all on public.daily_entries    from anon, authenticated;

grant select                       on public.profiles         to authenticated;
grant update (full_name)           on public.profiles         to authenticated;
grant select, insert               on public.projects         to authenticated;
grant select, insert, delete       on public.project_members  to authenticated;
grant select, insert, update       on public.line_items       to authenticated;
grant select, insert, update       on public.line_item_prices to authenticated;
grant select, insert               on public.daily_entries    to authenticated;
grant update (status, confirmed_by, confirmed_at)
                                   on public.daily_entries    to authenticated;

grant select on public.daily_entries_effective  to authenticated;
grant select on public.v_line_item_progress     to authenticated;
grant select on public.v_line_item_finance      to authenticated;

-- =============================================================================
-- profiles
-- =============================================================================
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- names of people you share a project with, for attribution display
create policy profiles_select_shared on public.profiles
  for select to authenticated
  using (
    exists (
      select 1 from public.project_members pm
      where pm.user_id = public.profiles.id
        and public.is_member(pm.project_id)
    )
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- =============================================================================
-- projects
-- =============================================================================
create policy projects_select_member on public.projects
  for select to authenticated
  using (public.is_member(id));

-- v1 keeps creation owner-only (spec §4). The enrolment trigger seats them.
create policy projects_insert_owner on public.projects
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and global_role = 'owner'
    )
  );

-- =============================================================================
-- project_members
--
-- The is_member() call here is why that function must be security definer:
-- a plain function would re-enter this policy and recurse.
-- =============================================================================
create policy project_members_select on public.project_members
  for select to authenticated
  using (public.is_member(project_id));

create policy project_members_manage on public.project_members
  for insert to authenticated
  with check (public.member_role(project_id) = 'owner');

create policy project_members_remove on public.project_members
  for delete to authenticated
  using (public.member_role(project_id) = 'owner');

-- =============================================================================
-- line_items — quantity side, visible to all members including field
-- =============================================================================
create policy line_items_select_member on public.line_items
  for select to authenticated
  using (public.is_member(project_id));

create policy line_items_write_pm on public.line_items
  for insert to authenticated
  with check (public.member_role(project_id) = 'project_manager');

create policy line_items_update_pm on public.line_items
  for update to authenticated
  using (public.member_role(project_id) = 'project_manager')
  with check (public.member_role(project_id) = 'project_manager');

-- =============================================================================
-- line_item_prices — THE LOAD-BEARING POLICY
--
-- `field` is absent from both lists. There is no query shape, join, filter, or
-- embed that returns a price to a field seat, because the row is not visible at
-- all. This is why the sibling-table option was chosen over a view or an RPC:
-- the wall is structural, not policy-dependent.
-- =============================================================================
create policy prices_select_finance on public.line_item_prices
  for select to authenticated
  using (public.can_see_finance(project_id));

create policy prices_insert_pm on public.line_item_prices
  for insert to authenticated
  with check (public.member_role(project_id) = 'project_manager');

create policy prices_update_pm on public.line_item_prices
  for update to authenticated
  using (public.member_role(project_id) = 'project_manager')
  with check (public.member_role(project_id) = 'project_manager');

-- =============================================================================
-- daily_entries — quantities are NOT walled
-- =============================================================================
create policy entries_select_member on public.daily_entries
  for select to authenticated
  using (public.is_member(project_id));

create policy entries_insert_writer on public.daily_entries
  for insert to authenticated
  with check (
    public.member_role(project_id) in ('field', 'project_manager')
    and created_by = auth.uid()
  );

-- Confirmation. The column grant above means this can only ever touch status
-- and the two audit columns; the 0001 trigger blocks un-confirming.
create policy entries_confirm_pm on public.daily_entries
  for update to authenticated
  using (public.member_role(project_id) = 'project_manager')
  with check (public.member_role(project_id) = 'project_manager');

-- No DELETE policy and no DELETE grant: entries cannot be removed via the API
-- in v1. Voiding is a superseding row.

-- =============================================================================
-- ACCEPTANCE TEST — §4, and §8 says do not skip it
--
-- Authenticate as a `field` user and hit PostgREST directly. Not the UI: the
-- network tab is the attacker. Every one of these must come back empty or 401.
--
--   TOKEN=<field user's access token>
--   API=https://<ref>.supabase.co/rest/v1
--
--   # the table itself
--   curl "$API/line_item_prices?select=*" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN"
--
--   # via an embed off a table field CAN read
--   curl "$API/line_items?select=*,line_item_prices(*)" -H ... 
--
--   # via the finance view
--   curl "$API/v_line_item_finance?select=*" -H ...
--
--   # unfiltered, across every project in the database
--   curl "$API/line_item_prices?select=cost_price,sell_price&limit=1000" -H ...
--
--   # and confirm the field seat CAN still do its job
--   curl "$API/v_line_item_progress?select=*" -H ...        -> rows expected
--   curl -X POST "$API/daily_entries" -d '{...}' -H ...     -> insert expected
--
-- Also verify, as a field user:
--   - UPDATE of a quantity is rejected (column grant, then trigger)
--   - UPDATE of status is rejected (policy: PM only)
--   - INSERT with created_by set to someone else is rejected
--
-- If the four price probes return no data and the two capability probes work,
-- the wall holds. Then, and only then, write React.
-- =============================================================================
