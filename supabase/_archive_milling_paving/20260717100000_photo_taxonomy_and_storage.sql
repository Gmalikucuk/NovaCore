-- Extends photo_attachments with first-class project_id/work_date/
-- photo_category, plus proof-of-work-specific tagging fields, and creates
-- the Supabase Storage bucket photos land in. Ticket-scan capture (Paving)
-- stays deferred — this pass only wires up daily_activity/proof_of_work
-- from Milling — but 'ticket_scan' is a valid photo_category value now so
-- Paving doesn't need another schema migration to add it later.

-- linked_entry_type/linked_entry_id were not null — a photo could only ever
-- exist tied to one of width_reading/truck_ticket/superintendent_note. Most
-- daily_activity and proof_of_work photos are free-standing (not tied to any
-- specific existing row), so both become nullable. The existing check
-- constraint on linked_entry_type is unaffected: `null in (...)` evaluates
-- to null, not false, so a CHECK constraint still passes on null.
alter table photo_attachments
  alter column linked_entry_type drop not null,
  alter column linked_entry_id drop not null;

alter table photo_attachments
  add column project_id uuid not null references projects (id) on delete restrict,
  add column work_date date not null,
  add column photo_category text not null
    check (photo_category in ('daily_activity', 'ticket_scan', 'proof_of_work')),
  -- Proof-of-work-only in practice, left nullable for every category rather
  -- than cross-column-constrained — not worth a trigger to enforce a
  -- category/field pairing that's really an application-layer convention.
  -- line_item_tag deliberately has no check constraint: the dropdown list
  -- backing it is an explicitly placeholder list the client owns, not a
  -- stable taxonomy worth a migration every time it changes.
  add column line_item_tag text,
  add column station numeric(12,3),
  add column direction text check (direction is null or direction in ('NB', 'SB', 'EB', 'WB')),
  -- Shared, not proof-of-work-only: doubles as daily_activity's optional
  -- caption and proof_of_work's "anything the dropdown doesn't cover".
  add column free_text text;

create index idx_photo_attachments_project_work_date on photo_attachments (project_id, work_date);
create index idx_photo_attachments_photo_category on photo_attachments (photo_category);

comment on column photo_attachments.work_date is
  'The entry''s declared work date — same concept as width_readings.paving_date, distinct from captured_at (the true capture moment). A photo taken today documenting a backdated entry carries that entry''s work_date, not today''s.';

-- Storage bucket photos land in, mirroring the anon/authenticated,
-- insert+select-only, no-update/delete posture the rest of this schema uses
-- for field-submitted data (see 20260705070000's Group 1). Private bucket —
-- no public URL-sharing feature exists yet, the app is the only reader.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false);

create policy photos_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'photos');

create policy photos_select on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'photos');
