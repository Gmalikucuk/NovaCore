-- =============================================================================
-- NovaCore — Seed: Contract 26607-0000, Hwy 5 Snowshed Hill
--
-- SOURCE: Schedule 7 "Approximate Quantities and Unit Prices", extracted
-- directly from the tender document package (Opportunity ID 26607MJ0000).
-- NOT from the Google Sheets tracker — that was an unverified transcription and
-- diffing the two showed real losses: all three Provisional Sum amounts and
-- every DFPA tag were missing from it.
--
-- NO UNIT PRICES. Schedule 7's price column is blank in the tender document —
-- those are the figures Keywest entered when bidding, and they are not in any
-- document available here. This contract will therefore show quantities and no
-- money until the priced bid file is obtained from estimating. That is correct
-- and honest; do not invent rates to fill the gap.
--
-- ONE DELIBERATE DEPARTURE FROM THE SOURCE: Item 04.07.02 reads "Itegral
-- Asphalt Curb" in Schedule 7 — a typo in the tender document. Seeded as
-- "Integral". Noted here because a line-by-line comparison against Schedule 7
-- will show a difference on that row.
--
-- Requires migrations through 0018.
-- Idempotent: safe to re-run.
-- =============================================================================

do $$
declare
  v_contract uuid;
  v_creator  uuid;
