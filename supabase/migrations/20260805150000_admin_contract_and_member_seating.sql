-- =============================================================================
-- NovaCore v1 — Migration 0028: Admin — contract creation and member seating
--
-- WHY. Contracts have only ever entered NovaCore by seed script; members
-- have only ever been seated by hand-written migration. The rights and data
-- layer have been ready since 0008 — there has never been a UI. This
-- migration is the three small, specific gaps that stood between the
-- existing rights model and a real screen, found while building one:
--
--   1. A person is seated by email, but profiles has no email column and
--      the client cannot query auth.users directly. Nothing before this
--      resolved "this address" -> "this profiles.id".
--   2. Creating a contract gives the creator NOTHING on it. GC 52.03
--      aside, the creator needs create_items to enter Schedule 7 right
--      after creating the contract, in the same workflow — and
--      contract_members_insert_right requires manage_members, a company-
--      wide right create_projects does NOT imply (the brief is explicit:
--      "Do not conflate them"). Without this, a create_projects-only
--      admin would create a contract and then be unable to populate it
--      themselves, unless someone else with manage_members seated them
--      first purely to unblock their own action.
--   3. Seating someone on a contract you administer but aren't a member of
--      (the actual Finance-seat-on-Hwy-5 scenario this whole feature
--      exists for) requires seeing that contract at all — contracts_
--      select_member's is_member(id) check doesn't see it otherwise.
--
-- Nothing else changes. Every existing right, wall, and policy stands.
--
-- CONSTRAINTS FOLLOWED
--   - Tenancy through is_member()/has_right()/has_global_right() only. No
--     inlined subquery against contract_members. security_invoker was
--     already on for every touched view (none touched here — no view
--     recreated by this migration, so no grant to lose; the "recreating an
--     object drops its grants" lesson from the last pass doesn't apply,
--     restated here only because the brief calls it out explicitly).
--   - The all-rights-true wholesale upsert the seed scripts use for their
--     creator grant does NOT appear here: the creator grant below sets
--     exactly one column (create_items), nothing else, on conflict
--     updating that one column only.
--
-- Requires migrations through 0027.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. find_profile_by_email — the only way to resolve an email to a
--    profiles.id from the client. SECURITY DEFINER to read auth.users at
--    all (PostgREST never exposes it), which means RLS is bypassed
--    entirely inside this function — the manage_members check below is
--    therefore not optional, it is the only thing standing between this
--    function and an open "does this email have an account" oracle for
--    anyone signed in.
--
--    Returns zero or one row, never an error, for an address with no
--    account — "say so plainly rather than failing silently" is the
--    CALLER's job (an empty result IS the plain, honest answer at this
--    layer); raising here would make "no account yet" indistinguishable
--    from a real failure.
--
--    Case/whitespace normalized on both sides — the exact mismatch class
--    that blocked seating three real Finance accounts earlier this session
--    (an invite-flow-stored address vs. a hand-typed one) is exactly what
--    this guards against, at the one place doing the comparison.
-- -----------------------------------------------------------------------------
create or replace function public.find_profile_by_email(p_email text)
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_global_right('manage_members') then
    raise exception 'manage_members required' using errcode = '42501';
  end if;

  return query
    select p.id, p.full_name
    from public.profiles p
    join auth.users u on u.id = p.id
    where lower(btrim(u.email)) = lower(btrim(p_email));
end;
$$;

comment on function public.find_profile_by_email(text) is
  'Resolves an email to a profiles.id for seating — the only client path '
  'to it, since profiles has no email column and auth.users is not '
  'otherwise reachable. Zero rows means no account yet, not an error. '
  'Gated on manage_members, checked explicitly (SECURITY DEFINER bypasses '
  'RLS): without that check this is an unauthenticated existence oracle '
  'over every email in the system.';

revoke execute on function public.find_profile_by_email(text) from public;
grant execute on function public.find_profile_by_email(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. enrol_global_roles() — creator gets create_items, and only that
--
-- Deliberately ONE column, matching the exact value actually needed for
-- the very next step of the workflow this trigger exists to unblock
-- (entering Schedule 7 right after creating the contract) — not the
-- all-rights-true shape the seed scripts use for their own creator grant,
-- which this migration exists partly to stop being the only precedent.
-- on conflict updates that one column only, same reasoning as
-- 20260804100000's restore migration: touch what changed, nothing else.
-- -----------------------------------------------------------------------------
create or replace function public.enrol_global_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.contract_members
    (contract_id, user_id, view_rates, extract_report)
  select new.id, p.id, true, true
  from public.profiles p
  where p.global_role is not null
  on conflict (contract_id, user_id) do nothing;

  if new.created_by is not null then
    insert into public.contract_members (contract_id, user_id, create_items)
    values (new.id, new.created_by, true)
    on conflict (contract_id, user_id) do update set create_items = true;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. contracts — visible to a manage_members holder too, not just a member
--
-- Seating someone on a contract requires seeing it exists at all. Additive
-- (OR), not a replacement: is_member(id) keeps working exactly as before
-- for everyone else; this only widens visibility for the one right whose
-- entire job is administering membership on contracts generally.
-- -----------------------------------------------------------------------------
drop policy if exists contracts_select_member on public.contracts;

create policy contracts_select_member on public.contracts
  for select to authenticated
  using (public.is_member(id) or public.has_global_right('manage_members'));

-- =============================================================================
-- Verify —
--
--   select public.find_profile_by_email('field@novacore.test');
--   -- as a manage_members holder: one row. As anyone else: 42501.
--
--   select public.find_profile_by_email('nobody-real@keywestasphalt.com');
--   -- as a manage_members holder: zero rows, no error.
--
--   -- create a contract as a create_projects holder, then:
--   select create_items, set_cost, set_unit_price from contract_members
--   where contract_id = '<new contract>' and user_id = '<creator>';
--   -- expect create_items = true, everything else false/default —
--   -- NOT the all-rights-true shape.
--
--   -- as a manage_members holder who is NOT a member of some contract C:
--   select id from contracts where id = 'C';
--   -- now returns the row, where it previously returned nothing.
-- =============================================================================
