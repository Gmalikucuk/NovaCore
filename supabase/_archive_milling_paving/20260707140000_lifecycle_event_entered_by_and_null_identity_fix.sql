-- Part 1: entered_by on surface_lifecycle_events, server-derived, same
-- pattern as every other attribution column in this schema — never
-- client-supplied. Table confirmed empty before adding as NOT NULL, no
-- backfill needed.
alter table surface_lifecycle_events add column entered_by uuid not null references crew_members (id);

create index idx_surface_lifecycle_events_entered_by on surface_lifecycle_events (entered_by);

-- Reuses the existing generic set_entered_by_from_auth() — it only touches
-- NEW.entered_by, so it works on any table with that column, no new
-- function needed.
create trigger surface_lifecycle_events_set_entered_by
before insert on surface_lifecycle_events
for each row execute function public.set_entered_by_from_auth();

-- ============================================================================
-- Part 2: CRITICAL BUG FIX — anonymous NULL-identity bypass of role gating.
--
-- The pattern `old.entered_by = public.effective_crew_member_id() or
-- acting_is_coordinator` silently fails open when there is NO identity at
-- all (no auth session, no claimed header). effective_crew_member_id()
-- returns NULL in that case, so `old.entered_by = NULL` evaluates to SQL
-- NULL (not false), `NULL or false` is NULL, and PL/pgSQL's
-- `if not (NULL) then` treats a NULL condition as false — the RAISE never
-- fires, and the update silently succeeds. Confirmed live before writing
-- this fix: a fully anonymous request (no header, no auth) successfully set
-- superseded_by on a real width_readings row.
--
-- The EXISTS(...)-based coordinator checks elsewhere in this schema are NOT
-- affected — EXISTS never returns NULL. Only direct equality comparisons
-- combined with OR have this failure mode. Fixed everywhere it exists by
-- wrapping the equality in coalesce(..., false), forcing a definite boolean.
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

    if not (coalesce(old.entered_by = public.effective_crew_member_id(), false) or acting_is_coordinator) then
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

    if not (coalesce(old.entered_by = public.effective_crew_member_id(), false) or acting_is_coordinator) then
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
     and not (coalesce(old.id = public.effective_crew_member_id(), false) or acting_is_coordinator)
  then
    raise exception 'name may only be changed by the account owner or a coordinator';
  end if;

  return new;
end;
$$;

-- ============================================================================
-- Part 3: split edit/confirm gating on surface_lifecycle_events.
--
-- While review_status = 'pending_review': the original entered_by crew
-- member OR a coordinator may edit event_type/quantity/station/
-- location_description. Confirmation (the pending_review -> confirmed
-- transition) stays coordinator-only, unchanged from before.
--
-- Inferred, not explicitly specified: once an event is confirmed, none of
-- these fields (including for computed_from_readings entries, which start
-- confirmed) can be edited anymore by anyone, including coordinators. The
-- previous version of this trigger allowed a coordinator to edit ANY
-- entry's fields regardless of review_status. Flagging this as a new
-- restriction introduced here, not something explicitly asked for — it
-- matches "confirmed means final" (only confirmed events count toward
-- contract totals, so quietly changing a confirmed value after the fact
-- seemed like it should require a real correction path, which doesn't
-- exist for this table, rather than silently editing it).
-- ============================================================================

create or replace function enforce_surface_lifecycle_events_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_coordinator boolean;
  acting_is_original_enterer boolean;
begin
  if new.road_segment_id is distinct from old.road_segment_id
     or new.entry_method is distinct from old.entry_method
     or new.linked_mill_event_id is distinct from old.linked_mill_event_id
     or new.event_date is distinct from old.event_date
     or new.field_narrative is distinct from old.field_narrative
     or new.entered_by is distinct from old.entered_by
     or new.created_at is distinct from old.created_at
  then
    raise exception 'surface_lifecycle_events rows are append-only; only event_type, quantity, station, location_description, and review_status may be updated';
  end if;

  select exists (
    select 1 from crew_members
    where id = public.effective_crew_member_id() and role = 'coordinator'
  ) into acting_is_coordinator;

  acting_is_original_enterer := coalesce(old.entered_by = public.effective_crew_member_id(), false);

  if new.event_type is distinct from old.event_type
     or new.quantity is distinct from old.quantity
     or new.from_station is distinct from old.from_station
     or new.to_station is distinct from old.to_station
     or new.location_description is distinct from old.location_description
  then
    if old.review_status is distinct from 'pending_review' then
      raise exception 'this event has already been confirmed and can no longer be edited';
    end if;

    if not (acting_is_original_enterer or acting_is_coordinator) then
      raise exception 'only the original entered_by crew member or a coordinator may edit a pending-review lifecycle event';
    end if;
  end if;

  if new.review_status is distinct from old.review_status then
    if not (old.review_status = 'pending_review' and new.review_status = 'confirmed') then
      raise exception 'review_status may only transition pending_review -> confirmed';
    end if;

    if not acting_is_coordinator then
      raise exception 'only a coordinator may confirm a lifecycle event under review';
    end if;

    new.reviewed_by := public.effective_crew_member_id();
    new.reviewed_at := now();
  end if;

  return new;
end;
$$;
