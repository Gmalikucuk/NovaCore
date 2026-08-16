-- =============================================================================
-- NovaCore v1 — Migration: Daily Work Reports (Force Account claims)
--
-- WHAT THIS IS
--
-- A DWR (Ministry form H0358, "Extra Work and Provisional Sum Items — Daily
-- Work Report") is Keywest's substantiation for force-account work under GC
-- 49.00 — six blocks (Labour/Equipment/Materials/Prep/Food/Invoiced), each
-- with a subtotal and a markup, contractor and subcontractor amounts running
-- to a TOTAL PAYABLE. Built from reading the actual template (a blank .xlsx
-- and a filled real example, both supplied directly, plus a second filled
-- PDF example) rather than a prose description — see the investigation this
-- migration follows for what that reading found.
--
-- THE FINDING THAT SHAPES THIS SCHEMA
--
-- The brief that kicked this off assumed GC 49.00's markup percentages were
-- fixed. They are not, provably: two real DWR files, from two different
-- contracts, carry different REDUCED markup percentages baked into their own
-- named ranges (one shows Labour reduced at 18.75%/Equipment reduced at 0%;
-- Hwy 5's own Amendment 2 sets 20%/10%). Base percentages (30/15/15/15/15,
-- 10% subcontractor markup) matched across both samples — consistent with
-- GC 49.00 being a province-wide clause — but the reduced figures did not,
-- because each contract's own SGC/Amendment sets its own reduction. That is
-- exactly why every DWR carries a "General Conditions version date" field.
-- So contract_force_account_terms below is contract-scoped and
-- effective_date-keyed, resolved via the SAME asOfDate discipline as the
-- rest of the cost registers (rateHistory.ts) against the DWR's own
-- work_date — never assumed stable, never read as "today's" figure.
--
-- WHAT IS NOT MODELLED, ON PURPOSE
--
-- The blank template's named ranges include DWR_Maximum = 50000. Neither
-- Mehmet nor the user knows what this figure is for (a negotiated-price
-- escalation cap? something else?) as of this migration. It is not modelled
-- here — this comment exists so whoever finds that named range later, or
-- wonders why Block F has no cap, knows it was seen and deliberately left
-- alone rather than missed.
--
-- SIX BLOCKS, ONE LINE-ITEM SHAPE
--
-- Blocks A-E build a claim up from hours/quantity x rate; Block F
-- ("Invoiced Work — Negotiated Price and Credits") is different in kind, not
-- degree — confirmed by reading the actual formulas, not just the block's
-- own note. The real workbook's J98 (a Block F line's amount) is `=H98`,
-- the unit price entered directly — no rate x markup build-up — and the
-- "basic markup 10%" cell sitting beside it is wired into nothing when the
-- line is the Contractor's own negotiated work (Sub? = n): the note "*Basic
-- mark-up is zero (n/a) on negotiated price Work done by the Contractor*"
-- is literally true of the spreadsheet's wiring, not just a comment. Those
-- cells are vestigial for the one case they DO apply to — a subcontractor's
-- own negotiated price, which still carries GC 49.03(f)(iii)'s 10%
-- subcontractor markup on top. One polymorphic line_items table (a `block`
-- discriminator) covers all six; the markup RULE per block, including
-- Block F's conditional, is resolved in the app calculation layer against
-- contract_force_account_terms — not stored here, not computed in SQL. See
-- dwrCalculations.ts.
--
-- Block subtotals and resolved markup AMOUNTS are deliberately not stored —
-- derived from line items + contract_force_account_terms.asOfDate(work_date)
-- in the app layer, same non-stored-derivation posture as
-- v_item_actual_cost's cost_variance (0018). Storing them would create a
-- second source of truth that can drift from the terms table whenever a
-- contract's own terms are corrected.
--
-- DRAFT / CERTIFIED, NOT APPEND-ONLY — A DELIBERATE DEPARTURE
--
-- actual_cost_entries (0018) and quantity_records are both append-only:
-- correction is a new row, never an edit in place, because each is a claim
-- the moment it is written. A DWR is different — it is a document annotated
-- over its life by three different parties (Contractor fills it, Contractor
-- certifies it, the Ministry accepts it twice, separately, for tracking
-- input resources and for payment), the same way the physical paper form
-- gets signed in stages. So: draft is freely editable (same shape as
-- quantity_records pre-0021's confirmed/draft split), certification (a new
-- SECURITY DEFINER RPC, certify_daily_work_report) locks the claim's
-- substance — work_date, description_of_work, gc_version_date,
-- reduced_markups, and every line item/subcontractor row — and
-- reopen_daily_work_report() is the explicit, audited way back, not a plain
-- UPDATE. force_account_number, ps_item_number, item_id, and both Ministry
-- acceptance fields stay editable regardless of certification status — they
-- are filled in AFTER Keywest's own certification, off a form the Ministry
-- returns, not part of what Keywest is certifying.
--
-- No version-witnessed-confirm RPC (0022's pattern) here: certifying a DWR
-- is a one-page review-and-sign action against what is on screen at that
-- moment, not a queue-confirm across rows fetched earlier — the race 0022
-- exists to close does not have the same shape here. Noted as a deliberate
-- scope decision, not an oversight.
--
-- THE RIGHT
--
-- New: contract_members.record_force_account. Considered and rejected:
--   record_actual_cost  Keywest's own internal costing ledger — a DWR is a
--                       Ministry-facing claim document with a different
--                       structure, a different audience, and real legal
--                       weight as payment evidence.
--   prepare_claims      the Progress Estimate/claims-to-Ministry right — a
--                       DWR is the underlying force-account substantiation,
--                       plausibly filled by site staff who never touch a
--                       progress-estimate claim.
--   confirm_quantity / set_cost   unrelated domains.
--
-- record_force_account does NOT imply view_cost_register_rates (a separate,
-- COMPANY-WIDE right, has_global_right not has_right) even though a DWR
-- line's rate IS a register rate and someone entering DWRs plainly needs to
-- see one — per the user's own call: "Two explicit grants is clearer than
-- one right quietly implying another across domains." Enforced, not just
-- documented: daily_work_report_line_items' write policy below requires
-- BOTH has_right(contract_id, 'record_force_account') AND
-- has_global_right('view_cost_register_rates') together. The header and
-- subcontractor list carry no rate figures, so their own write policies
-- require record_force_account alone.
--
-- Certification is not split into its own right for now (anyone who can
-- enter a DWR may also certify it) — revisit if practice shows a PM-only
-- certify step is actually needed.
--
-- THE TWO THRESHOLD QUESTIONS — compute and surface, never enforce, in both
-- cases, decided in the app layer (dwrCalculations.ts), not in SQL:
--
--   reduced_markups (the 25%-of-Tender-Price trigger) is pre-filled by
--   NovaCore from a computed cumulative-vs-threshold check, editable, never
--   locked, never blocking submission — a stronger move than a passive
--   number on screen, because both real DWR samples show this as a
--   hand-typed flag today: the actual failure mode is FORGETTING to flip it
--   once the threshold is crossed, not disagreeing with a number. A
--   pre-filled, overridable checkbox converts a noticing problem into a
--   confirming problem. Never enforced outright: NovaCore's own cumulative
--   total is only ever as complete as what has been entered into it, and
--   GC 49.04's own wording ("per GC provisions") leaves room for negotiated
--   exceptions a flat threshold check cannot see.
--
--   The $100,000 per-subcontractor cap (GC 49.03(f)(iii)) gets the same
--   compute-and-surface treatment, with a real dependency the first
--   question doesn't have: it needs to know WHICH subcontractor did a
--   subcontractor-flagged line, which the source template itself does not
--   structurally capture beyond a header list of up to four names.
--   daily_work_report_line_items.subcontractor_id exists so this becomes
--   computable going forward; the figure must be shown as INCOMPLETE
--   wherever lines are unattributed, in the UI, plainly — an incomplete
--   total presented as complete is worse than no total.
--
-- Requires migrations through 20260816150000.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The right
-- -----------------------------------------------------------------------------
alter table public.contract_members
  add column record_force_account boolean not null default false;

comment on column public.contract_members.record_force_account is
  'Enter, edit, certify, and reopen Daily Work Reports (Force Account '
  'claims, GC 49.00) on this contract. Does NOT imply '
  'view_cost_register_rates (company-wide, has_global_right) even though a '
  'DWR line''s rate is a register rate — both must be granted together for '
  'someone to actually fill a line in. Enforced on '
  'daily_work_report_line_items'' write policy, not just documented here.';

grant update (record_force_account) on public.contract_members to authenticated;

-- -----------------------------------------------------------------------------
-- 2. contract_force_account_terms — the finding above, as schema. One row
--    per contract per GC/SGC edition change, resolved by asOfDate(work_date)
--    exactly like equipment_rates/labour_class_rates.
-- -----------------------------------------------------------------------------
create table public.contract_force_account_terms (
  id                          uuid primary key default gen_random_uuid(),
  contract_id                 uuid not null references public.contracts(id) on delete cascade,
  effective_date              date not null,
  gc_version_date             date not null,
  labour_basic_pct            numeric not null check (labour_basic_pct >= 0),
  labour_reduced_pct          numeric not null check (labour_reduced_pct >= 0),
  equipment_basic_pct         numeric not null check (equipment_basic_pct >= 0),
  equipment_reduced_pct       numeric not null check (equipment_reduced_pct >= 0),
  materials_basic_pct         numeric not null check (materials_basic_pct >= 0),
  materials_reduced_pct       numeric not null check (materials_reduced_pct >= 0),
  prep_basic_pct              numeric not null check (prep_basic_pct >= 0),
  prep_reduced_pct            numeric not null check (prep_reduced_pct >= 0),
  food_basic_pct              numeric not null check (food_basic_pct >= 0),
  food_reduced_pct            numeric not null check (food_reduced_pct >= 0),
  subcontractor_markup_pct    numeric not null check (subcontractor_markup_pct >= 0),
  reduced_threshold_pct       numeric not null default 0.25 check (reduced_threshold_pct >= 0),
  subcontractor_cap_amount    numeric not null default 100000 check (subcontractor_cap_amount >= 0),
  created_by                  uuid references public.profiles(id),
  created_at                  timestamptz not null default now(),
  unique (contract_id, effective_date)
);

comment on table public.contract_force_account_terms is
  'GC 49.00''s markup percentages as THIS CONTRACT''S own GC/SGC package '
  'actually sets them, at a point in time — proven contract-specific, not '
  'province-wide, by reading two real DWRs from two different contracts '
  'with different reduced-markup figures. Resolved via asOfDate(work_date), '
  'same discipline as every other cost register history table — a DWR '
  'reads the terms current as at ITS work date, never today''s. '
  'reduced_threshold_pct (GC 49.04-49.05''s 25%-of-Tender-Price trigger) '
  'and subcontractor_cap_amount (GC 49.03(f)(iii)''s $100,000 cap) default '
  'to the GC''s own current published figures but are per-contract in case '
  'a future SGC amends either.';

grant select, insert, update on public.contract_force_account_terms to authenticated;
alter table public.contract_force_account_terms enable row level security;

create policy contract_force_account_terms_select_right on public.contract_force_account_terms
  for select to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    or public.has_global_right('view_cost_register_rates')
  );

