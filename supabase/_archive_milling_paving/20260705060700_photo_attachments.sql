-- Section 6 (Supporting Tables), continued: photo_attachments.
-- (crew_members, the other table in this section, was created earlier as
-- 20260705060100_crew_members.sql — see that file for why it was pulled forward.)

create table photo_attachments (
  id uuid primary key default gen_random_uuid(),
  linked_entry_type text not null check (linked_entry_type in
    ('width_reading', 'truck_ticket', 'superintendent_note')),
  -- Polymorphic reference — no DB-level FK possible across three different
  -- tables. Application code MUST validate this id exists in the table named
  -- by linked_entry_type before insert.
  linked_entry_id uuid not null,

  captured_by uuid not null references crew_members (id),
  captured_at timestamptz not null default now(),

  local_status text not null default 'queued' check (local_status in ('queued', 'synced')),
  storage_path text,
  google_drive_file_id text
);

create index idx_photo_attachments_linked_entry on photo_attachments (linked_entry_type, linked_entry_id);
create index idx_photo_attachments_captured_by on photo_attachments (captured_by);
create index idx_photo_attachments_local_status on photo_attachments (local_status);

comment on column photo_attachments.linked_entry_id is
  'Polymorphic reference (no FK constraint possible). Application code must validate this id exists in the table named by linked_entry_type before insert.';
