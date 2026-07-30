-- Part 2, step 7: role-gate two specific transitions, by extending the
-- existing column-restriction trigger functions (CREATE OR REPLACE — the
-- triggers themselves stay attached, only the function body changes).
--
-- Every other RLS policy and trigger from the earlier migrations is
-- untouched, including "no DELETE, ever" on width_readings, truck_tickets,
-- attribution_history, surface_lifecycle_events, reconstruction_runs,
-- reconstruction_output_rows, superintendent_notes, photo_attachments, and
-- joint_sealant_closeout — Part 1 only re-enabled DELETE on projects, jobs,
-- road_segments, event_deadline_rules, and crew_members, and none of that is
-- touched here either.

-- reconstruction_runs: draft -> accepted now also requires the current user
-- to be a coordinator, on top of the existing column + direction checks.
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
      where auth_user_id = auth.uid() and role = 'coordinator'
    ) then
      raise exception 'only a coordinator may accept a reconstruction_run';
    end if;
  end if;

  return new;
end;
$$;

-- width_readings: superseded_by may only be set by the crew member who
-- entered the original row, or by a coordinator.
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
     or new.correction_reason is distinct from old.correction_reason
  then
    raise exception 'width_readings rows are append-only; only superseded_by may be updated';
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
