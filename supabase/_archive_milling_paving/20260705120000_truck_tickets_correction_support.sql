-- Add correction support to truck_tickets, same append-only +
-- correction-via-supersede pattern as width_readings.
--
-- Stricter than width_readings, worth flagging: width_readings' existing
-- check only requires correction_reason when is_correction=true, not when
-- superseded_by alone is set. This one covers both conditions, per the
-- explicit ask. Not going back to tighten width_readings to match — out of
-- scope for this migration, just noting the inconsistency exists.

alter table truck_tickets add column is_voided boolean not null default false;
alter table truck_tickets add column superseded_by uuid references truck_tickets (id);
alter table truck_tickets add column correction_reason text;

alter table truck_tickets add constraint truck_tickets_correction_reason_required
  check (not (is_voided or superseded_by is not null) or correction_reason is not null);

create index idx_truck_tickets_superseded_by on truck_tickets (superseded_by);

-- is_voided, superseded_by, and correction_reason join lift_type/
-- arrival_sequence as the only columns a correction workflow may touch.
-- net_tonnage is still never changed in place — a tonnage correction voids
-- the original and inserts a new row, linked via superseded_by.
create or replace function enforce_truck_tickets_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
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
  return new;
end;
$$;

-- attribution_history can now also track voiding/superseding a ticket, same
-- audit trail as lift_type/arrival_sequence reassignment.
alter table attribution_history drop constraint attribution_history_field_changed_check;
alter table attribution_history add constraint attribution_history_field_changed_check
  check (field_changed = any (array['lift_type', 'arrival_sequence', 'voided', 'superseded']));