create policy contract_force_account_terms_write_right on public.contract_force_account_terms
  for all to authenticated
  using (public.has_right(contract_id, 'record_force_account'))
  with check (public.has_right(contract_id, 'record_force_account'));

-- -----------------------------------------------------------------------------
-- 3. daily_work_reports — the header
-- -----------------------------------------------------------------------------
create table public.daily_work_reports (
  id                            uuid primary key default gen_random_uuid(),
  contract_id                   uuid not null references public.contracts(id) on delete cascade,
  dwr_number                    integer not null,
  item_id                       uuid,
  force_account_number          text,
  ps_item_number                text,
  work_date                     date not null,
  description_of_work           text not null,
  gc_version_date                date not null,
  reduced_markups               boolean not null default false,
  certified_by                  uuid references public.profiles(id),
  certified_at                  timestamptz,
  ministry_tracking_accepted_by text,
  ministry_tracking_accepted_at timestamptz,
  ministry_payment_accepted_by  text,
  ministry_payment_accepted_at  timestamptz,
  created_by                    uuid not null references public.profiles(id) default auth.uid(),
  created_at                    timestamptz not null default now(),

  foreign key (item_id, contract_id) references public.items (id, contract_id),

  constraint daily_work_reports_certified_coherent check (
    (certified_at is null and certified_by is null)
    or (certified_at is not null and certified_by is not null)
  ),

  unique (contract_id, dwr_number),
  unique (id, contract_id)
);

