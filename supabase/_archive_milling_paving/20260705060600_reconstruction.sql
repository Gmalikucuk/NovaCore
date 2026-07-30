-- Section 5: Reconstruction — versioned, re-runnable, never edited in place.

create table reconstruction_runs (
  id uuid primary key default gen_random_uuid(),
  road_segment_id uuid not null references road_segments (id),
  paving_date date not null,
  direction text not null check (direction in ('NB', 'SB', 'EB', 'WB')),
  run_number integer not null,

  -- Frozen reference to exactly which width_readings/truck_tickets rows+versions
  -- fed this run, for full traceability.
  input_snapshot jsonb not null,

  status text not null default 'draft' check (status in ('draft', 'accepted')),

  blended_rate_pct numeric(6,2),
  total_area numeric(14,4),
  total_tonnage numeric(14,4),

  generated_at timestamptz not null default now(),

  constraint reconstruction_runs_unique_run
    unique (road_segment_id, paving_date, direction, run_number)
);

create index idx_reconstruction_runs_road_segment_id on reconstruction_runs (road_segment_id);
create index idx_reconstruction_runs_paving_date on reconstruction_runs (paving_date);
create index idx_reconstruction_runs_status on reconstruction_runs (status);

-- Enforce only one 'accepted' run per (road_segment_id, paving_date, direction).
create unique index reconstruction_runs_one_accepted_per_segment_day
  on reconstruction_runs (road_segment_id, paving_date, direction)
  where status = 'accepted';

-- The actual per-truck Sl.No/From/To/Area/Rate% rows.
create table reconstruction_output_rows (
  id uuid primary key default gen_random_uuid(),
  reconstruction_run_id uuid not null references reconstruction_runs (id),

  sl_no integer not null,
  vehicle_number text not null,
  ticket_number text not null,

  tonnage_current numeric(10,3) not null,
  tonnage_cumulative numeric(12,3) not null,

  from_station numeric(12,3) not null,
  to_station numeric(12,3) not null,
  segment_length numeric(12,3) not null,
  cumulative_length numeric(12,3) not null,

  avg_width numeric(8,3) not null,
  area numeric(14,4) not null,
  rate_kg_m2 numeric(10,4) not null,
  rate_pct numeric(6,2) not null,

  comment text
);

create index idx_reconstruction_output_rows_run_id on reconstruction_output_rows (reconstruction_run_id);
-- Covers "give me this run's rows in Sl.No order".
create index idx_reconstruction_output_rows_run_sl_no
  on reconstruction_output_rows (reconstruction_run_id, sl_no);
