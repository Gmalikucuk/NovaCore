-- =============================================================================
-- NovaCore v1 — Migration: direction, LKI segment/version, average width,
-- entered area
--
-- Hwy 5 Snowshed Hill is live (contract period opened 2026-08-01, 116.0 lane
-- km, three jobs). A record captured without these fields cannot be
-- reconstructed afterwards — its only source is a superintendent's field
-- sheet at the end of a shift. The station ribbon, the production curve,
-- the application rate document, and the daily report to the Ministry all
-- depend on what's added here.
--
-- FIVE NEW COLUMNS, all nullable, all on quantity_records (never blocking
-- entry of a record that lacks them — historical records won't have any of
-- these, and point work/named locations may have none of them meaningfully):
--
--   direction     text     — NBL/SBL/EBL/WBL. A constrained set, not free
--                            text, because it feeds generated documents (the
--                            daily report to the Ministry states direction
--                            in every paragraph). Nothing beyond these four
--                            values was found in use anywhere in this
--                            product before this migration.
--
--   lki_segment,  integer  — the Landmark Kilometre Inventory segment a
--   lki_version   integer    station is only unique within, and the version
--                            MoTT reissues it under when landmarks change.
--                            A bare station number cannot distinguish
--                            Snowshed Hill's LKI 2090 from 2091. Paired the
--                            same asymmetric way station_from/station_to
--                            already are (a "to" requires a "from", 0003's
--                            daily_entries_station_pair) — a version implies
--                            a segment, not the reverse (quantity_records_
--                            lki_pair, below), since a version number means
--                            nothing without knowing which segment it
--                            versions.
--
--   average_width numeric  — one average width per stretch, metres, not a
--                            readings table — matches the Ministry
--                            Representative's own workbook (one width per
--                            station-to-station row). Null where width is
--                            meaningless: point work, intersections, Items
--                            measured by count.
--
--   area          numeric  — the field-measured area, m², when it disagrees
--                            with or simply isn't computed from width ×
--                            reach. The superintendent's field sheet
--                            supersedes the calculation — that's a standing
--                            rule on this contract, not a suggestion, so
--                            this column exists specifically to hold a
--                            number that may not equal average_width × the
--                            station reach, permanently, without either
--                            value being forced to agree. Showing that
--                            difference is application code's job (Daily
--                            Entry); this column just has to permit it.
--
-- WHY NOT A SEPARATE AREA COLUMN FOR EVERY ITEM: a Square-Metre Item's own
-- quantity already IS its area (Cold Mill's quantity is measured in m² —
-- confirmed against the Hwy 5/Venables seed data before writing this
-- migration). A second, independently-entered area figure for those Items
-- would duplicate quantity, not add information, and would give two
-- numbers for one fact with no way to say which one is authoritative. This
-- column is therefore populated by the application only for Items where
-- quantity means something other than area (Tonne, principally) — Daily
-- Entry's own job to route correctly, not something this schema can express
-- as a constraint (there is no stored flag distinguishing "this Item's
-- quantity is an area" from "it isn't" — today that's inferred from
-- items.unit, a soft spot noted in the application code that reads it).
--
-- NO UNIQUE CONSTRAINT ADDED, and none exists today, on (item_id, work_date)
-- or any subset — checked before writing this migration. Venables 2026-07-30
-- alone has five separate Level Course locations on one Item on one date;
-- nothing here or already in place would block that.
--
-- guard_entry_transitions() is updated to include all five new columns in
-- its existing append-only / confirm-is-not-an-edit / version-bump row(...)
-- comparisons — the same treatment as work_date, quantity, location, note,
-- station_from, station_to already have. Left out, a confirmed record's
-- direction or width could be changed in place with no trigger objection
-- (defeating append-only for exactly these columns), and a draft edit
-- touching only these fields would never bump version (defeating the
-- witnessed-version guarantee 0022 exists to provide). The RPC that actually
-- performs confirmation, confirm_quantity_record(), is a plain
-- UPDATE ... SET status = 'confirmed' on the existing row — it carries no
-- column list of its own and needs no change.
--
-- Requires migrations through 20260806100000.
-- =============================================================================

alter table public.quantity_records
  add column direction     text check (direction in ('NBL', 'SBL', 'EBL', 'WBL')),
  add column lki_segment   integer check (lki_segment is null or lki_segment > 0),
  add column lki_version   integer check (lki_version is null or lki_version > 0),
  add column average_width numeric check (average_width is null or average_width >= 0),
  add column area          numeric check (area is null or area >= 0);

alter table public.quantity_records
  add constraint quantity_records_lki_pair
    check (lki_version is null or lki_segment is not null);

comment on column public.quantity_records.direction is
  'NBL/SBL/EBL/WBL — a constrained set, not free text, because it feeds '
  'generated documents (the daily report to the Ministry states direction '
  'in every paragraph). Null for point work and named locations with no '
  'meaningful direction.';

comment on column public.quantity_records.lki_segment is
  'The Landmark Kilometre Inventory segment a station is only unique '
  'within. Null on historical records entered before this column existed.';

comment on column public.quantity_records.lki_version is
  'The version MoTT reissued lki_segment under when landmarks changed — a '
  'bare segment number can resolve to a different place after a reissue. '
  'Requires lki_segment to be set (quantity_records_lki_pair); a version '
  'means nothing without knowing which segment it versions.';