comment on table public.daily_work_reports is
  'One row per Ministry form H0358 (Extra Work and Provisional Sum Items — '
  'Daily Work Report). item_id is nullable — force-account work does not '
  'always map to an existing Item. dwr_number is assigned by '
  'assign_dwr_number(), sequential per contract, never client-set. '
  'certified_by/certified_at are set only by certify_daily_work_report() — '
  'no plain UPDATE grant exists on either column. force_account_number/ '
  'ps_item_number/item_id/the two ministry_*_accepted_* pairs remain '
  'editable regardless of certification status, since the Ministry fills '
  'some of these in AFTER Keywest certifies, off a returned signed copy.';

create index daily_work_reports_contract_date_idx on public.daily_work_reports (contract_id, work_date);

grant select on public.daily_work_reports to authenticated;
grant insert (contract_id, item_id, force_account_number, ps_item_number, work_date,
              description_of_work, gc_version_date, reduced_markups, created_by)
  on public.daily_work_reports to authenticated;
grant update (item_id, force_account_number, ps_item_number, work_date, description_of_work,
              gc_version_date, reduced_markups, ministry_tracking_accepted_by,
              ministry_tracking_accepted_at, ministry_payment_accepted_by,
              ministry_payment_accepted_at)
  on public.daily_work_reports to authenticated;

