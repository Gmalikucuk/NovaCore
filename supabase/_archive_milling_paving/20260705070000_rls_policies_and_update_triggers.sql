-- RLS policies + column-restricted UPDATE triggers.
--
-- FLAGGED TRADEOFF (confirmed acceptable by user, 2026-07-05): all field users
-- share one anon key with no per-user Supabase Auth session, so there is no
-- JWT identifying "who" at the database level. RLS here can only restrict by
-- table/operation, never by crew member — that authorization only exists at
-- the application layer via the entered_by/changed_by/created_by/confirmed_by
-- columns being set correctly by the client.
--
-- Policies target both `anon` and `authenticated` roles. Only `anon` is
-- actually used today (no real login flow exists), but this avoids needing a
-- second RLS migration if real Supabase Auth is added later.

-- ============================================================
-- Group 1: pure append-only — INSERT + SELECT only.
-- No UPDATE, no DELETE — revoked at the privilege level too, so it's
-- structurally impossible rather than just unpolicied.
-- ============================================================
alter table attribution_history enable row level security;
alter table surface_lifecycle_events enable row level security;
alter table reconstruction_output_rows enable row level security;
alter table superintendent_notes enable row level security;
alter table photo_attachments enable row level security;

create policy attribution_history_select on attribution_history for select to anon, authenticated using (true);
create policy attribution_history_insert on attribution_history for insert to anon, authenticated with check (true);

create policy surface_lifecycle_events_select on surface_lifecycle_events for select to anon, authenticated using (true);
create policy surface_lifecycle_events_insert on surface_lifecycle_events for insert to anon, authenticated with check (true);

create policy reconstruction_output_rows_select on reconstruction_output_rows for select to anon, authenticated using (true);
create policy reconstruction_output_rows_insert on reconstruction_output_rows for insert to anon, authenticated with check (true);

create policy superintendent_notes_select on superintendent_notes for select to anon, authenticated using (true);
create policy superintendent_notes_insert on superintendent_notes for insert to anon, authenticated with check (true);

create policy photo_attachments_select on photo_attachments for select to anon, authenticated using (true);
create policy photo_attachments_insert on photo_attachments for insert to anon, authenticated with check (true);

grant select, insert on
  attribution_history,
  surface_lifecycle_events,
  reconstruction_output_rows,
  superintendent_notes,
  photo_attachments
to anon, authenticated;

revoke update, delete on
  attribution_history,
  surface_lifecycle_events,
  reconstruction_output_rows,
  superintendent_notes,
  photo_attachments
from anon, authenticated;

-- ============================================================
-- Group 2: append-only + column-restricted UPDATE via trigger.
-- INSERT + SELECT + UPDATE (RLS allows the attempt; the trigger enforces
-- which columns may actually change). No DELETE.
-- ============================================================
alter table width_readings enable row level security;
alter table truck_tickets enable row level security;
alter table reconstruction_runs enable row level security;
alter table joint_sealant_closeout enable row level security;

create policy width_readings_select on width_readings for select to anon, authenticated using (true);
create policy width_readings_insert on width_readings for insert to anon, authenticated with check (true);
create policy width_readings_update on width_readings for update to anon, authenticated using (true) with check (true);

create policy truck_tickets_select on truck_tickets for select to anon, authenticated using (true);
create policy truck_tickets_insert on truck_tickets for insert to anon, authenticated with check (true);
create policy truck_tickets_update on truck_tickets for update to anon, authenticated using (true) with check (true);

create policy reconstruction_runs_select on reconstruction_runs for select to anon, authenticated using (true);
create policy reconstruction_runs_insert on reconstruction_runs for insert to anon, authenticated with check (true);
create policy reconstruction_runs_update on reconstruction_runs for update to anon, authenticated using (true) with check (true);

-- joint_sealant_closeout wasn't named in either the "insert+select, no delete"
-- list or the "broad access" list — inferred to belong here since it was
-- given the same "restricted UPDATE via trigger" treatment as
-- reconstruction_runs. Flagging this inference explicitly.
create policy joint_sealant_closeout_select on joint_sealant_closeout for select to anon, authenticated using (true);
create policy joint_sealant_closeout_insert on joint_sealant_closeout for insert to anon, authenticated with check (true);
create policy joint_sealant_closeout_update on joint_sealant_closeout for update to anon, authenticated using (true) with check (true);