begin

  select id into v_creator
  from public.profiles
  where create_projects = true
  order by created_at
  limit 1;

  if v_creator is null then
    raise exception
      'No profile holds create_projects. Seat an account before seeding.';
  end if;

  select id into v_contract
  from public.contracts
  where contract_no = '26607-0000';

  if v_contract is null then
    insert into public.contracts
      (contract_name, contract_no, created_by, is_sandbox)
    values
      ('Hwy 5 Snowshed Hill', '26607-0000', v_creator, false)
    returning id into v_contract;
  end if;

  -- The enrolment trigger seats global owner/cfo profiles automatically. The
  -- creator is deliberately NOT auto-seated (0007), so seat them explicitly
  -- with every per-contract right.
  insert into public.contract_members
    (contract_id, user_id, create_items, set_cost, set_unit_price,
     enter_quantity, correct_quantity, confirm_quantity, view_rates,
     extract_report, manage_schedule, record_actual_cost)
  values
    (v_contract, v_creator, true, true, true, true, true, true, true, true, true, true)
  on conflict (contract_id, user_id) do update set
    create_items = true, set_cost = true, set_unit_price = true,
    enter_quantity = true, correct_quantity = true, confirm_quantity = true,
    view_rates = true, extract_report = true, manage_schedule = true,
    record_actual_cost = true;

  -- ---------------------------------------------------------------------------
  -- Jobs — A, B, C. Real (0016): several Items below are literally suffixed
  -- "Job A"/"Job B"/"Job C" in their own Schedule 7 description, e.g.
  -- 05.03.03 "Top Lift Job A" — the same Item the brief that introduced Jobs
  -- points at directly (Table 502-H's "Top Lift of Multiple Lifts" column
  -- applies to Job A's Top Lift and not the others').
  --
  -- No planned dates: Keywest's own start/end per Job is not in anything
  -- this file has seen, and is left null rather than invented — the exact
  -- same standing rule as this file's refusal to invent Unit Prices below.
  -- ---------------------------------------------------------------------------
  insert into public.jobs (contract_id, name) values
    (v_contract, 'Job A'),
    (v_contract, 'Job B'),
    (v_contract, 'Job C')
  on conflict (contract_id, name) do nothing;

  -- ---------------------------------------------------------------------------
  -- The 48 Items, in Schedule 7 order.
  --
  -- Note 04.05.06 appears after 04.05.04 in the source document, out of numeric
  -- sequence. Preserved as printed.
  --
  -- Columns: item_number, description, unit, approximate_quantity, item_kind,
  --          provisional_sum, dfpa_category
  -- ---------------------------------------------------------------------------
  insert into public.items
    (contract_id, item_number, description, unit, approximate_quantity,
     item_kind, provisional_sum, dfpa_category)
  values
    -- SECTION 1 — GENERAL
    (v_contract, '01.01', 'Mobilization', 'Lump Sum', 1, 'lump_sum', null, null),
    (v_contract, '01.02', 'Quality Management', 'Lump Sum', 1, 'lump_sum', null, null),
    (v_contract, '01.03', 'Provisional Sum for Site Modifications (Refer to SP 1.31)',
       'Provisional Sum', 1, 'provisional_sum', 150000.00, null),
    (v_contract, '01.04', 'Diesel Fuel Price Adjustment (Refer to SP 1.35)',
       'Provisional Sum', 1, 'provisional_sum', 5000.00, null),

    -- SECTION 2 — TRAFFIC MANAGEMENT
    (v_contract, '02.01', 'Traffic Management', 'Lump Sum', 1, 'lump_sum', null, null),

    -- SECTION 3 — SUPPLY AGGREGATE IN STOCKPILE
    (v_contract, '03.01.01', 'Asphalt Medium Mix Aggregate Job A', 'Tonne', 13000, 'unit_price', null, '6'),
    (v_contract, '03.01.02', 'Asphalt Medium Mix Aggregate Job B and C', 'Tonne', 67280, 'unit_price', null, '6'),
    (v_contract, '03.01.03', '25 mm Well Graded Base Course Aggregate', 'Tonne', 760, 'unit_price', null, null),
    (v_contract, '03.01.04', 'Shoulder Aggregate', 'Tonne', 7000, 'unit_price', null, null),

    -- SECTION 4 — CONSTRUCTION
    (v_contract, '04.01.01', 'Install C-035-x Project Signs', 'Each', 2, 'unit_price', null, null),
    (v_contract, '04.02', 'Pavement Markings', 'Lump Sum', 1, 'lump_sum', null, null),
    (v_contract, '04.03', 'Pulverize Existing Roadway Job A', 'Square Metre', 24150, 'unit_price', null, null),
    (v_contract, '04.04.01', 'Milled Tie-Ins', 'Square Metre', 2019, 'unit_price', null, null),
    (v_contract, '04.04.02', 'Cold Mill 50 mm - Job B', 'Square Metre', 354250, 'unit_price', null, '5b'),
    (v_contract, '04.04.03', 'Variable Depth Milling - Job A', 'Square Metre', 12100, 'unit_price', null, '5b'),
    (v_contract, '04.04.04', 'Cold Mill 100mm Depth - Job A', 'Square Metre', 21930, 'unit_price', null, '5d'),
    (v_contract, '04.04.05', 'Cold Mill 150 mm Depth - Job A', 'Square Metre', 1310, 'unit_price', null, '5e'),
    (v_contract, '04.05.01', 'Type D Excavation Job A', 'Cubic Metre', 1760, 'unit_price', null, '3'),
    (v_contract, '04.05.02', 'Construct 25 mm Well Graded Base Course Job A', 'Tonne', 760, 'unit_price', null, '4'),
    (v_contract, '04.05.03', 'Base Preparation Job A', 'Square Metre', 24150, 'unit_price', null, null),
    (v_contract, '04.05.04', 'Shouldering', 'Tonne', 7000, 'unit_price', null, '4'),
    (v_contract, '04.05.06', 'Cold Mill 200 mm Depth - Job A', 'Square Metre', 920, 'unit_price', null, '5e'),
    (v_contract, '04.06.01', 'Remove and Dispose of Existing Barrier', 'Metre', 5992, 'unit_price', null, null),
    (v_contract, '04.06.02', 'Remove, Stockpile and Replace Existing Barrier', 'Metre', 16312, 'unit_price', null, null),
    (v_contract, '04.06.03', 'Supply and Install New 690 mm H + E', 'Each', 1302, 'unit_price', null, null),
    (v_contract, '04.06.04', 'Supply and Install New CMB H + E Job A', 'Each', 1029, 'unit_price', null, null),
    (v_contract, '04.06.05', 'Supply and Stockpile New CMB H+ E', 'Each', 268, 'unit_price', null, null),
    (v_contract, '04.06.06', 'Supply and Install New CDB', 'Each', 52, 'unit_price', null, null),
    (v_contract, '04.06.07', 'Supply and Install New CTB-1E', 'Each', 10, 'unit_price', null, null),
    (v_contract, '04.06.08', 'Supply and Stockpile New CTB-2H Job A', 'Each', 1, 'unit_price', null, null),
    (v_contract, '04.06.09', 'Supply and Install New CBN-H', 'Each', 10, 'unit_price', null, null),
    (v_contract, '04.06.10', 'Supply and Install Barrier Reflectors', 'Each', 1050, 'unit_price', null, null),
    (v_contract, '04.07.01', 'Remove and Dispose of Asphalt Curb', 'Metre', 1885, 'unit_price', null, null),
    -- Schedule 7 prints "Itegral"; corrected here by instruction.
    (v_contract, '04.07.02', 'Integral Asphalt Curb', 'Metre', 1885, 'unit_price', null, null),
    (v_contract, '04.07.03', 'Asphalt Spillways', 'Each', 87, 'unit_price', null, null),
    (v_contract, '04.07.04', 'Asphalt Spillways with Riprap Outfall', 'Each', 43, 'unit_price', null, null),
    (v_contract, '04.07.05', 'Pipe Outfall', 'Metre', 2565, 'unit_price', null, null),
    (v_contract, '04.08.01', 'Supply Joint Sealant', 'Litre', 4020, 'unit_price', null, null),
    (v_contract, '04.08.02', 'Apply Joint Sealant', 'Litre', 5360, 'unit_price', null, null),

    -- SECTION 5 — PAVING
    (v_contract, '05.01', 'EPS Payment Adjustments SS 502 EPS (Refer to SP 05.01.01)',
       'Provisional Sum', 1, 'provisional_sum', 572000.00, null),
    (v_contract, '05.02.01', 'Supply and Apply Emulsified Penetrating Primer', 'Litre', 40090, 'unit_price', null, null),
    (v_contract, '05.02.02', 'Supply and Apply Tack Coat', 'Litre', 155000, 'unit_price', null, null),
    (v_contract, '05.03.01', 'Level Course', 'Tonne', 5500, 'unit_price', null, '7'),
    (v_contract, '05.03.02', 'Bottom and Intermediate Lifts Job A', 'Tonne', 7690, 'unit_price', null, '7'),
    (v_contract, '05.03.03', 'Top Lift Job A', 'Tonne', 4600, 'unit_price', null, '7'),
    (v_contract, '05.03.04', 'Top Lift Job B', 'Tonne', 45900, 'unit_price', null, '7'),
    (v_contract, '05.03.05', 'Top Lift Job C', 'Tonne', 16590, 'unit_price', null, '7'),

    -- SECTION 6 — SIGNING
    (v_contract, '06.01', 'Supply and Install New Signs (Single Post)', 'Each', 1, 'unit_price', null, null)

  on conflict (contract_id, item_number) do update set
    description          = excluded.description,
    unit                 = excluded.unit,
    approximate_quantity = excluded.approximate_quantity,
    item_kind            = excluded.item_kind,
    provisional_sum      = excluded.provisional_sum,
    dfpa_category        = excluded.dfpa_category;

  -- ---------------------------------------------------------------------------
  -- Item -> Job assignment (0016)
  --
  -- Derived from the "Job A/B/C" suffix already present in each Item's own
  -- Schedule 7 description above — read off the source text, not guessed.
  -- An Item with no such suffix is shared across Jobs, or Schedule 7 simply
  -- doesn't split it by Job, and is deliberately left unassigned (job_id
  -- null) rather than forced onto one — see 0016's own migration header for
  -- why "every Item gets a job_id the moment the contract has any" was
  -- rejected as an invariant.
  --
  -- 03.01.02 "Asphalt Medium Mix Aggregate Job B and C" is the one real gap
  -- this surfaces: Schedule 7 states it covers TWO Jobs, and this schema
  -- carries exactly one job_id per Item. Left unassigned rather than
  -- silently picked as B or C — a wrong single answer would be worse than
  -- no answer. Splitting that one Schedule 7 line into two Items so each
  -- half could carry its own Job is a real, deliberate change for whoever
  -- owns Schedule 7 data entry, not something to do silently in a seed
  -- script.
  --
  -- RE-CHECKED against the Special Provisions, which list 18 Item-Job
  -- designations (17 distinct Items — 03.01.02 alone carries two, Job B
  -- and Job C). The first pass here hand-typed the item_number list below
  -- and silently dropped two real matches: 04.06.04 "Supply and Install
  -- New CMB H + E Job A" and 04.06.08 "Supply and Stockpile New CTB-2H Job
  -- A" — both say "Job A" as plainly as every other line in this list, just
  -- missed transcribing the first time. Re-verified exhaustively this time
  -- via `description ilike '%job%'` against the live table rather than
  -- eyeballing the source list again — 17 Items match, exactly the
  -- Special Provisions' count once 03.01.02's double designation is
  -- accounted for. No Item is assigned a Job whose description doesn't
  -- state one.
  -- ---------------------------------------------------------------------------
  update public.items i
  set job_id = j.id
  from public.jobs j
  where i.contract_id = v_contract
    and j.contract_id = v_contract
    and (
      (j.name = 'Job A' and i.item_number in (
        '03.01.01', '04.03', '04.04.03', '04.04.04', '04.04.05', '04.05.01',
        '04.05.02', '04.05.03', '04.05.06', '04.06.04', '04.06.08',
        '05.03.02', '05.03.03'))
      or (j.name = 'Job B' and i.item_number in ('04.04.02', '05.03.04'))
      or (j.name = 'Job C' and i.item_number in ('05.03.05'))
    );

  raise notice 'Hwy 5 Snowshed Hill seeded: % Items, % Jobs, % Items assigned to a Job',
    (select count(*) from public.items where contract_id = v_contract),
    (select count(*) from public.jobs where contract_id = v_contract),
    (select count(*) from public.items where contract_id = v_contract and job_id is not null);

