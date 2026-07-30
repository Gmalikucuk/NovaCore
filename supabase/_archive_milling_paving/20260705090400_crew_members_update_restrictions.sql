-- Part 2 addendum: close the self-promotion gap. The crew_members_update RLS
-- policy from Part 1 (`using (true) with check (true)`) stays as-is — same
-- pattern as reconstruction_runs/width_readings, where RLS allows the
-- attempt and this trigger does the actual gating.
--
-- BUG CAUGHT BY LOCAL TESTING: without a bypass, this trigger blocks the
-- very first coordinator promotion, full stop — there's no coordinator yet
-- to authorize it, and triggers fire regardless of role (unlike RLS, which
-- superuser/service_role already bypasses). Direct database access (the SQL
-- Editor, `supabase db query --linked`, migrations themselves) connects as
-- something other than `anon`/`authenticated` — trusting that access is the
-- bootstrap path, consistent with how RLS already treats those roles as
-- trusted.

create or replace function enforce_crew_members_update_restrictions()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_coordinator boolean;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if new.company_id is distinct from old.company_id then
    raise exception 'crew_members.company_id cannot be changed after creation';
  end if;

  if new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'crew_members.auth_user_id cannot be changed after creation';
  end if;

  select exists (
    select 1 from crew_members
    where auth_user_id = auth.uid() and role = 'coordinator'
  ) into acting_is_coordinator;

  if (new.role is distinct from old.role or new.active is distinct from old.active)
     and not acting_is_coordinator
  then
    raise exception 'only a coordinator may change role or active';
  end if;

  if new.name is distinct from old.name
     and not (old.auth_user_id = auth.uid() or acting_is_coordinator)
  then
    raise exception 'name may only be changed by the account owner or a coordinator';
  end if;

  return new;
end;
$$;

create trigger crew_members_restrict_update
before update on crew_members
for each row execute function enforce_crew_members_update_restrictions();
