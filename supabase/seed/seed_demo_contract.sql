-- =============================================================================
-- NovaCore — Seed: DEMO contract, Hwy 97C Pennask Summit
--
-- ENTIRELY FICTIONAL. Contract number 26914-0000 does not exist. Every
-- quantity, Unit Price and cost is invented, though sized to be plausible for a
-- BC resurfacing contract of this scale.
--
-- Flagged is_sandbox = true, so it is excluded from any cross-contract rollup
-- and cannot contaminate company-wide figures.
--
-- PURPOSE: exercise every feature at once. Specifically it contains —
--   * all three Item kinds (unit_price, lump_sum, provisional_sum)
--   * Items at 0%, part-complete, near-complete, and one deliberately OVER
--     100% of Approximate Quantity
--   * two Items with no Unit Price, so partial-margin behaviour is visible
--   * one Item priced at a LOSS, so negative margin renders
--   * records in draft awaiting confirmation
--   * a correction chain: a confirmed record superseded by a DRAFT correction,
--     so the original keeps counting until the replacement is confirmed —
--     the behaviour that is otherwise invisible
--   * a second, fully-resolved correction chain
--   * single-station and from–to reach records
--   * a Lump Sum Item with percent_complete set
--   * a Provisional Sum Item with authorized_value below its provisional_sum
--   * contract_start/contract_end and planned_start/planned_end set, planned
--     CONTAINED within given (0016)
--   * two Jobs: Job A contained within the contract's planned range, Job B
--     deliberately extending past it — proving the containment rule is a
--     warning today, not a hard block (see 0016)
--   * one Item assigned to each Job (job_id set), the rest left unassigned
--     on a contract that DOES have Jobs — proving job_id is optional even
--     then
--
-- TO DELETE ENTIRELY:
--   delete from public.contracts where contract_no = '26914-0000';
--   (cascades to items, item_prices, quantity_records, contract_members, jobs)
--
-- Requires migrations through 0016. Idempotent.
-- =============================================================================

do $$
declare
  v_contract uuid;
  v_creator  uuid;
  r          record;
  v_rec_id   uuid;
