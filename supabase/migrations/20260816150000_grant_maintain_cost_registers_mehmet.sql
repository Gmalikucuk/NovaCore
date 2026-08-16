-- =============================================================================
-- NovaCore v1 — Migration: grant maintain_cost_registers to
-- mehmet.kucuk.scm@gmail.com
--
-- No screen exists yet for granting company-wide rights (0047/0048's own
-- gap, reported rather than worked around) — every one of them, on every
-- profile that holds one today, has been granted by a migration like this
-- one, scoped to a verified email, never a shared/guessed identifier.
--
-- maintain_cost_registers alone is what was asked for — it implies read of
-- rates (0048's own departure from the bids split), so no separate grant
-- of view_cost_register_rates is needed alongside it.
--
-- Guard raises a named exception rather than silently granting nothing if
-- the account doesn't exist yet — same posture as 0020's Finance-seat
-- migration (this migration does not create accounts).
--
-- Requires migrations through 20260816140000.
-- =============================================================================

do $$
declare
  v_user uuid;
begin
  select id into v_user from auth.users where email = 'mehmet.kucuk.scm@gmail.com';

  if v_user is null then
    raise exception
      'No account exists for mehmet.kucuk.scm@gmail.com — this migration does not create accounts.';
  end if;

  update public.profiles
  set maintain_cost_registers = true
  where id = v_user;
end $$;

-- =============================================================================
-- Verify —
--
--   select u.email, p.maintain_cost_registers, p.view_cost_register_rates
--   from profiles p join auth.users u on u.id = p.id
--   where u.email = 'mehmet.kucuk.scm@gmail.com';
--   -- expect: maintain_cost_registers = true, view_cost_register_rates
--   -- unchanged (false, unless already granted separately)
-- =============================================================================
