-- Part 1: make ON DELETE explicit RESTRICT on every FK pointing into the
-- reference tables (road_segments, jobs, projects, crew_members), then
-- re-enable DELETE on those reference tables now that it's safe to do so.
--
-- AUDIT RESULT (checked live via pg_constraint before writing this): all 16
-- FKs below were already `NO ACTION` — none were CASCADE, so nothing was at
-- risk of silently cascade-deleting field data. Making them explicit RESTRICT
-- doesn't change behavior (NO ACTION and RESTRICT are equivalent here since
-- none of these constraints are DEFERRABLE), it just removes the ambiguity of
-- an unstated default for anyone reading the schema later.
--
-- Two FKs beyond the ones you listed fit the same "points into a table we're
-- re-enabling DELETE on" pattern, so they're included here too:
--   event_deadline_rules.project_id -> projects
--   joint_sealant_closeout.project_id -> projects

-- -> crew_members
alter table attribution_history drop constraint attribution_history_changed_by_fkey;
alter table attribution_history add constraint attribution_history_changed_by_fkey
  foreign key (changed_by) references crew_members (id) on delete restrict;

alter table joint_sealant_closeout drop constraint joint_sealant_closeout_confirmed_by_fkey;
alter table joint_sealant_closeout add constraint joint_sealant_closeout_confirmed_by_fkey
  foreign key (confirmed_by) references crew_members (id) on delete restrict;

alter table photo_attachments drop constraint photo_attachments_captured_by_fkey;
alter table photo_attachments add constraint photo_attachments_captured_by_fkey
  foreign key (captured_by) references crew_members (id) on delete restrict;

alter table superintendent_notes drop constraint superintendent_notes_created_by_fkey;
alter table superintendent_notes add constraint superintendent_notes_created_by_fkey
  foreign key (created_by) references crew_members (id) on delete restrict;

alter table truck_tickets drop constraint truck_tickets_entered_by_fkey;
alter table truck_tickets add constraint truck_tickets_entered_by_fkey
  foreign key (entered_by) references crew_members (id) on delete restrict;

alter table width_readings drop constraint width_readings_entered_by_fkey;
alter table width_readings add constraint width_readings_entered_by_fkey
  foreign key (entered_by) references crew_members (id) on delete restrict;

-- -> jobs
alter table road_segments drop constraint road_segments_job_id_fkey;
alter table road_segments add constraint road_segments_job_id_fkey
  foreign key (job_id) references jobs (id) on delete restrict;

-- -> projects
alter table event_deadline_rules drop constraint event_deadline_rules_project_id_fkey;
alter table event_deadline_rules add constraint event_deadline_rules_project_id_fkey
  foreign key (project_id) references projects (id) on delete restrict;

alter table jobs drop constraint jobs_project_id_fkey;
alter table jobs add constraint jobs_project_id_fkey
  foreign key (project_id) references projects (id) on delete restrict;

alter table joint_sealant_closeout drop constraint joint_sealant_closeout_project_id_fkey;
alter table joint_sealant_closeout add constraint joint_sealant_closeout_project_id_fkey
  foreign key (project_id) references projects (id) on delete restrict;

alter table project_config drop constraint project_config_project_id_fkey;
alter table project_config add constraint project_config_project_id_fkey
  foreign key (project_id) references projects (id) on delete restrict;

-- -> road_segments
alter table reconstruction_runs drop constraint reconstruction_runs_road_segment_id_fkey;
alter table reconstruction_runs add constraint reconstruction_runs_road_segment_id_fkey
  foreign key (road_segment_id) references road_segments (id) on delete restrict;

alter table superintendent_notes drop constraint superintendent_notes_road_segment_id_fkey;
alter table superintendent_notes add constraint superintendent_notes_road_segment_id_fkey
  foreign key (road_segment_id) references road_segments (id) on delete restrict;

alter table surface_lifecycle_events drop constraint surface_lifecycle_events_road_segment_id_fkey;
alter table surface_lifecycle_events add constraint surface_lifecycle_events_road_segment_id_fkey
  foreign key (road_segment_id) references road_segments (id) on delete restrict;

alter table truck_tickets drop constraint truck_tickets_road_segment_id_fkey;
alter table truck_tickets add constraint truck_tickets_road_segment_id_fkey
  foreign key (road_segment_id) references road_segments (id) on delete restrict;

alter table width_readings drop constraint width_readings_road_segment_id_fkey;
alter table width_readings add constraint width_readings_road_segment_id_fkey
  foreign key (road_segment_id) references road_segments (id) on delete restrict;

-- Re-enable DELETE on the reference tables now that every inbound FK is
-- confirmed RESTRICT. Everything else (width_readings, truck_tickets,
-- attribution_history, surface_lifecycle_events, reconstruction_runs,
-- reconstruction_output_rows, superintendent_notes, photo_attachments,
-- joint_sealant_closeout) is untouched and stays DELETE-blocked.
create policy projects_delete on projects for delete to anon, authenticated using (true);
create policy jobs_delete on jobs for delete to anon, authenticated using (true);
create policy road_segments_delete on road_segments for delete to anon, authenticated using (true);
create policy event_deadline_rules_delete on event_deadline_rules for delete to anon, authenticated using (true);
create policy crew_members_delete on crew_members for delete to anon, authenticated using (true);

grant delete on projects, jobs, road_segments, event_deadline_rules, crew_members to anon, authenticated;
