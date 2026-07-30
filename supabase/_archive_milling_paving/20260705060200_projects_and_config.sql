-- Section 1: Projects & Config — everything that varies per contract.

create table projects (
  id uuid primary key default gen_random_uuid(),
  contract_number text not null unique,
  name text not null,
  lane_km numeric(10,3),
  start_date date,
  target_completion_date date,
  created_at timestamptz not null default now()
);

-- One row per project. Every value the app reads instead of hardcoding
-- per-contract constants (target rates, bands, deadlines, sealant strategy).
create table project_config (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),

  target_application_rate_kg_m2 numeric(10,4),
  mix_density numeric(8,4),
  lift_thickness_m numeric(6,4),
  tack_coat_rate_l_m2 numeric(8,4),

  mill_to_pave_days_allowed integer,
  shouldering_days_allowed integer,

  joint_sealant_strategy text not null
    check (joint_sealant_strategy in ('single_project_closeout', 'per_segment_closeout', 'per_location_deadline')),
  joint_sealant_band_width_m numeric(6,3),
  joint_sealant_rate_l_m2 numeric(8,4),

  stationing_format text not null
    check (stationing_format in ('lki_station', 'km_chainage')),

  bonus_band_low_pct numeric(5,2),
  bonus_band_high_pct numeric(5,2),
  reject_band_low_pct numeric(5,2),
  reject_band_high_pct numeric(5,2),

  created_at timestamptz not null default now(),

  -- "one row per project" — also serves as the FK index for project_id.
  constraint project_config_project_id_unique unique (project_id)
);

-- Venables: effectively one implicit job. Snowshed: Job A / B / C, each with
-- its own item codes.
create table jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),
  job_code text not null,
  job_name text,
  direction_scope text,
  created_at timestamptz not null default now(),

  -- Composite unique index also covers FK lookups on project_id (leading column).
  constraint jobs_project_id_job_code_unique unique (project_id, job_code)
);