comment on column public.quantity_records.average_width is
  'One average width per stretch, metres — matches the Ministry '
  'Representative''s own workbook convention, not a richer per-reading '
  'record. Null where width is meaningless: point work, intersections, '
  'Items measured by count.';

comment on column public.quantity_records.area is
  'The field-measured area in m², entered directly when it disagrees with '
  'or was never computed from average_width times the station reach — the '
  'superintendent''s field sheet supersedes the calculation, permanently, '
  'by design; this column does not enforce agreement with average_width. '
  'Populated by the application only for Items whose own quantity is not '
  'already an area (see this migration''s header) — left null for '
  'Square-Metre Items, where quantity already is the area.';

-- -----------------------------------------------------------------------------
-- Grant — belt, additive, same pattern as 0021's draft-edit grant. Column
-- grants are cumulative in Postgres; this does not replace the existing
-- grant update (quantity, location, note, station_from, station_to,
-- work_date), it supplements it.
-- -----------------------------------------------------------------------------
grant update (direction, lki_segment, lki_version, average_width, area)
  on public.quantity_records to authenticated;

-- -----------------------------------------------------------------------------
-- Trigger — the five new columns join the existing capture-field set in
-- every row(...) comparison guard_entry_transitions() already makes.
-- Identity columns (contract_id, item_id, supersedes, created_by,
-- device_id) are unaffected — these five are capture fields, exactly like
-- work_date/quantity/location/note/station_from/station_to.
-- -----------------------------------------------------------------------------
create or replace function public.guard_entry_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'confirmed' and new.status = 'draft' then
    raise exception
      'a confirmed record cannot be un-confirmed; supersede it instead';
  end if;

  if row(new.contract_id, new.item_id, new.supersedes, new.created_by, new.device_id)
     is distinct from
     row(old.contract_id, old.item_id, old.supersedes, old.created_by, old.device_id)
  then
    raise exception
      'quantity_records identity columns (contract_id, item_id, supersedes, '
      'created_by, device_id) are immutable';
  end if;

  if old.status = 'confirmed'
     and row(new.work_date, new.quantity, new.location, new.note,
             new.station_from, new.station_to,
             new.direction, new.lki_segment, new.lki_version,
             new.average_width, new.area)
       is distinct from
       row(old.work_date, old.quantity, old.location, old.note,
           old.station_from, old.station_to,
           old.direction, old.lki_segment, old.lki_version,
           old.average_width, old.area)
  then
    raise exception
      'quantity_records rows are append-only once confirmed; correct by '
      'inserting a superseding row';
  end if;

  if old.status = 'draft' and new.status = 'confirmed'
     and row(new.work_date, new.quantity, new.location, new.note,
             new.station_from, new.station_to,
             new.direction, new.lki_segment, new.lki_version,
             new.average_width, new.area)
       is distinct from
       row(old.work_date, old.quantity, old.location, old.note,
           old.station_from, old.station_to,
           old.direction, old.lki_segment, old.lki_version,
           old.average_width, old.area)
  then
    raise exception
      'cannot edit quantity_records fields in the same statement that '
      'confirms them; edit while draft, then confirm separately';
  end if;

  if old.status = 'draft' and new.status = 'draft'
     and row(new.work_date, new.quantity, new.location, new.note,
             new.station_from, new.station_to,
             new.direction, new.lki_segment, new.lki_version,
             new.average_width, new.area)
       is distinct from
       row(old.work_date, old.quantity, old.location, old.note,
           old.station_from, old.station_to,
           old.direction, old.lki_segment, old.lki_version,
           old.average_width, old.area)
  then
    new.version := old.version + 1;
  end if;

  if old.status = 'draft' and new.status = 'confirmed' then
    new.confirmed_by := auth.uid();
    new.confirmed_at := now();
  end if;

  if old.status = 'confirmed' and new.status = 'confirmed' then
    new.confirmed_by := old.confirmed_by;
    new.confirmed_at := old.confirmed_at;
  end if;

  return new;
end;
$$;

-- =============================================================================
-- Verify —
--
--   -- as an enter_quantity holder, edit only a new field on a draft:
--   update quantity_records set direction = 'NBL' where id = '<draft id>';
--   -- expect: succeeds, version bumped by 1 (the OLD append-only check
--   -- would never have caught this — confirms all five new columns are
--   -- wired into the comparison, not just the pre-existing six)
--
--   -- confirm it, then try to change a new field on the confirmed row:
--   select confirm_quantity_record('<same id>', <new version>);
--   update quantity_records set average_width = 6.0 where id = '<same id>';
--   -- expect: 0 rows visible via RLS, or from postgres directly,
--   -- P0001 'append-only once confirmed'
--
--   insert into quantity_records
--     (id, contract_id, item_id, work_date, quantity, created_by,
--      direction, lki_segment, lki_version, average_width, area)
--   values (gen_random_uuid(), '<contract>', '<item>', current_date, 10,
--           auth.uid(), null, null, null, null, null);
--   -- expect: succeeds — every new column accepts null, nothing blocks a
--   -- record entered without any of them
-- =============================================================================
