-- Part 2, step 3-5: link crew_members to auth.users, auto-create a
-- crew_members row on first login.

alter table crew_members add column auth_user_id uuid unique references auth.users (id) on delete set null;

create index idx_crew_members_auth_user_id on crew_members (auth_user_id);

-- ON DELETE SET NULL (not specified in the request): deleting an auth.users
-- row (e.g. offboarding someone's login) shouldn't cascade-delete their
-- crew_members row and the field-data history hanging off it, and shouldn't
-- RESTRICT the auth.users delete either (that would block an admin from ever
-- removing a departed employee's login). SET NULL just unlinks the login
-- while keeping the crew_members row and its history intact. Flagging this
-- choice since it wasn't specified.

-- Auto-creates a crew_members row the first time someone signs in via magic
-- link. role is always 'field_staff' (least-privileged default) and
-- company_id is hardcoded to Keywest Asphalt — this is a single-tenant
-- bootstrap, not a real multi-company signup flow. Once a second company
-- exists, new signups will still need a real company-selection/invite
-- mechanism; this trigger doesn't attempt to solve that yet.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  keywest_company_id uuid;
begin
  select id into keywest_company_id from companies where name = 'Keywest Asphalt';

  insert into crew_members (name, role, active, company_id, auth_user_id)
  values (new.email, 'field_staff', true, keywest_company_id, new.id);

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();