grant select, insert, update on
  width_readings,
  truck_tickets,
  reconstruction_runs,
  joint_sealant_closeout
to anon, authenticated;

revoke delete on
  width_readings,
  truck_tickets,
  reconstruction_runs,
  joint_sealant_closeout
from anon, authenticated;

-- ============================================================
-- Group 3: broad access — SELECT + INSERT + UPDATE, no per-role
-- restriction possible at the DB level given the auth model (accepted gap).
-- DELETE wasn't requested for this group either, so it's revoked here too,
-- for consistency with the rest of the schema's append/correct-don't-delete
-- design. Flagging this inference — easy to add back with a follow-up
-- migration if you want deletes allowed here for setup-mistake corrections.
-- ============================================================
alter table projects enable row level security;
alter table project_config enable row level security;
alter table jobs enable row level security;
alter table road_segments enable row level security;
alter table event_deadline_rules enable row level security;
alter table crew_members enable row level security;

create policy projects_select on projects for select to anon, authenticated using (true);
create policy projects_insert on projects for insert to anon, authenticated with check (true);
create policy projects_update on projects for update to anon, authenticated using (true) with check (true);

create policy project_config_select on project_config for select to anon, authenticated using (true);
create policy project_config_insert on project_config for insert to anon, authenticated with check (true);
create policy project_config_update on project_config for update to anon, authenticated using (true) with check (true);

create policy jobs_select on jobs for select to anon, authenticated using (true);
create policy jobs_insert on jobs for insert to anon, authenticated with check (true);
create policy jobs_update on jobs for update to anon, authenticated using (true) with check (true);

create policy road_segments_select on road_segments for select to anon, authenticated using (true);
create policy road_segments_insert on road_segments for insert to anon, authenticated with check (true);
create policy road_segments_update on road_segments for update to anon, authenticated using (true) with check (true);

create policy event_deadline_rules_select on event_deadline_rules for select to anon, authenticated using (true);
create policy event_deadline_rules_insert on event_deadline_rules for insert to anon, authenticated with check (true);
create policy event_deadline_rules_update on event_deadline_rules for update to anon, authenticated using (true) with check (true);

create policy crew_members_select on crew_members for select to anon, authenticated using (true);
create policy crew_members_insert on crew_members for insert to anon, authenticated with check (true);
create policy crew_members_update on crew_members for update to anon, authenticated using (true) with check (true);

grant select, insert, update on
  projects,
  project_config,
  jobs,
  road_segments,
  event_deadline_rules,
  crew_members
to anon, authenticated;

revoke delete on
  projects,
  project_config,
  jobs,
  road_segments,
  event_deadline_rules,
  crew_members
from anon, authenticated;

-- ============================================================
-- Column-restricted UPDATE triggers
-- ============================================================

create or replace function enforce_width_readings_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
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
  return new;
end;
$$;

create trigger width_readings_restrict_update
before update on width_readings
for each row execute function enforce_width_readings_update_columns();

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
    raise exception 'truck_tickets rows are append-only; only lift_type and arrival_sequence may be updated';
  end if;
  return new;
end;
$$;

create trigger truck_tickets_restrict_update
before update on truck_tickets
for each row execute function enforce_truck_tickets_update_columns();

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

  if new.status is distinct from old.status
     and not (old.status = 'draft' and new.status = 'accepted')
  then
    raise exception 'reconstruction_runs.status may only transition draft -> accepted';
  end if;

  return new;
end;
$$;

create trigger reconstruction_runs_restrict_update
before update on reconstruction_runs
for each row execute function enforce_reconstruction_runs_update_columns();

create or replace function enforce_joint_sealant_closeout_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.project_id is distinct from old.project_id
     or new.total_length is distinct from old.total_length
     or new.suggested_quantity is distinct from old.suggested_quantity
     or new.moti_deviation_note is distinct from old.moti_deviation_note
  then
    raise exception 'joint_sealant_closeout rows only allow actual_quantity, closeout_date, and confirmed_by to be updated';
  end if;
  return new;
end;
$$;

create trigger joint_sealant_closeout_restrict_update
before update on joint_sealant_closeout
for each row execute function enforce_joint_sealant_closeout_update_columns();
