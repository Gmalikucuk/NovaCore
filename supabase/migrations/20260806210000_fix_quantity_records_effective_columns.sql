-- =============================================================================
-- NovaCore v1 — Migration 0040: quantity_records_effective — recreate with
-- an explicit column list, and a guard against this recurring
--
-- THE BUG. quantity_records_effective (0001, renamed 0009) was created as
-- `select r.*`. Postgres resolves a view's output columns at
-- CREATE/CREATE OR REPLACE time — `select *` is expanded into the concrete
-- column list the underlying table had AT THAT MOMENT, and does not
-- track later ALTER TABLEs. The view was last touched before `version`
-- (0022, confirm_quantity_record's witnessed-version column) and before
-- direction/lki_segment/lki_version/average_width/area (the migration
-- that added them) existed on quantity_records, so all six are invisible
-- through the view today — `select item_id, lki_segment from
-- quantity_records_effective` fails outright; a hypothetical `select *`
-- reader would silently never see them.
--
-- INVESTIGATION FIRST, reported before this migration was written. Every
-- reader of quantity_records_effective was audited: one direct app-code
-- reader (dashboard.ts's fetchEffectiveQuantities, selecting only
-- item_id/quantity — neither missing) turned out to be dead code with
-- zero callers, deleted alongside this migration, not by it. The three
-- dependent SQL views (v_item_progress, v_item_month, v_item_progress_
-- rate) each select only quantity/work_date/item_id/contract_id from it —
-- all present, none affected. No reader was ever silently getting null
-- where a value existed; the defect was live but had caused no wrong
-- output. Checked against all 8 views in the schema: this is the ONLY one
-- ever written as `select *` — the other seven were hand-written with
-- explicit column lists from their own creation, and at least one
-- (v_item_finance) was correctly recreated with an explicit new column
-- (cost_basis) when that was added, proving the discipline already works
-- when a view isn't built on a wildcard in the first place. One instance,
-- not a class.
--
-- THE FIX. Recreate with every current quantity_records column named
-- explicitly. The first 17 (id..station_to) keep their exact existing
-- name/order/type — Postgres's CREATE OR REPLACE VIEW rule requires this,
-- and forbids reordering, retyping, or dropping any of them; it only
-- allows appending new columns at the end. The six new ones are appended
-- in the table's own column order. No dependent object needs dropping:
-- confirmed via pg_depend that the three dependent views only ever touch
-- already-present columns, so widening the output disturbs nothing. The
-- WHERE clause and security_invoker=on are unchanged — this changes what
-- is visible past RLS, not the security posture or the row-selection rule.
--
-- THE GUARD. A DO block right after CREATE OR REPLACE re-checks that the
-- fix actually landed (self-check, this migration only). That alone only
-- protects today — a future migration that adds a seventh column to
-- quantity_records and forgets the view would not trip it, because
-- migrations are immutable history and this block does not re-run for
-- migrations after it. The actual "fail loudly next time" guard is the
-- event trigger below: it fires on every future ALTER TABLE, and if the
-- altered table is quantity_records and the view is now missing a
-- column, it raises — which aborts the ALTER TABLE itself, inside the
-- same transaction as whatever migration issued it. A future column
-- addition that doesn't also touch the view fails to apply at all,
-- rather than shipping quietly. A comment on the view's own CREATE
-- statement points column-adders at this before they hit the wall.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Recreate the view with an explicit column list
-- -----------------------------------------------------------------------------

-- security_invoker = on so RLS applies to the CALLER, unchanged from 0001/0009.
-- EXPLICIT COLUMN LIST — do not collapse this back to `select r.*`. That is
-- exactly how this view went stale before: a wildcard resolves once, at
-- CREATE time, and silently stops tracking the table. Adding a column to
-- quantity_records? List it here in the SAME migration, or the event
-- trigger below (guard_quantity_records_effective_columns) will refuse
-- your ALTER TABLE.
create or replace view public.quantity_records_effective
with (security_invoker = on) as
select
  id,
  contract_id,
  item_id,
  work_date,
  location,
  quantity,
  note,
  status,
  supersedes,
  confirmed_by,
  confirmed_at,
  created_by,
  device_id,
  created_at,
  synced_at,
  station_from,
  station_to,
  version,
  direction,
  lki_segment,
  lki_version,
  average_width,
  area
from public.quantity_records r
where r.status = 'confirmed'
  and not exists (
    select 1 from public.quantity_records c
    where c.supersedes = r.id and c.status = 'confirmed'
  );

comment on view public.quantity_records_effective is
  'A record counts when it is confirmed AND has no CONFIRMED successor. '
  'Supersession takes effect on confirmation, not insertion — otherwise a '
  'correction awaiting review removes quantity from the totals while its '
  'replacement has not yet entered them, and the figures are silently wrong '
  'during exactly the review that prompted the correction. '
  'Column list is EXPLICIT, not select * — see guard_quantity_records_'
  'effective_columns() and the event trigger on quantity_records for what '
  'enforces that a future ALTER TABLE cannot silently orphan it again. '
  'effectiveEntries.ts''s filterEffective() is the same rule expressed a '
  'second time, client-side, on purpose — see that file''s doc comment.';

-- -----------------------------------------------------------------------------
-- 2. Self-check: did the fix actually land? (this migration only)
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(column_name, ', ' order by column_name)
  into v_missing
  from information_schema.columns
  where table_schema = 'public' and table_name = 'quantity_records'
    and column_name not in (
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'quantity_records_effective'
    );

  if v_missing is not null then
    raise exception 'quantity_records_effective recreation did not fix the '
      'defect — still missing: %. The CREATE OR REPLACE VIEW above did not '
      'take, or a column name mismatch exists.', v_missing;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Persistent guard: fail loudly on the NEXT ALTER TABLE that drifts
-- -----------------------------------------------------------------------------
create or replace function public.guard_quantity_records_effective_columns()
returns event_trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_altered_this_table boolean;
  v_missing text;
begin
  select exists (
    select 1 from pg_event_trigger_ddl_commands()
    where object_identity = 'public.quantity_records'
      and object_type = 'table'
  ) into v_altered_this_table;

  if not v_altered_this_table then
    return;
  end if;

  select string_agg(column_name, ', ' order by column_name)
  into v_missing
  from information_schema.columns
  where table_schema = 'public' and table_name = 'quantity_records'
    and column_name not in (
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'quantity_records_effective'
    );

  if v_missing is not null then
    raise exception 'quantity_records gained column(s) not present on '
      'quantity_records_effective: %. Recreate the view (CREATE OR REPLACE '
      'VIEW public.quantity_records_effective, explicit column list, '
      'security_invoker = on unchanged) with the new column(s) added in '
      'THIS SAME migration — this is 0040''s guard against the exact bug '
      '0040 fixed.', v_missing;
  end if;
end;
$$;

comment on function public.guard_quantity_records_effective_columns is
  'Event trigger body — fires after any ALTER TABLE. If the altered table '
  'is quantity_records and quantity_records_effective is now missing a '
  'column, raises and aborts the ALTER TABLE. Exists so a future column '
  'addition that forgets the view fails the migration outright instead of '
  'shipping a silently stale view (0040).';

drop event trigger if exists guard_quantity_records_effective_columns;
create event trigger guard_quantity_records_effective_columns
  on ddl_command_end
  when tag in ('ALTER TABLE')
  execute function public.guard_quantity_records_effective_columns();