begin

  select id into v_creator from public.profiles
  where create_projects = true order by created_at limit 1;

  if v_creator is null then
    raise exception 'No profile holds create_projects. Seat an account first.';
  end if;

  -- Rebuild from scratch each run so the demo state is reproducible.
  delete from public.contracts where contract_no = '26914-0000';

  -- Dates (0016) — DISCLOSED-FICTIONAL, same umbrella as the rest of this
  -- contract's invented figures (see SandboxBanner: "not a real contract").
  -- Illustrative, plausible for a BC paving season, and deliberately
  -- CONTAINED at the contract level (planned sits inside given) so the
  -- well-formed state has somewhere real to render.
  insert into public.contracts
    (contract_name, contract_no, created_by, is_sandbox,
     contract_start, contract_end, planned_start, planned_end)
  values
    ('Hwy 97C Pennask Summit Resurfacing', '26914-0000', v_creator, true,
     '2026-05-01', '2026-11-30', '2026-05-15', '2026-10-31')
  returning id into v_contract;

  insert into public.contract_members
    (contract_id, user_id, create_items, set_cost, set_unit_price,
     enter_quantity, correct_quantity, confirm_quantity, view_rates,
     extract_report, manage_schedule)
  values (v_contract, v_creator, true, true, true, true, true, true, true, true, true)
  on conflict (contract_id, user_id) do update set
    create_items = true, set_cost = true, set_unit_price = true,
    enter_quantity = true, correct_quantity = true, confirm_quantity = true,
    view_rates = true, extract_report = true, manage_schedule = true;

  -- Jobs (0016) — illustrative, not from any tender document (Hwy 97C has
  -- none; this whole contract is fictional). Job A sits INSIDE the
  -- contract's own planned_start/planned_end above. Job B is deliberately
  -- pushed past planned_end — proving, not just asserting, that a Job
  -- outside its contract's planned range is a WARNING today, not a write
  -- that gets rejected (see 0016's migration header).
  insert into public.jobs (contract_id, name, planned_start, planned_end)
  values
    (v_contract, 'Job A', '2026-05-15', '2026-07-31'),
    (v_contract, 'Job B', '2026-08-01', '2026-11-15')
  on conflict (contract_id, name) do update set
    planned_start = excluded.planned_start, planned_end = excluded.planned_end;

  -- ---------------------------------------------------------------------------
  -- Items
  -- ---------------------------------------------------------------------------
  insert into public.items
    (contract_id, item_number, description, unit, approximate_quantity,
     item_kind, provisional_sum, authorized_value, percent_complete,
     dfpa_category)
  values
    -- Lump Sum Items — paid on percentage complete (GC 52.03(b))
    (v_contract, '01.01', 'Mobilization', 'Lump Sum', 1, 'lump_sum', null, null, 100, null),
    (v_contract, '01.02', 'Quality Management', 'Lump Sum', 1, 'lump_sum', null, null, 45, null),
    (v_contract, '02.01', 'Traffic Management', 'Lump Sum', 1, 'lump_sum', null, null, 60, null),

    -- Provisional Sum Items — paid on value authorized in advance (GC 52.03(c))
    (v_contract, '01.03', 'Provisional Sum for Site Modifications', 'Provisional Sum', 1,
       'provisional_sum', 85000.00, 31200.00, null, null),
    (v_contract, '01.04', 'Diesel Fuel Price Adjustment', 'Provisional Sum', 1,
       'provisional_sum', 4000.00, 0.00, null, null),

    -- Unit Price Items
    (v_contract, '03.01.01', 'Asphalt Medium Mix Aggregate', 'Tonne', 21400, 'unit_price', null, null, null, '6'),
    (v_contract, '03.01.02', 'Shoulder Aggregate', 'Tonne', 3150, 'unit_price', null, null, null, null),
    (v_contract, '04.03', 'Pulverize Existing Roadway', 'Square Metre', 18600, 'unit_price', null, null, null, null),
    (v_contract, '04.04.01', 'Milled Tie-Ins', 'Square Metre', 1240, 'unit_price', null, null, null, null),
    (v_contract, '04.04.02', 'Cold Mill 50 mm', 'Square Metre', 96500, 'unit_price', null, null, null, '5b'),
    (v_contract, '04.05.04', 'Shouldering', 'Tonne', 3150, 'unit_price', null, null, null, '4'),
    (v_contract, '04.06.01', 'Remove and Dispose of Existing Barrier', 'Metre', 2140, 'unit_price', null, null, null, null),
    (v_contract, '04.06.03', 'Supply and Install New 690 mm H + E', 'Each', 428, 'unit_price', null, null, null, null),
    (v_contract, '04.07.02', 'Integral Asphalt Curb', 'Metre', 640, 'unit_price', null, null, null, null),
    (v_contract, '04.08.02', 'Apply Joint Sealant', 'Litre', 1980, 'unit_price', null, null, null, null),
    (v_contract, '05.02.02', 'Supply and Apply Tack Coat', 'Litre', 47200, 'unit_price', null, null, null, null),
    (v_contract, '05.03.01', 'Level Course', 'Tonne', 2260, 'unit_price', null, null, null, '7'),
    (v_contract, '05.03.03', 'Top Lift', 'Tonne', 14800, 'unit_price', null, null, null, '7'),
    (v_contract, '06.01', 'Supply and Install New Signs (Single Post)', 'Each', 14, 'unit_price', null, null, null, null);

  -- Item -> Job assignment (0016) — illustrative, same fictional umbrella as
  -- the Jobs themselves. 05.03.03 Top Lift under Job A deliberately echoes
  -- Hwy 5's real Job A Top Lift (05.03.03 there too) — the exact Item the
  -- brief that introduced Jobs points at for Table 502-H. Everything else
  -- stays unassigned (job_id null), demonstrating that a jobbed contract
  -- doesn't require every Item to have one.
  update public.items i
  set job_id = j.id
  from public.jobs j
  where i.contract_id = v_contract
    and j.contract_id = v_contract
    and (
      (j.name = 'Job A' and i.item_number = '05.03.03')
      or (j.name = 'Job B' and i.item_number = '04.06.01')
    );

  -- ---------------------------------------------------------------------------
  -- Unit Prices and costs
  --
  -- 04.07.02 is deliberately priced at a LOSS (cost above Unit Price) — curb
  -- work bid tight and gone wrong is entirely realistic, and it makes negative
  -- margin render.
  --
  -- 04.08.02 and 06.01 are deliberately LEFT UNPRICED, so the dashboard's
  -- partial-margin warning has something to report.
  -- ---------------------------------------------------------------------------
  insert into public.item_prices (item_id, contract_id, cost_price, unit_price)
  select i.id, i.contract_id, p.cost, p.sell
  from public.items i
  join (values
    ('01.01',    38000.00,  52000.00),
    ('01.02',    21000.00,  28500.00),
    ('02.01',    64000.00,  81000.00),
    ('01.03',        1.00,      1.00),   -- provisional: value carried on the Item
    ('01.04',        1.00,      1.00),
    ('03.01.01',    23.40,     29.85),
    ('03.01.02',    17.20,     21.90),
    ('04.03',        1.62,      2.15),
    ('04.04.01',     4.05,      5.60),
    ('04.04.02',     1.94,      2.48),
    ('04.05.04',    27.30,     34.75),
    ('04.06.01',    13.80,     18.40),
    ('04.06.03',    61.50,     79.00),
    ('04.07.02',    34.20,     29.75),   -- LOSS: cost exceeds Unit Price
    ('05.02.02',     0.96,      1.34),
    ('05.03.01',    97.40,    121.50),
    ('05.03.03',   101.20,    127.80)
    -- 04.08.02 and 06.01 intentionally absent
  ) as p(item_number, cost, sell) on p.item_number = i.item_number
  where i.contract_id = v_contract;

  -- ---------------------------------------------------------------------------
  -- Quantity records
  --
  -- Progress profile, deliberately uneven — milling ahead of paving, as it runs
  -- in reality:
  --   04.04.02 Cold Mill        ~78%
  --   04.03    Pulverize        ~92%
  --   05.03.03 Top Lift         ~34%
  --   05.03.01 Level Course     ~61%
  --   05.02.02 Tack Coat        ~41%
  --   03.01.01 Aggregate        ~55%
  --   04.06.01 Barrier removal  103%   <- OVER Approximate Quantity
  --   04.06.03 Barrier install  ~22%
  --   04.07.02 Curb (loss item) ~48%
  --   03.01.02, 04.04.01, 04.05.04 lightly started
  --   04.08.02, 06.01           no records at all
  -- ---------------------------------------------------------------------------
  for r in
    select * from (values
      -- item,     date,         qty,    loc,                 st_from, st_to,  status
      ('04.04.02','2026-06-08',  8400.0,'Reach 1 NB',           12.400, 12.980,'confirmed'),
      ('04.04.02','2026-06-09', 11200.0,'Reach 1 NB',           12.980, 13.760,'confirmed'),
      ('04.04.02','2026-06-11',  9750.0,'Reach 1 SB',           13.760, 14.420,'confirmed'),
      ('04.04.02','2026-06-15', 14300.0,'Reach 2 NB',           18.200, 19.180,'confirmed'),
      ('04.04.02','2026-06-16', 12850.0,'Reach 2 NB',           19.180, 20.060,'confirmed'),
      ('04.04.02','2026-06-22', 10400.0,'Reach 2 SB',           20.060, 20.780,'confirmed'),
      ('04.04.02','2026-07-06',  8900.0,'Reach 3 NB',           24.100, 24.720,'confirmed'),
      ('04.04.02','2026-07-14',  (9450.0),'Reach 3 SB',         24.720, 25.380,'draft'),

      ('04.03',   '2026-06-04',  6200.0,'Summit approach',       9.850, 10.640,'confirmed'),
      ('04.03',   '2026-06-05',  5900.0,'Summit approach',      10.640, 11.390,'confirmed'),
      ('04.03',   '2026-06-06',  5010.0,'Summit approach',      11.390, 12.040,'confirmed'),

      ('05.03.03','2026-07-20',  1180.0,'Reach 1 NB',           12.400, 12.910,'confirmed'),
      ('05.03.03','2026-07-21',  1340.0,'Reach 1 NB',           12.910, 13.480,'confirmed'),
      ('05.03.03','2026-07-27',  1265.0,'Reach 1 SB',           13.480, 14.020,'confirmed'),
      ('05.03.03','2026-07-28',  1240.0,'Reach 1 SB',           14.020, 14.560,'draft'),

      ('05.03.01','2026-07-13',   480.0,'Reach 1 NB',           12.400, 12.880,'confirmed'),
      ('05.03.01','2026-07-14',   512.0,'Reach 1 NB',           12.880, 13.400,'confirmed'),
      ('05.03.01','2026-07-16',   395.0,'Reach 1 SB',           13.400, 13.790,'confirmed'),

      ('05.02.02','2026-07-19',  6100.0,'Reach 1 NB',           12.400, 13.480,'confirmed'),
      ('05.02.02','2026-07-26',  5850.0,'Reach 1 SB',           13.480, 14.560,'confirmed'),
      ('05.02.02','2026-07-30',  7400.0,'Reach 2 NB',           18.200, 19.600,'confirmed'),

      ('03.01.01','2026-05-26',  4200.0,'Merritt pit',          null,   null,  'confirmed'),
      ('03.01.01','2026-06-02',  3850.0,'Merritt pit',          null,   null,  'confirmed'),
      ('03.01.01','2026-06-18',  2100.0,'Merritt pit',          null,   null,  'confirmed'),
      ('03.01.01','2026-07-07',  1620.0,'Merritt pit',          null,   null,  'draft'),

      -- OVER Approximate Quantity: 2140 tendered, 2205 removed
      ('04.06.01','2026-06-12',   820.0,'Reach 1',              12.400, 13.220,'confirmed'),
      ('04.06.01','2026-06-19',   745.0,'Reach 2',              18.200, 18.945,'confirmed'),
      ('04.06.01','2026-06-25',   640.0,'Reach 2',              18.945, 19.585,'confirmed'),

      ('04.06.03','2026-07-09',    58.0,'Reach 1',              12.400, 12.690,'confirmed'),
      ('04.06.03','2026-07-15',    36.0,'Reach 1',              12.690, 12.870,'draft'),

      ('04.07.02','2026-07-02',   180.0,'Summit turnout',       10.100, 10.280,'confirmed'),
      ('04.07.02','2026-07-03',   128.0,'Summit turnout',       10.280, 10.408,'confirmed'),

      ('03.01.02','2026-06-30',   410.0,'Merritt pit',          null,   null,  'confirmed'),
      ('04.04.01','2026-06-10',   186.0,'Reach 1 tie-in',       12.380, null,  'confirmed'),
      ('04.05.04','2026-07-29',   295.0,'Reach 1 NB',           12.400, 13.480,'draft')
    ) as t(item_number, work_date, qty, loc, st_from, st_to, status)
  loop
    insert into public.quantity_records
      (id, contract_id, item_id, work_date, location, quantity,
       station_from, station_to, status, created_by, device_id,
       confirmed_by, confirmed_at)
    select
      gen_random_uuid(), v_contract, i.id, r.work_date::date, r.loc, r.qty,
      r.st_from, r.st_to, r.status, v_creator, 'seed-demo',
      case when r.status = 'confirmed' then v_creator end,
      case when r.status = 'confirmed'
           then (r.work_date::date + interval '1 day') end
    from public.items i
    where i.contract_id = v_contract and i.item_number = r.item_number;
  end loop;

  -- ---------------------------------------------------------------------------
  -- Correction chain 1 — UNRESOLVED, and the reason it exists
  --
  -- A confirmed record of 1,180 t on 05.03.03 is superseded by a DRAFT
  -- correction of 1,094 t. Because supersession only takes effect on
  -- confirmation, the ORIGINAL 1,180 still counts toward Quantity to Date.
  --
  -- Confirm the correction in the UI and watch the total drop by 86 t. That is
  -- the whole point: quantity never sits in limbo during a measurement review.
  -- ---------------------------------------------------------------------------
  select r2.id into v_rec_id
  from public.quantity_records r2
  join public.items i on i.id = r2.item_id
  where r2.contract_id = v_contract
    and i.item_number = '05.03.03'
    and r2.work_date = '2026-07-20'
    and r2.status = 'confirmed'
  limit 1;

  insert into public.quantity_records
    (id, contract_id, item_id, work_date, location, quantity,
     station_from, station_to, status, supersedes, created_by, device_id, note)
  select gen_random_uuid(), v_contract, item_id, work_date, location, 1094.0,
         station_from, station_to, 'draft', v_rec_id, v_creator, 'seed-demo',
         'Re-measured after survey check — short by 86 t'
  from public.quantity_records where id = v_rec_id;

  -- ---------------------------------------------------------------------------
  -- Correction chain 2 — RESOLVED
  --
  -- The 6,200 record on 04.03 was corrected to 5,940 and the correction was
  -- confirmed, so the original is greyed out and no longer counts.
  -- ---------------------------------------------------------------------------
  select r2.id into v_rec_id
  from public.quantity_records r2
  join public.items i on i.id = r2.item_id
  where r2.contract_id = v_contract
    and i.item_number = '04.03'
    and r2.work_date = '2026-06-04'
    and r2.supersedes is null
  limit 1;

  insert into public.quantity_records
    (id, contract_id, item_id, work_date, location, quantity,
     station_from, station_to, status, supersedes, created_by, device_id,
     confirmed_by, confirmed_at, note)
  select gen_random_uuid(), v_contract, item_id, work_date, location, 5940.0,
         station_from, station_to, 'confirmed', v_rec_id, v_creator, 'seed-demo',
         v_creator, '2026-06-07'::timestamptz,
         'Corrected: 260 m² double-counted at the tie-in'
  from public.quantity_records where id = v_rec_id;

  raise notice 'Demo contract seeded: % Items, % records, % Jobs',
    (select count(*) from public.items where contract_id = v_contract),
    (select count(*) from public.quantity_records where contract_id = v_contract),
    (select count(*) from public.jobs where contract_id = v_contract);

end $$;

-- =============================================================================
-- WHAT TO LOOK FOR
--
-- 1. 04.06.01 shows OVER 100% — 2,205 of 2,140 m removed. On a unit price
--    contract that is unpaid work unless a change order exists.
-- 2. 04.07.02 Integral Asphalt Curb shows NEGATIVE margin. Priced at 29.75,
--    costing 34.20.
-- 3. 04.08.02 and 06.01 have no Unit Price, so the dashboard should say the
--    figures are partial rather than quietly treating them as zero.
-- 4. The three Lump Sum Items show percentage complete, not quantity.
-- 5. 01.03 shows 31,200 authorized of an 85,000 Provisional Sum. GC 47.01
--    permits no payment beyond what was authorized in advance.
-- 6. On 05.03.03, an unresolved correction sits in review. Quantity to Date
--    still includes the ORIGINAL 1,180 t. Confirm the correction and the total
--    drops by 86 t — nothing is ever in neither row.
-- 7. Several draft records across items — these do NOT count until confirmed.
-- 8. Job A (05.03.03) sits inside the contract's planned range; Job B
--    (04.06.01) deliberately runs past planned_end — insertable today
--    without rejection, proving the containment rule is a warning, not yet
--    a hard block (0016).
--
-- TO DELETE: delete from public.contracts where contract_no = '26914-0000';
-- =============================================================================
