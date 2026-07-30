-- Truck ticket entry (Paving Stage 2) needs the same atomic, race-free
-- arrival_sequence assignment width_readings already has for
-- station_sequence (see 20260714180000) — investigated first, not assumed:
-- arrival_sequence is currently `integer`, and
-- idx_truck_tickets_segment_day_direction_seq is a plain, non-unique index.
-- No uniqueness is enforced today at all.

-- 1. is_correction, mirroring width_readings — truck_tickets' own
--    correction-support migration (20260705120000) added is_voided/
--    superseded_by/correction_reason but never this. It's required for the
--    same reason width_readings needs it: a correction row reuses its
--    original's arrival_sequence, and the only way to exempt that reuse
--    from the uniqueness check *at insert time* (before the original's own
--    superseded_by update lands) is a flag on the new row itself — not
--    something inferred from the original's state, which hasn't changed
--    yet in the same two-step insert-then-update sequence
--    supersedeWidthReading already uses.
alter table truck_tickets add column is_correction boolean not null default false;

-- 2. numeric(10,3), matching station_sequence's exact precision — so
--    fractional insert-between/insert-before values (item 5) never need a
--    future type migration, per the explicit ask.
alter table truck_tickets alter column arrival_sequence type numeric(10,3);

-- 3. Real uniqueness, scoped like width_readings': correction rows excluded
--    so a replacement can share its original's slot.
drop index if exists idx_truck_tickets_segment_day_direction_seq;
create unique index idx_truck_tickets_segment_day_direction_seq
  on truck_tickets (road_segment_id, paving_date, direction, arrival_sequence)
  where not is_correction;

-- 4. Direct template: assign_width_reading_sequence, same advisory-lock
--    serialization, different salt (1, vs width_readings' 0) so the two
--    tables' locks are independent key spaces and never needlessly
--    serialize against each other for an unrelated table.
create or replace function assign_truck_ticket_sequence()
returns trigger
language plpgsql
as $$
declare
  next_seq numeric;
begin
  if coalesce(current_setting('app.truck_ticket_manual_sequence', true), 'false') = 'true' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    new.road_segment_id::text || '|' || new.paving_date::text || '|' || new.direction,
    1
  ));

  select coalesce(max(arrival_sequence), 0) + 1
  into next_seq
  from truck_tickets
  where road_segment_id = new.road_segment_id
    and paving_date = new.paving_date
    and direction = new.direction;

  new.arrival_sequence := next_seq;
  return new;
end;
$$;

-- when (not new.is_correction) is what lets a correction's insert reuse the
-- original's arrival_sequence untouched, exactly like width_readings'
-- equivalent trigger.
create trigger truck_tickets_assign_sequence
before insert on truck_tickets
for each row
when (not new.is_correction)
execute function assign_truck_ticket_sequence();

-- 5. Tighten the append-only guard: arrival_sequence was left updatable
--    from before this atomic assignment existed — leaving it that way now
--    would let a client silently overwrite the assigned value and reopen
--    exactly the collision risk this migration closes. is_correction joins
--    it as immutable too, same as width_readings' guard. lift_type stays
--    updatable, untouched — that allowance predates this work and isn't
--    part of what's unsafe here.
create or replace function enforce_truck_tickets_update_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_coordinator boolean;
begin
  if new.road_segment_id is distinct from old.road_segment_id
     or new.paving_date is distinct from old.paving_date
     or new.direction is distinct from old.direction
     or new.vehicle_number is distinct from old.vehicle_number
     or new.ticket_number is distinct from old.ticket_number
     or new.net_tonnage is distinct from old.net_tonnage
     or new.arrival_sequence is distinct from old.arrival_sequence
     or new.is_correction is distinct from old.is_correction
     or new.logged_timestamp is distinct from old.logged_timestamp
     or new.entered_by is distinct from old.entered_by
  then
    raise exception 'truck_tickets rows are append-only; only lift_type, is_voided, superseded_by, and correction_reason may be updated';
  end if;

  if new.is_voided is distinct from old.is_voided
     or new.superseded_by is distinct from old.superseded_by
  then
    select exists (
      select 1 from crew_members
      where id = public.effective_crew_member_id() and role = 'coordinator'
    ) into acting_is_coordinator;

    if not (coalesce(old.entered_by = public.effective_crew_member_id(), false) or acting_is_coordinator) then
      raise exception 'only the original entered_by crew member or a coordinator may void or supersede a truck ticket';
    end if;
  end if;

  return new;
