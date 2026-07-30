-- Supersede path for surface_lifecycle_events, mirroring the pattern on
-- width_readings and truck_tickets. Confirmed rows are frozen for direct
-- edits (built last migration) — this is how a coordinator corrects one
-- after the fact: insert a new row with the right values, then point the
-- frozen original at it via superseded_by, exactly like every other
-- corrected record in this schema. Never mutates the frozen row itself.

alter table surface_lifecycle_events add column superseded_by uuid references surface_lifecycle_events (id);
alter table surface_lifecycle_events add column correction_reason text;

create index idx_surface_lifecycle_events_superseded_by on surface_lifecycle_events (superseded_by);

-- Simpler than the equivalent width_readings constraint — there's no
-- is_correction flag on this table, so the only condition that can ever
-- require a reason is superseded_by itself being set. Written correctly
-- from the start: no is_correction-shaped hole to leave open the way the
-- original width_readings constraint did before it was fixed.
alter table surface_lifecycle_events add constraint surface_lifecycle_events_correction_reason_required
  check (superseded_by is null or correction_reason is not null);

-- Adds a superseded_by/correction_reason branch, coordinator-only (not
-- "original enterer or coordinator" like width_readings/truck_tickets —
-- superseding a CONFIRMED entry is a more consequential action than
-- editing a still-pending draft, reserved for coordinators specifically,
-- per the request). This is independent of the "already confirmed" check
-- added last migration: that check only fires for
-- event_type/quantity/station/location_description changes, so it's
-- impossible to sneak a direct field edit into the same statement as a
-- supersede — old.review_status = 'confirmed' still unconditionally blocks
-- those columns even if superseded_by changes in the same UPDATE. The only
-- way to correct a confirmed row is a real new row plus this pointer.
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
    raise exception 'surface_lifecycle_events rows are append-only; only event_type, quantity, station, location_description, review_status, superseded_by, and correction_reason may be updated';
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
      raise exception 'this event has already been confirmed and can no longer be edited directly - use superseded_by to correct it instead';
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

  if new.superseded_by is distinct from old.superseded_by
     or new.correction_reason is distinct from old.correction_reason
  then
    if not acting_is_coordinator then
      raise exception 'only a coordinator may supersede a lifecycle event';
    end if;
  end if;

  return new;
end;
$$;
