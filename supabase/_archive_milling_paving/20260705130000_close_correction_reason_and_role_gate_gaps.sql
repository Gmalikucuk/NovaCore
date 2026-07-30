-- Fix 1: width_readings' correction_reason check was only enforced for
-- is_correction=true, letting someone set superseded_by directly with no
-- reason at all — closing that bypass, same rule truck_tickets already has.
alter table width_readings drop constraint width_readings_correction_reason_required;
alter table width_readings add constraint width_readings_correction_reason_required
  check (not (is_correction or superseded_by is not null) or correction_reason is not null);

-- Necessary consequence of the fix above, not separately requested: the
-- existing trigger blocked correction_reason from ever changing via UPDATE,
-- which would make the tightened check constraint impossible to satisfy —
-- superseding an existing row would require setting superseded_by and
-- correction_reason together in the same UPDATE, but the trigger forbade the
-- latter. Allowing correction_reason to change (alongside superseded_by)
-- closes that gap. is_correction stays immutable after insert, unchanged.
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
      where auth_user_id = auth.uid() and role = 'coordinator'
    ) into acting_is_coordinator;

    if not (old.entered_by = public.current_crew_member_id() or acting_is_coordinator) then
      raise exception 'only the original entered_by crew member or a coordinator may set superseded_by';
    end if;
  end if;

  return new;
end;
$$;

-- Fix 2: same role gate on truck_tickets — only the crew member who
-- originally logged the ticket, or a coordinator, may void or supersede it.
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
      where auth_user_id = auth.uid() and role = 'coordinator'
    ) into acting_is_coordinator;

    if not (old.entered_by = public.current_crew_member_id() or acting_is_coordinator) then
      raise exception 'only the original entered_by crew member or a coordinator may void or supersede a truck ticket';
    end if;
  end if;

  return new;
end;
$$;