alter table public.daily_work_reports enable row level security;

create policy daily_work_reports_select_right on public.daily_work_reports
  for select to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    or public.has_global_right('view_cost_register_rates')
  );

create policy daily_work_reports_insert_right on public.daily_work_reports
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.has_right(contract_id, 'record_force_account')
  );

create policy daily_work_reports_update_right on public.daily_work_reports
  for update to authenticated
  using (public.has_right(contract_id, 'record_force_account'))
  with check (public.has_right(contract_id, 'record_force_account'));

-- dwr_number — assigned server-side, sequential per contract. Never granted
-- to `authenticated` above, so a client cannot set or overwrite it; a
-- BEFORE INSERT trigger's column writes are not subject to the invoking
-- role's column grants.
create or replace function public.assign_dwr_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(max(dwr_number), 0) + 1 into new.dwr_number
  from public.daily_work_reports
  where contract_id = new.contract_id;
  return new;
end;
$$;

create trigger daily_work_reports_assign_number
  before insert on public.daily_work_reports
  for each row execute function public.assign_dwr_number();

-- Certified lock — work_date/description_of_work/gc_version_date/
-- reduced_markups are the claim's substance and freeze once certified.
-- contract_id/dwr_number/created_by are identity, immutable regardless.
create or replace function public.guard_dwr_certified_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if row(new.contract_id, new.dwr_number, new.created_by)
     is distinct from
     row(old.contract_id, old.dwr_number, old.created_by)
  then
    raise exception
      'daily_work_reports identity columns (contract_id, dwr_number, created_by) are immutable';
  end if;

  if old.certified_at is not null
     and row(new.work_date, new.description_of_work, new.gc_version_date, new.reduced_markups)
       is distinct from
       row(old.work_date, old.description_of_work, old.gc_version_date, old.reduced_markups)
  then
    raise exception
      'daily_work_reports work_date/description_of_work/gc_version_date/reduced_markups '
      'are locked once certified; call reopen_daily_work_report() first';
  end if;

  return new;
end;
$$;

create trigger daily_work_reports_certified_lock
  before update on public.daily_work_reports
  for each row execute function public.guard_dwr_certified_lock();

-- certify / reopen — the only doors to certified_at/certified_by. Same
-- SECURITY DEFINER + explicit is_member()/has_right() shape as
-- confirm_quantity_record (0022): RLS is bypassed, so every check is
-- re-stated here rather than assumed.
create or replace function public.certify_daily_work_report(p_id uuid)
returns public.daily_work_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_id uuid;
  result        public.daily_work_reports;
begin
  select contract_id into v_contract_id from public.daily_work_reports where id = p_id;

  if v_contract_id is null then
    raise exception 'not-found: no such daily_work_report';
  end if;

  if not public.is_member(v_contract_id) then
    raise exception 'not-found: no such daily_work_report';
  end if;

  if not public.has_right(v_contract_id, 'record_force_account') then
    raise exception 'not-permitted: record_force_account right required';
  end if;

  update public.daily_work_reports
  set certified_by = auth.uid(), certified_at = now()
  where id = p_id and certified_at is null
  returning * into result;

  if found then
    return result;
  end if;

  raise exception 'already-certified: this DWR has already been certified';
