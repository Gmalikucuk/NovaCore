-- Section 3: Field Data Capture — append-only, correction-via-supersede.

create table width_readings (
  id uuid primary key default gen_random_uuid(),
  road_segment_id uuid not null references road_segments (id),
  paving_date date not null,
  direction text not null check (direction in ('NB', 'SB', 'EB', 'WB')),

  -- Field entry order — NEVER sort by station for calculations.
  station_sequence integer not null,
  station numeric(12,3) not null,
  width numeric(8,3) not null,

  entry_timestamp timestamptz not null default now(),
  entered_by uuid not null references crew_members (id),

  is_correction boolean not null default false,
  superseded_by uuid references width_readings (id),
  correction_reason text,

  constraint width_readings_correction_reason_required
    check (not is_correction or correction_reason is not null)
);

create index idx_width_readings_road_segment_id on width_readings (road_segment_id);
create index idx_width_readings_entered_by on width_readings (entered_by);
create index idx_width_readings_superseded_by on width_readings (superseded_by);
create index idx_width_readings_paving_date on width_readings (paving_date);
create index idx_width_readings_station on width_readings (station);
-- Covers the common "give me this segment/day/direction's readings in field
-- entry order" query.
create index idx_width_readings_segment_day_direction_seq
  on width_readings (road_segment_id, paving_date, direction, station_sequence);

create table truck_tickets (
  id uuid primary key default gen_random_uuid(),
  road_segment_id uuid not null references road_segments (id),
  paving_date date not null,
  direction text not null check (direction in ('NB', 'SB', 'EB', 'WB')),

  vehicle_number text not null,
  ticket_number text not null,
  net_tonnage numeric(10,3) not null,

  -- Editable — defaults to entry order, but can be corrected later.
  arrival_sequence integer not null,
  lift_type text not null check (lift_type in ('top_lift', 'level_course')),

  logged_timestamp timestamptz not null default now(),
  entered_by uuid not null references crew_members (id)
);

create index idx_truck_tickets_road_segment_id on truck_tickets (road_segment_id);
create index idx_truck_tickets_entered_by on truck_tickets (entered_by);
create index idx_truck_tickets_paving_date on truck_tickets (paving_date);
create index idx_truck_tickets_lift_type on truck_tickets (lift_type);
create index idx_truck_tickets_segment_day_direction_seq
  on truck_tickets (road_segment_id, paving_date, direction, arrival_sequence);

-- Audit trail: every change to lift_type or arrival_sequence on a truck ticket.
create table attribution_history (
  id uuid primary key default gen_random_uuid(),
  truck_ticket_id uuid not null references truck_tickets (id),
  field_changed text not null check (field_changed in ('lift_type', 'arrival_sequence')),
  -- Stored as text for both fields (lift_type is already text, arrival_sequence
  -- is cast to text) so one audit table can cover either field generically.
  old_value text not null,
  new_value text not null,
  changed_by uuid not null references crew_members (id),
  changed_at timestamptz not null default now(),
  reason text not null
);

create index idx_attribution_history_truck_ticket_id on attribution_history (truck_ticket_id);
create index idx_attribution_history_changed_by on attribution_history (changed_by);
create index idx_attribution_history_changed_at on attribution_history (changed_at);

create table superintendent_notes (
  id uuid primary key default gen_random_uuid(),
  road_segment_id uuid not null references road_segments (id),
  paving_date date not null,
  direction text not null check (direction in ('NB', 'SB', 'EB', 'WB')),

  -- Station RANGE the note applies to, not just the day.
  from_station numeric(12,3) not null,
  to_station numeric(12,3) not null,

  note_text text not null,
  created_by uuid not null references crew_members (id),
  created_at timestamptz not null default now()
);

create index idx_superintendent_notes_road_segment_id on superintendent_notes (road_segment_id);
create index idx_superintendent_notes_created_by on superintendent_notes (created_by);
create index idx_superintendent_notes_paving_date on superintendent_notes (paving_date);
