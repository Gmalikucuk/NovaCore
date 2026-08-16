-- =============================================================================
-- NovaCore v1 — Migration: cost registers — equipment, labour, materials
--
-- Three company-level reference registers, same shape as owners/
-- standard_items (0047): open-read identity tables plus separately-gated
-- rate history, all on has_global_right — no contract to be a member of.
-- No schema change to anything contract-scoped.
--
-- EVERY RATE IS TIME-KEYED, NOT A COLUMN ON THE THING IT PRICES. A bid
-- priced in 2024 used 2024 rates; comparing an old estimate against actual
-- cost later requires reading the rate that was current when the estimate
-- was made, not whatever the register holds today. Flat editable rates
-- would destroy that the first time anyone corrects a figure. Two key
-- shapes:
--
--   equipment_rates    — keyed by book_year (an integer), because the
--                         Blue Book (BC Road Builders' Equipment Rental
--                         Rate Guide) publishes one edition per year and
--                         a rate is always "the N book's rate," not a
--                         calendar date.
--   *_rates (the other four) — keyed by effective_date, because labour
--                         class rates, material rates, and the two
--                         payroll percentages have no annual edition to
--                         key off; they change whenever they change.
--
-- NEITHER KEY IS EVER RESOLVED AUTOMATICALLY FROM A CALENDAR DATE BY THIS
-- MIGRATION. book_year is a fact a person states explicitly (which book
-- they priced against), never derived from a bid's own date — the same
-- standing rule as tender_price and contract_state: entered by a person,
-- never inferred. The pure accessors this brief adds (rateHistory.ts) are
-- built so every caller must say "as of when," never "give me the rate" —
-- see that file's own header for why.
--
-- WHAT DOES NOT GET HISTORY: equipment's own identity (type/year/make/
-- model), labour_classes' own identity (class_name), materials' own
-- identity (description/unit). These are facts about the thing, not a
-- rate — editable in place, same as items.description already is.
--
-- WHY NOT A PEOPLE REGISTER (§2 of the brief, argued and settled): a DWR
-- types a name per report; a standing roster of employees is HR-adjacent
-- and separable later. Not built here.
--
-- WHY PURCHASED-VS-STOCK ISN'T A COLUMN HERE: the same material can be
-- purchased fresh for one job and drawn from stock for another — that's a
-- fact about a specific use, not about the material generally. Belongs on
-- whatever eventually consumes a material line, not this register.
--
-- RIGHTS. Two, applied uniformly across all three registers — has_global_
-- right, same mechanism as create_bids/set_bid_cost/view_bid_costs:
--
--   maintain_cost_registers   add/edit every table below, identity and
--                             rates alike.
--   view_cost_register_rates  read the RATE figures specifically.
--
-- maintain_cost_registers IMPLIES read of rates — a deliberate departure
-- from the bids split, where create_bids and view_bid_costs stayed fully
-- independent on purpose (pricing and costing are different people with a
-- real need-to-know wall). Here there's one role — whoever keeps a
-- register current — and that role cannot function without seeing what it
-- is correcting. Identity fields (equipment type/year/make/model, class
-- name, material description/unit) stay open-read to any authenticated
-- seat, same posture as owners/standard_items — a machine list isn't
-- sensitive, what it rents for is.
--
-- Requires migrations through 20260816120000.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rights
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column maintain_cost_registers    boolean not null default false,
  add column view_cost_register_rates   boolean not null default false;

comment on column public.profiles.maintain_cost_registers is
  'Company-wide (has_global_right). Add/edit equipment, labour classes, '
  'materials, and every rate/history table under them. Implies read of '
  'rates — maintaining a register requires seeing what it holds.';
comment on column public.profiles.view_cost_register_rates is
  'Company-wide. Read rate figures (equipment rates, labour class rates, '
  'material rates, payroll additive/tool allowance) without being able to '
  'change the register. Identity fields need no right at all — open read.';

-- -----------------------------------------------------------------------------
-- 2. Equipment
-- -----------------------------------------------------------------------------
create table public.equipment (
  id             uuid primary key default gen_random_uuid(),
  equipment_type text not null,
  year           integer check (year is null or year > 1900),
  make           text,
  model          text,
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now()
);

comment on table public.equipment is
  'Keywest''s own machines. Fields match the Ministry''s Daily Work Report. '
  'year here is the machine''s own model year — not to be confused with '
  'equipment_rates.book_year, the Blue Book edition a rate comes from.';