end $$;

-- =============================================================================
-- VERIFY
--
--   select count(*) from items i join contracts c on c.id = i.contract_id
--   where c.contract_no = '26607-0000';                       -- expect 48
--
--   select name from jobs j join contracts c on c.id = j.contract_id
--   where c.contract_no = '26607-0000' order by name;          -- expect A, B, C
--
--   select count(*) from items i join contracts c on c.id = i.contract_id
--   where c.contract_no = '26607-0000' and job_id is not null; -- expect 16
--
--   select item_kind, count(*) from items i
--   join contracts c on c.id = i.contract_id
--   where c.contract_no = '26607-0000' group by item_kind;
--   -- expect: unit_price 41, lump_sum 4, provisional_sum 3
--
--   select item_number, provisional_sum from items i
--   join contracts c on c.id = i.contract_id
--   where c.contract_no = '26607-0000' and provisional_sum is not null;
--   -- expect: 01.03 = 150000, 01.04 = 5000, 05.01 = 572000
--
--   select dfpa_category, count(*) from items i
--   join contracts c on c.id = i.contract_id
--   where c.contract_no = '26607-0000' and dfpa_category is not null
--   group by dfpa_category;                                   -- expect 15 total
--   -- categories: 3 (x1), 4 (x2), 5b (x2), 5d (x1), 5e (x2), 6 (x2), 7 (x5)
--
-- NO item_prices rows are created. Unit Prices come from the priced bid file.
-- =============================================================================
