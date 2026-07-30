-- Closes a real gap in the fallback identity model (20260707110000):
-- claimed_crew_member_id() only parsed the UUID out of the request header —
-- it never checked the row actually exists, let alone that it's active.
--
-- Existence was accidentally covered for attribution columns (entered_by
-- etc. have FK constraints, so a nonexistent claimed id would fail there),
-- but NOT for role-gating checks (`where id = ... and role = 'coordinator'`
-- just returns zero rows for a bogus id, which happens to fail safe) — and
-- active status was checked NOWHERE. A claimed id for a real but
-- deactivated crew member (e.g. someone who left) would pass every
-- existing check, including "is this a coordinator".
--
-- Fixing this at the source rather than at each call site: this function is
-- the single place every attribution default, role-gating check, and
-- old-entered-by equality check ultimately reads from (via
-- effective_crew_member_id()), so validating existence+active here
-- propagates everywhere automatically.
create or replace function public.claimed_crew_member_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select cm.id
  from crew_members cm
  where cm.id = nullif(
    (current_setting('request.headers', true)::json ->> 'x-claimed-crew-member-id'),
    ''
  )::uuid
  and cm.active = true;
$$;