end;
$$;

-- 6. insert_truck_ticket_between/before — direct mirrors of
--    insert_width_reading_between/before, same manual-sequence-bypass GUC
--    pattern (own GUC name, app.truck_ticket_manual_sequence, distinct
--    from width_readings' so the two tables' bypass flags can never cross
--    wires within the same transaction).
create or replace function insert_truck_ticket_between(
  after_ticket_id uuid,
  new_vehicle_number text,
  new_ticket_number text,
  new_net_tonnage numeric,
  new_lift_type text
)
returns truck_tickets
language plpgsql
security invoker
set search_path = public
as $$
declare
  after_row truck_tickets;
  next_seq numeric;
  new_seq numeric;
  result truck_tickets;
begin
  select * into after_row from truck_tickets where id = after_ticket_id;
  if not found then
    raise exception 'Ticket % not found', after_ticket_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    after_row.road_segment_id::text || '|' || after_row.paving_date::text || '|' || after_row.direction,
    1
  ));

  select min(arrival_sequence) into next_seq
  from truck_tickets
  where road_segment_id = after_row.road_segment_id
    and paving_date = after_row.paving_date
    and direction = after_row.direction
    and arrival_sequence > after_row.arrival_sequence;

  if next_seq is null then
    new_seq := after_row.arrival_sequence + 1;
  else
    new_seq := round((after_row.arrival_sequence + next_seq) / 2, 3);
    if new_seq <= after_row.arrival_sequence or new_seq >= next_seq then
      raise exception 'No room left to insert a ticket between arrival_sequence % and %', after_row.arrival_sequence, next_seq;
    end if;
  end if;

  perform set_config('app.truck_ticket_manual_sequence', 'true', true);

  insert into truck_tickets (road_segment_id, paving_date, direction, vehicle_number, ticket_number, net_tonnage, arrival_sequence, lift_type, is_correction)
  values (after_row.road_segment_id, after_row.paving_date, after_row.direction, new_vehicle_number, new_ticket_number, new_net_tonnage, new_seq, new_lift_type, false)
  returning * into result;

  return result;
end;
$$;

create or replace function insert_truck_ticket_before(
  before_ticket_id uuid,
  new_vehicle_number text,
  new_ticket_number text,
  new_net_tonnage numeric,
  new_lift_type text
)
returns truck_tickets
language plpgsql
security invoker
set search_path = public
as $$
declare
  before_row truck_tickets;
  prev_seq numeric;
  new_seq numeric;
  result truck_tickets;
begin
  select * into before_row from truck_tickets where id = before_ticket_id;
  if not found then
    raise exception 'Ticket % not found', before_ticket_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    before_row.road_segment_id::text || '|' || before_row.paving_date::text || '|' || before_row.direction,
    1
  ));

  select max(arrival_sequence) into prev_seq
  from truck_tickets
  where road_segment_id = before_row.road_segment_id
    and paving_date = before_row.paving_date
    and direction = before_row.direction
    and arrival_sequence < before_row.arrival_sequence;

  if prev_seq is null then
    new_seq := before_row.arrival_sequence - 1;
  else
    new_seq := round((prev_seq + before_row.arrival_sequence) / 2, 3);
    if new_seq <= prev_seq or new_seq >= before_row.arrival_sequence then
      raise exception 'No room left to insert a ticket between arrival_sequence % and %', prev_seq, before_row.arrival_sequence;
    end if;
  end if;

  perform set_config('app.truck_ticket_manual_sequence', 'true', true);

  insert into truck_tickets (road_segment_id, paving_date, direction, vehicle_number, ticket_number, net_tonnage, arrival_sequence, lift_type, is_correction)
  values (before_row.road_segment_id, before_row.paving_date, before_row.direction, new_vehicle_number, new_ticket_number, new_net_tonnage, new_seq, new_lift_type, false)
  returning * into result;

  return result;
end;
$$;
