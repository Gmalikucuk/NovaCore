-- Review/classification workflow for lifecycle events entered outside the
-- normal station-reading walk (intersection tie-ins, driveways, other extra
-- areas within contract scope but not part of the main continuous segment).

alter table surface_lifecycle_events add column entry_method text not null default 'computed_from_readings'
  check (entry_method in ('computed_from_readings', 'manual_area_entry'));
alter table surface_lifecycle_events add column location_description text;
alter table surface_lifecycle_events add column field_narrative text;
alter table surface_lifecycle_events add column review_status text not null default 'confirmed'
  check (review_status in ('pending_review', 'confirmed'));
alter table surface_lifecycle_events add column reviewed_by uuid references crew_members (id);
alter table surface_lifecycle_events add column reviewed_at timestamptz;

alter table surface_lifecycle_events add constraint surface_lifecycle_events_review_consistency
  check ((reviewed_by is null) = (reviewed_at is null));

-- 'milled_tie_in' is new — the default event_type for the "+ Add extra area"
-- form (not built yet, next phase). Everything else is unchanged.
alter table surface_lifecycle_events drop constraint surface_lifecycle_events_event_type_check;
alter table surface_lifecycle_events add constraint surface_lifecycle_events_event_type_check
  check (event_type in ('mill', 'tack_coat', 'level_course', 'top_lift', 'shoulder_strip', 'shouldering', 'milled_tie_in'));

create index idx_surface_lifecycle_events_review_status on surface_lifecycle_events (review_status);

-- entry_method decides the starting review_status, and does so unconditionally
-- on every insert — a column DEFAULT can't reference a sibling column, and
-- more importantly, a client-supplied review_status must not be trusted here:
-- without this, a field_staff row could just insert
-- entry_method='manual_area_entry' + review_status='confirmed' together and
-- skip the review gate entirely. reviewed_by/reviewed_at are forced to null
-- on insert too — a fresh row has never been reviewed by a person, even a
-- computed_from_readings one that starts out auto-confirmed.
create or replace function public.set_lifecycle_event_review_status_on_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.review_status := case
    when new.entry_method = 'manual_area_entry' then 'pending_review'
    else 'confirmed'
  end;
  new.reviewed_by := null;
  new.reviewed_at := null;
  return new;
end;
$$;

create trigger surface_lifecycle_events_set_review_status
before insert on surface_lifecycle_events
for each row execute function public.set_lifecycle_event_review_status_on_insert();

-- This table was pure append-only (no UPDATE policy existed at all) until
-- now — the review workflow needs a real UPDATE path, so both the RLS
-- policy and a column-restriction + role-gating trigger are new here, not
-- just an extension of an existing one.
create policy surface_lifecycle_events_update on surface_lifecycle_events
  for update to anon, authenticated using (true) with check (true);
grant update on surface_lifecycle_events to anon, authenticated;

-- Only event_type/quantity/station/review_status may ever change post-insert,
-- and only a coordinator may change any of them — the review is meant to be
-- a PM (coordinator) action end to end, adjustment and confirmation together,
-- not something a field_staff row can touch after creating the entry.
-- reviewed_by/reviewed_at are server-derived on confirmation, same as every
-- other attribution column in this schema — never client-supplied.
create or replace function enforce_surface_lifecycle_events_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_coordinator boolean;
begin
  if new.road_segment_id is distinct from old.road_segment_id
     or new.entry_method is distinct from old.entry_method
     or new.linked_mill_event_id is distinct from old.linked_mill_event_id
     or new.event_date is distinct from old.event_date
     or new.location_description is distinct from old.location_description
     or new.field_narrative is distinct from old.field_narrative
     or new.created_at is distinct from old.created_at
  then
    raise exception 'surface_lifecycle_events rows are append-only; only event_type, quantity, station, and review_status may be updated, by a coordinator';
  end if;

  if new.event_type is distinct from old.event_type
     or new.quantity is distinct from old.quantity
     or new.from_station is distinct from old.from_station
     or new.to_station is distinct from old.to_station
     or new.review_status is distinct from old.review_status
  then
    select exists (
      select 1 from crew_members
      where id = public.effective_crew_member_id() and role = 'coordinator'
    ) into acting_is_coordinator;

    if not acting_is_coordinator then
      raise exception 'only a coordinator may adjust or confirm a lifecycle event under review';
    end if;
  end if;

  if new.review_status is distinct from old.review_status then
    if not (old.review_status = 'pending_review' and new.review_status = 'confirmed') then
      raise exception 'review_status may only transition pending_review -> confirmed';
    end if;

    new.reviewed_by := public.effective_crew_member_id();
    new.reviewed_at := now();
  end if;

  return new;
end;
$$;

create trigger surface_lifecycle_events_restrict_update
before update on surface_lifecycle_events
for each row execute function enforce_surface_lifecycle_events_update_columns();