grant select, insert, update on public.equipment to authenticated;
alter table public.equipment enable row level security;

create policy equipment_select_authenticated on public.equipment
  for select to authenticated using (true);

create policy equipment_write_right on public.equipment
  for all to authenticated
  using (public.has_global_right('maintain_cost_registers'))
  with check (public.has_global_right('maintain_cost_registers'));

create table public.equipment_rates (
  id               uuid primary key default gen_random_uuid(),
  equipment_id     uuid not null references public.equipment(id) on delete cascade,
  book_year        integer not null check (book_year > 1900),
  blue_book_rate   numeric check (blue_book_rate is null or blue_book_rate >= 0),
  internal_rate    numeric check (internal_rate is null or internal_rate >= 0),
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  unique (equipment_id, book_year)
);

comment on table public.equipment_rates is
  'One row per equipment per Blue Book edition. blue_book_rate is what '
  'gets billed (the published guide is a copyrighted BC Road Builders '
  'publication — never imported or embedded here, only the figure someone '
  'typed for Keywest''s own fleet). internal_rate is what it actually '
  'costs. Both optional, independently — never one computed from the '
  'other. A new book_year is a new row; the same year''s row may be '
  'corrected in place before anything relies on it.';

grant select, insert, update on public.equipment_rates to authenticated;
alter table public.equipment_rates enable row level security;

create policy equipment_rates_select_right on public.equipment_rates
  for select to authenticated
  using (public.has_global_right('maintain_cost_registers') or public.has_global_right('view_cost_register_rates'));

create policy equipment_rates_write_right on public.equipment_rates
  for all to authenticated
  using (public.has_global_right('maintain_cost_registers'))
  with check (public.has_global_right('maintain_cost_registers'));

