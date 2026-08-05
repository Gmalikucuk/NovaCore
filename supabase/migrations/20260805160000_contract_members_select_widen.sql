-- =============================================================================
-- NovaCore v1 — Migration 0029: contract_members visible to manage_members
-- too, not just a member
--
-- 0028 widened contracts_select_member so an admin can see a contract they
-- aren't seated on — found immediately after, while building Seat Members'
-- own data layer, that the same gap exists one table over: an admin with
-- manage_members but no personal seat on, say, Hwy 5 could now see that
-- Hwy 5 exists, but still couldn't see who's already seated on it
-- (contract_members_select_own — I mean contract_members_select — still
-- required is_member(contract_id) alone). Seating someone sensibly means
-- seeing who's already there first. Same additive widening, same reasoning.
--
-- Requires migrations through 0028.
-- =============================================================================

drop policy if exists contract_members_select on public.contract_members;

create policy contract_members_select on public.contract_members
  for select to authenticated
  using (public.is_member(contract_id) or public.has_global_right('manage_members'));

-- =============================================================================
-- Verify —
--
--   -- as a manage_members holder who is NOT seated on contract C:
--   select user_id from contract_members where contract_id = 'C';
--   -- now returns every seat, where it previously returned nothing.
-- =============================================================================
