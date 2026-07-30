-- Full-contract data model: all real Schedule 7 line items for the Venables
-- project, not just the subset that maps to a tracked surface_lifecycle_events
-- event_type. Lets Dashboard/Tracker show genuine contract-wide progress (or
-- an honest "not yet tracked in this app" state) instead of silently only
-- covering the handful of items this app currently has a data-capture path
-- for.

create table contract_item_targets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),

  item_code text not null,
  description text not null,
  section text not null,
  uom text not null,
  -- NULL for lump-sum/provisional-sum items — there is no discrete quantity
  -- to track for those, not a zero.
  contract_qty numeric(14,3),
  -- No bid pricing exists for this project yet, and may never. NULL means
  -- "unknown" — never coalesce this to 0 in any downstream query or display.
  unit_price numeric(14,4),
  -- Matches surface_lifecycle_events.event_type where this item has a real
  -- data-capture path in the app today; NULL for items the contract tracks
  -- but this app doesn't yet (manholes, barrier work, joint sealant, etc.).
  event_type text,
  is_lump_sum boolean not null default false,

  created_at timestamptz not null default now(),

  constraint contract_item_targets_project_item_code_unique unique (project_id, item_code),
  constraint contract_item_targets_event_type_check
    check (event_type is null or event_type in
      ('mill', 'tack_coat', 'level_course', 'top_lift', 'shoulder_strip', 'shouldering', 'milled_tie_in')),
  -- A lump-sum item has no discrete quantity; every measured item must have
  -- one (the contract always specifies a quantity for those).
  constraint contract_item_targets_qty_consistency
    check (is_lump_sum = (contract_qty is null))
);

create index idx_contract_item_targets_project_id on contract_item_targets (project_id);
create index idx_contract_item_targets_section on contract_item_targets (section);
create index idx_contract_item_targets_event_type on contract_item_targets (event_type);

-- Same "broad access, no delete" pattern as project_config/event_deadline_rules
-- — reference/config data defining the contract itself, not field-entered
-- records.
alter table contract_item_targets enable row level security;

create policy contract_item_targets_select on contract_item_targets for select to anon, authenticated using (true);
create policy contract_item_targets_insert on contract_item_targets for insert to anon, authenticated with check (true);
create policy contract_item_targets_update on contract_item_targets for update to anon, authenticated using (true) with check (true);

grant select, insert, update on contract_item_targets to anon, authenticated;
revoke delete on contract_item_targets from anon, authenticated;

-- Seed: all real Schedule 7 line items for the Venables project (26754-0000),
-- quantities verified from the contract. Only 7 of these have an event_type
-- mapping today; the rest are real contract obligations this app doesn't yet
-- have a data-capture path for.
insert into contract_item_targets
  (project_id, item_code, description, section, uom, contract_qty, unit_price, event_type, is_lump_sum)