-- -----------------------------------------------------------------------------
-- 3. Labour — classes (identity) + rates (history) + the two payroll
--    percentages, all effective_date-keyed per the brief's own correction:
--    "My silence was an oversight... a bid priced in 2024 used 2024 rates."
-- -----------------------------------------------------------------------------
create table public.labour_classes (
  id          uuid primary key default gen_random_uuid(),
  class_name  text not null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

comment on table public.labour_classes is
  'Classes, not named people — operator, labourer, foreman, whatever '
  'Keywest actually uses. A DWR types a name alongside a class; the name '
  'is per-report data, not a standing roster this table holds.';

grant select, insert, update on public.labour_classes to authenticated;
alter table public.labour_classes enable row level security;

create policy labour_classes_select_authenticated on public.labour_classes
  for select to authenticated using (true);

create policy labour_classes_write_right on public.labour_classes
  for all to authenticated
  using (public.has_global_right('maintain_cost_registers'))
  with check (public.has_global_right('maintain_cost_registers'));

create table public.labour_class_rates (
  id               uuid primary key default gen_random_uuid(),
  labour_class_id  uuid not null references public.labour_classes(id) on delete cascade,
  hourly_rate      numeric not null check (hourly_rate >= 0),
  effective_date   date not null,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  unique (labour_class_id, effective_date)
);

comment on table public.labour_class_rates is
  'History, not a column on labour_classes — a class''s hourly rate '
  'changes over time and an old bid must read against the rate that was '
  'current when it was made. "Current" is the row with the latest '
  'effective_date at or before the date in question — see rateHistory.ts.';

grant select, insert, update on public.labour_class_rates to authenticated;
alter table public.labour_class_rates enable row level security;

create policy labour_class_rates_select_right on public.labour_class_rates
  for select to authenticated
  using (public.has_global_right('maintain_cost_registers') or public.has_global_right('view_cost_register_rates'));

create policy labour_class_rates_write_right on public.labour_class_rates
  for all to authenticated
  using (public.has_global_right('maintain_cost_registers'))
  with check (public.has_global_right('maintain_cost_registers'));

create table public.payroll_additive_rates (
  id              uuid primary key default gen_random_uuid(),
  percent         numeric not null check (percent >= 0),
  effective_date  date not null unique,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);

comment on table public.payroll_additive_rates is
  'The burden on top of a wage (typically 25-45% open shop, higher with '
  'full fringes) — a company property with history, not a per-job choice. '
  'One value at a time company-wide, so no entity id, just effective_date.';

grant select, insert, update on public.payroll_additive_rates to authenticated;
alter table public.payroll_additive_rates enable row level security;

create policy payroll_additive_rates_select_right on public.payroll_additive_rates
  for select to authenticated
  using (public.has_global_right('maintain_cost_registers') or public.has_global_right('view_cost_register_rates'));

create policy payroll_additive_rates_write_right on public.payroll_additive_rates
  for all to authenticated
  using (public.has_global_right('maintain_cost_registers'))
  with check (public.has_global_right('maintain_cost_registers'));

create table public.tool_allowance_rates (
  id              uuid primary key default gen_random_uuid(),
  percent         numeric not null check (percent >= 0),
  effective_date  date not null unique,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);

comment on table public.tool_allowance_rates is
  'The DWR''s own tool allowance figure (1% today) — same company-property-'
  'with-history shape as payroll_additive_rates, kept in its own table '
  'rather than a discriminator column on one shared table (this schema''s '
  'usual preference — see item_prices vs bid_item_costs for the same call '
  'made before).';

grant select, insert, update on public.tool_allowance_rates to authenticated;
alter table public.tool_allowance_rates enable row level security;

create policy tool_allowance_rates_select_right on public.tool_allowance_rates
  for select to authenticated
  using (public.has_global_right('maintain_cost_registers') or public.has_global_right('view_cost_register_rates'));

create policy tool_allowance_rates_write_right on public.tool_allowance_rates
  for all to authenticated
  using (public.has_global_right('maintain_cost_registers'))
  with check (public.has_global_right('maintain_cost_registers'));

-- -----------------------------------------------------------------------------
-- 4. Materials — identity + effective_date-keyed rate history, same
--    correction as labour above.
-- -----------------------------------------------------------------------------
create table public.materials (
  id           uuid primary key default gen_random_uuid(),
  description  text not null,
  unit         text not null,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);

comment on table public.materials is
  'Asphalt mix, tack coat, primer, aggregate — description and unit only. '
  'Whether a given use was purchased fresh or drawn from stock is a fact '
  'about that specific consumption, not about the material generally, and '
  'belongs on whatever eventually consumes a material line — not here.';

grant select, insert, update on public.materials to authenticated;
alter table public.materials enable row level security;

create policy materials_select_authenticated on public.materials
  for select to authenticated using (true);

create policy materials_write_right on public.materials
  for all to authenticated
  using (public.has_global_right('maintain_cost_registers'))
  with check (public.has_global_right('maintain_cost_registers'));

create table public.material_rates (
  id              uuid primary key default gen_random_uuid(),
  material_id     uuid not null references public.materials(id) on delete cascade,
  rate            numeric not null check (rate >= 0),
  effective_date  date not null,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  unique (material_id, effective_date)
);

comment on table public.material_rates is
  'History, not a column on materials — same reasoning as labour_class_rates.';

grant select, insert, update on public.material_rates to authenticated;
alter table public.material_rates enable row level security;

create policy material_rates_select_right on public.material_rates
  for select to authenticated
  using (public.has_global_right('maintain_cost_registers') or public.has_global_right('view_cost_register_rates'));

create policy material_rates_write_right on public.material_rates
  for all to authenticated
  using (public.has_global_right('maintain_cost_registers'))
  with check (public.has_global_right('maintain_cost_registers'));

-- =============================================================================
-- VERIFY —
--
--   -- as a maintain_cost_registers holder, with no view_cost_register_rates:
--   insert into equipment (equipment_type, year, make, model)
--     values ('Excavator', 2019, 'Komatsu', 'PC210');
--   insert into equipment_rates (equipment_id, book_year, blue_book_rate, internal_rate)
--     values ('<equipment>', 2026, 145.00, 110.00);
--   -- expect: both succeed, and a select immediately after returns the row
--   -- (maintain implies read — no separate grant needed)
--
--   -- as a seat with NEITHER right:
--   select * from equipment;             -- expect: rows (open read)
--   select * from equipment_rates;       -- expect: empty
--   insert into labour_classes (...);    -- expect: rejected
--
--   -- as a view_cost_register_rates holder, no maintain_cost_registers:
--   select * from material_rates;        -- expect: rows
--   insert into material_rates (...);    -- expect: rejected
--
--   -- effective_date "as of" resolution (proven in rateHistory.test.ts, not
--   -- SQL — this migration only guarantees the rows exist to resolve from):
--   insert into labour_class_rates (labour_class_id, hourly_rate, effective_date)
--     values ('<class>', 42.00, '2024-01-01'), ('<class>', 45.50, '2026-01-01');
--   -- a caller asking "as of 2025-06-01" must resolve to 42.00, not 45.50
--   -- and not "whatever is latest" — see rateHistory.ts's own header
-- =============================================================================
