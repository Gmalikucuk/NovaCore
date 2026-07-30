-- Section 6 (Supporting Tables): crew_members only.
--
-- Pulled forward ahead of sections 1-5 because width_readings, truck_tickets,
-- attribution_history, superintendent_notes, joint_sealant_closeout, and
-- photo_attachments all reference crew_members via entered_by / changed_by /
-- created_by / confirmed_by / captured_by, and Postgres requires the referenced
-- table to exist before a foreign key can be created. The rest of section 6
-- (photo_attachments) is in its own later migration.

create extension if not exists pgcrypto;

create table crew_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('superintendent', 'coordinator', 'field_staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_crew_members_active on crew_members (active);
create index idx_crew_members_role on crew_members (role);