select p.id, v.item_code, v.description, v.section, v.uom, v.contract_qty, null, v.event_type, v.is_lump_sum
from projects p, (values
  -- SECTION 1 — GENERAL
  ('01.01',    'Mobilization',                                  'GENERAL',            'Lump Sum', null,    null,             true),
  ('01.02',    'Quality Management',                            'GENERAL',            'Lump Sum', null,    null,             true),
  ('01.03',    'Provisional Sum – Site Modifications (SP 1.29)','GENERAL',            'Prov. Sum',null,    null,             true),
  ('01.04',    'Provisional Sum – Diesel Fuel Price Adjustment (SP 1.33)','GENERAL',  'Prov. Sum',null,    null,             true),
  -- SECTION 2 — TRAFFIC MANAGEMENT
  ('02.01',    'Traffic Management',                            'TRAFFIC MANAGEMENT', 'Lump Sum', null,    null,             true),
  -- SECTION 3 — AGGREGATE
  ('03.01.01', 'Asphalt Medium Mix Aggregate (DFPA 6)',         'AGGREGATE',          'Tonne',    53450,   null,             false),
  ('03.01.02', 'Shoulder Aggregate',                             'AGGREGATE',          'Tonne',    5000,    null,             false),
  -- SECTION 4 — CONSTRUCTION
  ('04.01.01', 'Install C-035 Project Signs',                   'CONSTRUCTION',       'Each',     3,       null,             false),
  ('04.02',    'Pavement Markings',                              'CONSTRUCTION',       'Lump Sum', null,    null,             true),
  ('04.03.01', 'Milled Tie Ins',                                 'CONSTRUCTION',       'm2',       1200,    'milled_tie_in',  false),
  ('04.03.02', 'Cold Mill 50mm (DFPA 5b)',                      'CONSTRUCTION',       'm2',       421100,  'mill',           false),
  ('04.03.03', 'Cold Mill Full Depth (DFPA 5e)',                'CONSTRUCTION',       'm2',       400,     null,             false),
  ('04.04.01', 'Shoulder Stripping',                             'CONSTRUCTION',       'm',        29000,   'shoulder_strip', false),
  ('04.04.02', 'Shouldering',                                    'CONSTRUCTION',       'Tonne',    5000,    'shouldering',    false),
  ('04.05.01', 'Inspect Manholes',                               'CONSTRUCTION',       'Each',     17,      null,             false),
  ('04.05.02', 'Adjust Manholes',                                'CONSTRUCTION',       'Each',     17,      null,             false),
  ('04.05.03', 'Adjust Water Valves',                            'CONSTRUCTION',       'Each',     6,       null,             false),
  ('04.06.01', 'Remove and Dispose Existing 686mm CRB',         'CONSTRUCTION',       'm',        150,     null,             false),
  ('04.06.02', 'Remove, Stockpile and Replace Existing Barrier','CONSTRUCTION',       'm',        1770,    null,             false),
  ('04.06.03', 'Supply and Install 690mm CRB H+E',              'CONSTRUCTION',       'Each',     60,      null,             false),
  ('04.06.04', 'Supply and Install 690mm CTB-1E',                'CONSTRUCTION',       'Each',     1,       null,             false),
  ('04.06.05', 'Supply and Install 690mm CBN-H',                 'CONSTRUCTION',       'Each',     1,       null,             false),
  ('04.06.06', 'Supply and Install Barrier Reflectors',          'CONSTRUCTION',       'Each',     80,      null,             false),
  ('04.07.01', 'Remove and Dispose of Asphalt Curb',            'CONSTRUCTION',       'm',        140,     null,             false),
  ('04.07.02', 'Integral Asphalt Curb',                          'CONSTRUCTION',       'm',        140,     null,             false),
  ('04.07.03', 'Asphalt Spillways',                              'CONSTRUCTION',       'Each',     2,       null,             false),
  ('04.08.01', 'Hot Joint Sealant',                              'CONSTRUCTION',       'Litre',    3900,    null,             false),
  ('04.08.02', 'Supply Joint Sealant',                           'CONSTRUCTION',       'Litre',    6000,    null,             false),
  ('04.08.03', 'Apply Joint Sealant',                            'CONSTRUCTION',       'Litre',    8000,    null,             false),
  -- SECTION 5 — PAVING
  ('05.01',    'Provisional Sum – EPS Payment Adjustments',     'PAVING',             'Prov. Sum',null,    null,             true),
  ('05.02.01', 'Supply & Apply Tack Coat',                       'PAVING',             'Litre',    121000,  'tack_coat',      false),
  ('05.03.01', 'Level Course (DFPA 7)',                          'PAVING',             'Tonne',    2500,    'level_course',   false),
  ('05.03.02', 'Top Lift 50mm – Hwy 1/97/99/97C (DFPA 7)',      'PAVING',             'Tonne',    50650,   'top_lift',       false),
  ('05.03.03', 'Top Lift 50mm – Side Roads (DFPA 7)',           'PAVING',             'Tonne',    300,     null,             false)
) as v(item_code, description, section, uom, contract_qty, event_type, is_lump_sum)
where p.contract_number = '26754-0000';
