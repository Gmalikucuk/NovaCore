-- ============================================================================
-- TEMPORARY UNAUTHENTICATED FALLBACK — NOT A PERMANENT SECURITY POSTURE
-- ============================================================================
-- Real auth (Google OAuth, restricted to @keywestasphalt.com) is paused, not
-- cancelled. This migration adds a client-supplied, SELF-ASSERTED identity
-- as a fallback for when there is no real Supabase Auth session — it does
-- NOT remove or weaken any of the real-auth infrastructure. auth_user_id,
-- the signup trigger, and every trigger's real auth.uid()-based check all
-- stay exactly as they are; they simply now sit ahead of a new fallback
-- rather than being the only path.
--
-- Mechanism: the client sends the currently "claimed" crew_member id (from
-- a local, unverified profile picker — no password, no session) as a
-- request header, X-Claimed-Crew-Member-Id. PostgREST exposes all request
-- headers to Postgres as the `request.headers` GUC for the duration of that
-- request — confirmed empirically against this project before writing this
-- migration (a header sent via curl came through in
-- current_setting('request.headers', true) exactly as expected). This is
-- NOT a session, NOT verified, and trivially spoofable by anyone who can
-- reach the API — anyone with the anon key can claim to be any crew member.
-- It exists purely so the app is usable before real auth lands, and every
-- place it's used, auth.uid() is checked FIRST and wins whenever a real
-- session exists.
--
-- Retire this migration's effects once Google OAuth ships: the
-- effective_crew_member_id()/claimed_crew_member_id() functions can be
-- dropped and every call site reverted to current_crew_member_id() alone.
-- ============================================================================

-- Reads the self-asserted crew_member id from the request header, if any.
-- No existence check against crew_members here — invalid ids are caught by
-- the ordinary FK constraints on entered_by/changed_by/etc. at insert/update
-- time, same as any other bad client input.
create or replace function public.claimed_crew_member_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(
    (current_setting('request.headers', true)::json ->> 'x-claimed-crew-member-id'),
    ''
  )::uuid;
$$;

-- The identity every attribution default/trigger and role-gating check
-- should use from now on: real auth wins if a session exists, otherwise
-- fall back to the claimed (unverified) id.
create or replace function public.effective_crew_member_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select coalesce(public.current_crew_member_id(), public.claimed_crew_member_id());
$$;

-- ============================================================================
-- Attribution triggers: force-overwrite with the EFFECTIVE identity instead
-- of the auth-only one. Behavior is unchanged when a real session exists.
-- ============================================================================

create or replace function public.set_entered_by_from_auth()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.entered_by := public.effective_crew_member_id();
  return new;
end;
$$;

create or replace function public.set_changed_by_from_auth()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.changed_by := public.effective_crew_member_id();
  return new;
end;
$$;

create or replace function public.set_created_by_from_auth()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_by := public.effective_crew_member_id();
  return new;
end;
$$;

create or replace function public.set_captured_by_from_auth()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.captured_by := public.effective_crew_member_id();
  return new;
end;
$$;

alter table width_readings alter column entered_by set default public.effective_crew_member_id();
alter table truck_tickets alter column entered_by set default public.effective_crew_member_id();
alter table attribution_history alter column changed_by set default public.effective_crew_member_id();
alter table superintendent_notes alter column created_by set default public.effective_crew_member_id();
alter table photo_attachments alter column captured_by set default public.effective_crew_member_id();

-- ============================================================================
-- Role-gating triggers: check the role of the EFFECTIVE identity instead of
-- rejecting outright when auth.uid() is null. This restores the
-- trust-the-client model as an explicit, temporary fallback — the checks
-- themselves are not removed, only their identity source is widened.
-- ============================================================================

create or replace function enforce_width_readings_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_coordinator boolean;
begin
  if new.road_segment_id is distinct from old.road_segment_id
     or new.paving_date is distinct from old.paving_date
     or new.direction is distinct from old.direction
     or new.station_sequence is distinct from old.station_sequence
     or new.station is distinct from old.station
     or new.width is distinct from old.width
     or new.entry_timestamp is distinct from old.entry_timestamp
     or new.entered_by is distinct from old.entered_by
     or new.is_correction is distinct from old.is_correction
  then
    raise exception 'width_readings rows are append-only; only superseded_by and correction_reason may be updated';
  end if;

  if new.superseded_by is distinct from old.superseded_by then
    select exists (
      select 1 from crew_members
      where id = public.effective_crew_member_id() and role = 'coordinator'
    ) into acting_is_coordinator;

    if not (old.entered_by = public.effective_crew_member_id() or acting_is_coordinator) then
      raise exception 'only the original entered_by crew member or a coordinator may set superseded_by';
    end if;
  end if;

  return new;
end;
$$;

create or replace function enforce_truck_tickets_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_coordinator boolean;
begin
  if new.road_segment_id is distinct from old.road_segment_id
     or new.paving_date is distinct from old.paving_date
     or new.direction is distinct from old.direction
     or new.vehicle_number is distinct from old.vehicle_number
     or new.ticket_number is distinct from old.ticket_number
     or new.net_tonnage is distinct from old.net_tonnage
     or new.logged_timestamp is distinct from old.logged_timestamp
     or new.entered_by is distinct from old.entered_by
  then
    raise exception 'truck_tickets rows are append-only; only lift_type, arrival_sequence, is_voided, superseded_by, and correction_reason may be updated';
  end if;

  if new.is_voided is distinct from old.is_voided
     or new.superseded_by is distinct from old.superseded_by
  then
    select exists (
      select 1 from crew_members
      where id = public.effective_crew_member_id() and role = 'coordinator'
    ) into acting_is_coordinator;

    if not (old.entered_by = public.effective_crew_member_id() or acting_is_coordinator) then
      raise exception 'only the original entered_by crew member or a coordinator may void or supersede a truck ticket';
    end if;
  end if;

  return new;
end;
$$;

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
    where id = public.effective_crew_member_id() and role = 'coordinator'
  ) into acting_is_coordinator;

  if (new.role is distinct from old.role or new.active is distinct from old.active)
     and not acting_is_coordinator
  then
    raise exception 'only a coordinator may change role or active';
  end if;

  if new.name is distinct from old.name
     and not (old.id = public.effective_crew_member_id() or acting_is_coordinator)
  then
    raise exception 'name may only be changed by the account owner or a coordinator';
  end if;

  return new;
end;
$$;

create or replace function enforce_reconstruction_runs_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.road_segment_id is distinct from old.road_segment_id
     or new.paving_date is distinct from old.paving_date
     or new.direction is distinct from old.direction
     or new.run_number is distinct from old.run_number
     or new.input_snapshot is distinct from old.input_snapshot
     or new.blended_rate_pct is distinct from old.blended_rate_pct
     or new.total_area is distinct from old.total_area
     or new.total_tonnage is distinct from old.total_tonnage
     or new.generated_at is distinct from old.generated_at
  then
    raise exception 'reconstruction_runs rows are versioned/immutable; only status may be updated';
  end if;

  if new.status is distinct from old.status then
    if not (old.status = 'draft' and new.status = 'accepted') then
      raise exception 'reconstruction_runs.status may only transition draft -> accepted';
    end if;

    if not exists (
      select 1 from crew_members
      where id = public.effective_crew_member_id() and role = 'coordinator'
    ) then
      raise exception 'only a coordinator may accept a reconstruction_run';
    end if;
  end if;

  return new;
end;
$$;
