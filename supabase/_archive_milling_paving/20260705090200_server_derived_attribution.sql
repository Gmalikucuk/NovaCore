-- Part 2, step 6: replace client-supplied attribution columns with
-- server-derived ones.
--
-- A column DEFAULT alone doesn't stop a client from explicitly supplying a
-- different value (defaults only apply when the column is omitted). Since
-- the stated goal is "do not trust client input", each of these five tables
-- gets a BEFORE INSERT trigger that unconditionally overwrites the
-- attribution column with the derived value, ignoring whatever the client
-- sent. The DEFAULT is added too, purely so `\d` documents the intent, but
-- the trigger is the actual enforcement.
--
-- Postgres doesn't allow a bare subquery in a DEFAULT expression, so the
-- shared "which crew_members row is the current auth session" lookup is
-- wrapped in a small helper function, reused by the DEFAULTs and all five
-- triggers below.
--
-- Behavioral consequence worth flagging: auth.uid() is null for any request
-- without a real Supabase Auth session (e.g. the plain anon key, unauthenticated).
-- Since these columns are NOT NULL, inserts into width_readings, truck_tickets,
-- attribution_history, superintendent_notes, and photo_attachments will now
-- fail unless the request carries a signed-in user's session whose
-- auth_user_id is linked to a crew_members row. This is an intentional
-- consequence of introducing real per-user identity, not a bug — but it means
-- the anon-key-only insert flows tested earlier no longer work for these
-- five tables.

create or replace function public.current_crew_member_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select id from crew_members where auth_user_id = auth.uid();
$$;

alter table width_readings alter column entered_by set default public.current_crew_member_id();
alter table truck_tickets alter column entered_by set default public.current_crew_member_id();
alter table attribution_history alter column changed_by set default public.current_crew_member_id();
alter table superintendent_notes alter column created_by set default public.current_crew_member_id();
alter table photo_attachments alter column captured_by set default public.current_crew_member_id();

create or replace function public.set_entered_by_from_auth()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.entered_by := public.current_crew_member_id();
  return new;
end;
$$;

create trigger width_readings_set_entered_by
before insert on width_readings
for each row execute function public.set_entered_by_from_auth();

create trigger truck_tickets_set_entered_by
before insert on truck_tickets
for each row execute function public.set_entered_by_from_auth();

create or replace function public.set_changed_by_from_auth()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.changed_by := public.current_crew_member_id();
  return new;
end;
$$;

create trigger attribution_history_set_changed_by
before insert on attribution_history
for each row execute function public.set_changed_by_from_auth();

create or replace function public.set_created_by_from_auth()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_by := public.current_crew_member_id();
  return new;
end;
$$;

create trigger superintendent_notes_set_created_by
before insert on superintendent_notes
for each row execute function public.set_created_by_from_auth();

create or replace function public.set_captured_by_from_auth()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.captured_by := public.current_crew_member_id();
  return new;
end;
$$;

create trigger photo_attachments_set_captured_by
before insert on photo_attachments
for each row execute function public.set_captured_by_from_auth();
