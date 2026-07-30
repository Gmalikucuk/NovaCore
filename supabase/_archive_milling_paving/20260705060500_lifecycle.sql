-- Section 4: Lifecycle — mill -> tack -> pave -> shoulder, as one linked chain.

create table surface_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  road_segment_id uuid not null references road_segments (id),
  event_type text not null check (event_type in
    ('mill', 'tack_coat', 'level_course', 'top_lift', 'shoulder_strip', 'shouldering')),
  event_date date not null,
  side text check (side in ('left', 'right')),
  -- m² for mill/pave, litres for tack, tonnes for shouldering, m for stripping.
  quantity numeric(12,3),

  -- Self-FK to the event that starts this event's deadline clock. Named
  -- linked_mill_event_id because that's the common case (tack_coat/level_course/
  -- top_lift point back to the mill event whose surface they cover), but it is
  -- reused generically: a 'shouldering' row points back to its 'top_lift' event
  -- here too, since event_deadline_rules/lifecycle_deadline_status below need a
  -- single deterministic "prior event" edge to compute days-elapsed against,
  -- regardless of event_type. Flagging this naming quirk rather than silently
  -- introducing a differently-named column — happy to rename to
  -- linked_prior_event_id if you'd rather the column name not imply "mill only".
  linked_mill_event_id uuid references surface_lifecycle_events (id),

  created_at timestamptz not null default now(),

  constraint surface_lifecycle_events_side_only_for_shoulder
    check (side is null or event_type in ('shoulder_strip', 'shouldering'))
);

create index idx_surface_lifecycle_events_road_segment_id on surface_lifecycle_events (road_segment_id);
create index idx_surface_lifecycle_events_linked_mill_event_id on surface_lifecycle_events (linked_mill_event_id);
create index idx_surface_lifecycle_events_event_type on surface_lifecycle_events (event_type);
create index idx_surface_lifecycle_events_event_date on surface_lifecycle_events (event_date);

-- Generic deadline mechanism, reused for mill->pave and top_lift->shouldering.
create table event_deadline_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),
  event_type text not null check (event_type in
    ('mill', 'tack_coat', 'level_course', 'top_lift', 'shoulder_strip', 'shouldering')),
  depends_on_event_type text not null check (depends_on_event_type in
    ('mill', 'tack_coat', 'level_course', 'top_lift', 'shoulder_strip', 'shouldering')),
  days_allowed integer not null,
  created_at timestamptz not null default now(),

  constraint event_deadline_rules_unique unique (project_id, event_type, depends_on_event_type)
);

create index idx_event_deadline_rules_project_id on event_deadline_rules (project_id);
create index idx_event_deadline_rules_event_type on event_deadline_rules (event_type);

-- Deadline STATUS is computed at query time, not stored, since "days remaining"
-- changes every day without any new event happening.
--
-- ASSUMPTION flagged: "due_soon" is defined here as within 2 days of the
-- deadline. That threshold wasn't specified — tell me if you want a different
-- window (or a per-project-configurable one, which would move it into
-- project_config instead of being hardcoded in the view).
create view lifecycle_deadline_status as
select
  sle.id as surface_lifecycle_event_id,
  sle.road_segment_id,
  sle.event_type,
  sle.event_date,
  sle.linked_mill_event_id as linked_prior_event_id,
  prior.event_type as prior_event_type,
  prior.event_date as prior_event_date,
  edr.depends_on_event_type,
  edr.days_allowed,
  case
    when prior.event_date is null or edr.days_allowed is null then null
    else (current_date - prior.event_date)
  end as days_elapsed,
  case
    when prior.event_date is null or edr.days_allowed is null then null
    when (current_date - prior.event_date) > edr.days_allowed then 'overdue'
    when (current_date - prior.event_date) >= (edr.days_allowed - 2) then 'due_soon'
    else 'compliant'
  end as status
from surface_lifecycle_events sle
join road_segments rs on rs.id = sle.road_segment_id
join jobs j on j.id = rs.job_id
left join surface_lifecycle_events prior on prior.id = sle.linked_mill_event_id
left join event_deadline_rules edr
  on edr.project_id = j.project_id
 and edr.event_type = sle.event_type
 and (prior.event_type is null or edr.depends_on_event_type = prior.event_type);

-- Per project_config.joint_sealant_strategy; Venables = single_project_closeout.
create table joint_sealant_closeout (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),

  -- Sum of road_segments.segment_length for this project.
  total_length numeric(12,3),
  -- = total_length * project_config.joint_sealant_band_width_m
  --   * project_config.joint_sealant_rate_l_m2 (app-computed).
  suggested_quantity numeric(12,3),
  actual_quantity numeric(12,3),

  closeout_date date,
  confirmed_by uuid references crew_members (id),
  -- e.g. documented Ministry-accepted deviation from SS 502.08.03.
  moti_deviation_note text,

  created_at timestamptz not null default now()
);

create index idx_joint_sealant_closeout_project_id on joint_sealant_closeout (project_id);
create index idx_joint_sealant_closeout_confirmed_by on joint_sealant_closeout (confirmed_by);