end;
$$;

comment on function public.certify_daily_work_report(uuid) is
  'The only way certified_at/certified_by may be set. Locks the claim''s '
  'substance (see guard_dwr_certified_lock()) and every line item/'
  'subcontractor row on this DWR (see their own write policies). '
  'reopen_daily_work_report() is the only way back.';

revoke execute on function public.certify_daily_work_report(uuid) from public;
grant execute on function public.certify_daily_work_report(uuid) to authenticated;

create or replace function public.reopen_daily_work_report(p_id uuid)
returns public.daily_work_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_id uuid;
  result        public.daily_work_reports;
begin
  select contract_id into v_contract_id from public.daily_work_reports where id = p_id;

  if v_contract_id is null then
    raise exception 'not-found: no such daily_work_report';
  end if;

  if not public.is_member(v_contract_id) then
    raise exception 'not-found: no such daily_work_report';
  end if;

  if not public.has_right(v_contract_id, 'record_force_account') then
    raise exception 'not-permitted: record_force_account right required';
  end if;

  update public.daily_work_reports
  set certified_by = null, certified_at = null
  where id = p_id and certified_at is not null
  returning * into result;

  if found then
    return result;
  end if;

  raise exception 'not-certified: this DWR is not currently certified';
end;
$$;

comment on function public.reopen_daily_work_report(uuid) is
  'Clears certified_at/certified_by, unlocking header substance fields and '
  'every line item/subcontractor row for editing again. A DWR is annotated '
  'over its life, not an append-only ledger — deliberate departure from '
  'actual_cost_entries/quantity_records'' no-reopen posture (see this '
  'migration''s header). No guard beyond record_force_account for now (e.g. '
  'blocking reopen after Ministry acceptance) — revisit if practice shows '
  'it is needed.';

revoke execute on function public.reopen_daily_work_report(uuid) from public;
grant execute on function public.reopen_daily_work_report(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. daily_work_report_subcontractors — a plain name list (the template
--    caps this at four lettered slots, A-D; that reads as sheet-layout
--    convenience, not a real limit, so this is an ordinary child table
--    instead). No rate-bearing data, so write is gated on
--    record_force_account alone, no view_cost_register_rates requirement.
-- -----------------------------------------------------------------------------
create table public.daily_work_report_subcontractors (
  id           uuid primary key default gen_random_uuid(),
  dwr_id       uuid not null,
  contract_id  uuid not null,
  name         text not null,
  created_at   timestamptz not null default now(),

  foreign key (dwr_id, contract_id) references public.daily_work_reports (id, contract_id) on delete cascade,
  unique (id, dwr_id)
);

comment on table public.daily_work_report_subcontractors is
  'Named subcontractors on one DWR (the template''s header slots A-D). No '
  'line item ties to a specific one beyond a plain sub_flag y/n/a UNLESS '
  'daily_work_report_line_items.subcontractor_id is also set — see that '
  'table''s comment for why the $100,000 cap needs it and the source '
  'template doesn''t provide it.';

grant select, insert, update, delete on public.daily_work_report_subcontractors to authenticated;
alter table public.daily_work_report_subcontractors enable row level security;

create policy daily_work_report_subcontractors_select_right on public.daily_work_report_subcontractors
  for select to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    or public.has_global_right('view_cost_register_rates')
  );

create policy daily_work_report_subcontractors_write_right on public.daily_work_report_subcontractors
  for all to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    and exists (
      select 1 from public.daily_work_reports d
      where d.id = dwr_id and d.certified_at is null
    )
  )
  with check (
    public.has_right(contract_id, 'record_force_account')
    and exists (
      select 1 from public.daily_work_reports d
      where d.id = dwr_id and d.certified_at is null
    )
  );

-- -----------------------------------------------------------------------------
-- 5. daily_work_report_line_items — one polymorphic table for all six
--    blocks (A-F), a `block` discriminator rather than six near-identical
--    tables. rate/amount are frozen at entry time (prefilled from the cost
--    registers' asOfDate(work_date), then stored independently) since a DWR
--    line is evidence for a payment claim — it must not drift if the
--    register rate is corrected later. amount is signed, NOT constrained
--    >= 0: Block F is explicitly "Negotiated Price and Credits" in the
--    Ministry's own template, and a credit is a negative amount, same
--    reasoning as actual_cost_entries.
-- -----------------------------------------------------------------------------
create table public.daily_work_report_line_items (
  id                    uuid primary key default gen_random_uuid(),
  dwr_id                uuid not null,
  contract_id           uuid not null,
  block                 text not null check (block in ('A', 'B', 'C', 'D', 'E', 'F')),
  sub_flag              text not null check (sub_flag in ('y', 'n', 'a')),
  subcontractor_id      uuid,
  descriptor            text not null,
  secondary_descriptor  text,
  quantity              numeric not null check (quantity >= 0),
  rate                  numeric not null check (rate >= 0),
  amount                numeric not null,
  equipment_id          uuid references public.equipment(id),
  labour_class_id       uuid references public.labour_classes(id),
  material_id           uuid references public.materials(id),
  created_by            uuid not null references public.profiles(id) default auth.uid(),
  created_at            timestamptz not null default now(),

  foreign key (dwr_id, contract_id) references public.daily_work_reports (id, contract_id) on delete cascade,
  foreign key (subcontractor_id, dwr_id) references public.daily_work_report_subcontractors (id, dwr_id)
);

comment on table public.daily_work_report_line_items is
  'One row per line across all six DWR blocks (A Labour, B Equipment, '
  'C Materials, D Preparatory work, E Food & Lodging, F Invoiced/negotiated '
  '— see migration header for why F is structurally different, not just '
  'differently labelled). descriptor/secondary_descriptor hold whatever the '
  'block''s own columns are (Name+Class, Type+Year/Make-Model, or plain '
  'Description). subcontractor_id is nullable and usually null even when '
  'sub_flag = ''y'' — the source template itself never ties a line to a '
  'named subcontractor, only a header list of up to four names. Populate it '
  'when known so the $100,000 subcontractor cap (GC 49.03(f)(iii)) is '
  'computable; treat any total built from this column as INCOMPLETE, and '
  'say so on screen, wherever lines exist without it.';

create index daily_work_report_line_items_dwr_idx on public.daily_work_report_line_items (dwr_id);

grant select, insert, update, delete on public.daily_work_report_line_items to authenticated;
alter table public.daily_work_report_line_items enable row level security;

create policy daily_work_report_line_items_select_right on public.daily_work_report_line_items
  for select to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    or public.has_global_right('view_cost_register_rates')
  );

-- Both rights required, enforced here (not just documented) — a DWR line's
-- rate is a register rate, per the user's own call in this migration's
-- header.
create policy daily_work_report_line_items_write_right on public.daily_work_report_line_items
  for all to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    and public.has_global_right('view_cost_register_rates')
    and exists (
      select 1 from public.daily_work_reports d
      where d.id = dwr_id and d.certified_at is null
    )
  )
  with check (
    public.has_right(contract_id, 'record_force_account')
    and public.has_global_right('view_cost_register_rates')
    and exists (
      select 1 from public.daily_work_reports d
      where d.id = dwr_id and d.certified_at is null
    )
  );

-- -----------------------------------------------------------------------------
-- 6. payroll_additive_rates — the comment this migration promised (0048's
--    brief flagged this as pending): distinguish Keywest's own internal
--    wage-loading assumption from GC 49.03(a)(i)'s payroll burden, which a
--    DWR reimburses AT COST inside actual wages, not as a markup. Comment
--    replaced wholesale (Postgres COMMENT ON has no append), original text
--    preserved verbatim, new paragraph added.
-- -----------------------------------------------------------------------------
comment on table public.payroll_additive_rates is
  'The burden on top of a wage (typically 25-45% open shop, higher with '
  'full fringes) — a company property with history, not a per-job choice. '
  'One value at a time company-wide, so no entity id, just effective_date. '
  'DO NOT CONFLATE this with GC 49.03(a)(i)''s payroll burden on a DWR: the '
  'GC reimburses that AT COST, inside actual wages — it is not a markup and '
  'has no fixed GC percentage. This table is Keywest''s own internal '
  'wage-loading assumption, used for bidding/costing and prefilled onto a '
  'DWR''s Block A as a percentage before markup (matching the real '
  'template''s own layout) — a convenience figure Keywest applies, not a '
  'Ministry-set rate.';
