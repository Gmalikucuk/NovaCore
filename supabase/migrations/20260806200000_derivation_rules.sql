-- =============================================================================
-- NovaCore v1 — Migration 0039: derivation rules and application rate
-- targets — the 11 NULL area_basis Items resolved, empty
--
-- INVESTIGATION FIRST. area_basis is read in exactly two places today
-- (isAreaUnit/isApplicationRateItem, items.ts), both driving only whether
-- Daily Entry renders a width/area input. Nothing else reads it. The 11
-- Litre "Supply and Apply" Items (tack coat, primer, joint sealant, across
-- every contract) are NULL there and stay NULL after this migration —
-- area_basis has no fourth value for "derived." not_applicable would be a
-- false claim (area DOES apply to these Items — tack coat's rate IS an
-- area multiplier); it just isn't measured on the Item's OWN record. That
-- is a different axis entirely: area_basis asks "where does this Item's
-- own area live," derivation asks "is this Item's quantity computed from
-- OTHER Items' records at all." An Item can be not_applicable AND have no
-- derivation (Mobilization), quantity_is_area AND have no derivation (Cold
-- Mill), or NULL/unclassified AND have a derivation rule (tack coat, once
-- entered) — three independent axes, confirmed orthogonal by inspection,
-- not assumption. This migration adds no column to items and runs no
-- backfill against area_basis.
--
-- SHAPE — two unrelated concepts, two tables, argued below.
--
-- item_derivation_rules: a quantity this Item cannot measure directly,
-- computed from other Items' records on the same date.
--   coefficient  — the rate (Venables tack coat: 0.26; hot joint sealant:
--                  0.08 L per linear metre, itself 0.40 L/m2 over a 0.20 m
--                  strip — that unit-basis arithmetic happens once, at
--                  entry time, by the person reading the Special
--                  Provisions; this column stores the single resulting
--                  number, not a formula).
--   basis        — 'area' or 'length': which figure the coefficient
--                  multiplies. Not a free-text unit string — the
--                  coefficient's own denominator (L/m2 vs L per linear
--                  metre) IS the basis, and the Item's own `unit` column
--                  already carries the result unit (Litre, Kilogram), so
--                  nothing else needs storing.
--   sources      — item_derivation_sources, a plain many-to-many: which
--                  OTHER Items' same-date records this rule sums. Tack
--                  coat draws from every paving Item tacked that day (Top
--                  Lift, Level Course — a real set, more than one
--                  member). Primer draws from Base Preparation Job A
--                  alone — a set of one. Both are the same shape; no
--                  special case for singletons.
--
--   THE EXCLUSION QUESTION. Hot joint sealant's length is the mainline
--   Top Lift run, EXCLUDING pullouts — sourced from Top Lift's own
--   records, but not all of them. This is deliberately NOT modelled as
--   part of a rule's source set. Pullouts are not a separate Item on
--   either real contract; they are a location distinction inside Top
--   Lift's OWN quantity_records, indistinguishable from mainline records
--   by anything this schema stores. Building a record-level filter would
--   mean matching on location text or station ranges — exactly the
--   string/pattern heuristic this whole line of briefs has been removing,
--   for the same reason: whatever pattern "means pullout" today is a
--   convention, not a stored fact, and would misclassify silently the
--   day it doesn't hold. Instead: the derivation proposes the NAIVE sum
--   (all of Top Lift's reach that date, pullouts included), and the
--   person confirming sees the difference between that proposal and the
--   correct figure they enter — which is exactly the "computed figure
--   disagrees with entered figure, never auto-corrected" behaviour this
--   brief already requires for every other case. Pullouts are not a gap
--   in the rule shape; they are the ordinary case the confirmation step
--   exists for.
--
-- item_application_rate_targets: a DIFFERENT thing, kept in its own
-- table. A design rate from the Special Provisions (Venables:
-- 124.35 kg/m2, band 96-104%) that an ALREADY-MEASURED Item's own
-- quantity/area is checked against — same-Item, no cross-Item sourcing,
-- nothing derived or written. Combining it with item_derivation_rules
-- would conflate "how do I compute a figure nobody entered" with "how do
-- I grade a figure someone already entered" — different questions, a
-- different consumer (a document explicitly out of scope here), and
-- different Items in practice (Venables: top lift and side roads carry a
-- target, level course does not, because depth is variable — no
-- correlation with which Items carry a derivation rule). Built here as an
-- empty, unconsumed container, per brief: no computation, no display
-- logic, no conformance check — that is the application rate document,
-- explicitly not this brief.
--
-- EMPTY ON PURPOSE. No coefficient, source, or target rate is entered for
-- Hwy 5 or Venables by this migration. Both real contracts' Special
-- Provisions are the only legitimate source for these numbers; Hwy 5's
-- are not in hand, and guessing at either produced a wrong-but-plausible
-- number once already (Venables' hot joint sealant rate applied to Hwy
-- 5's Joint Sealant, coincidentally reasonable, confirming nothing). This
-- migration ships the container. A person fills it from the documents,
-- on Items (0038's own entry surface, same create_items gate).
--
-- RLS — no trigger needed here, and that is worth stating precisely
-- rather than reflexively bolting one on after 0037. The items_update_
-- right gap existed because items already carried a pre-existing,
-- unconditional table-level grant (inherited across the line_items ->
-- items rename) that a later, narrower policy could not actually
-- restrict — permissive policies OR together, and grants are checked
-- independently of which policy admitted the row. These are BRAND NEW
-- tables: no grant of any kind exists on them until this migration
-- writes one, and the only policies that will ever apply are the two
-- written below. A permissive create_items-gated policy on a table with
-- no other policy is not at risk of being widened by something that
-- doesn't exist. Contract isolation itself is enforced more strongly
-- than a trigger could manage anyway: the composite foreign keys below
-- make a cross-contract source or a rule/contract mismatch impossible to
-- insert at all, not merely rejected by a check that runs after the
-- fact.
--
-- Requires migrations through 0038.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. item_derivation_rules — one rule per Item, contract pinned by the
--    same composite-FK pattern as jobs/pinned_items/actual_cost/
--    item_price_history (items_id_contract_unique, 0027).
-- -----------------------------------------------------------------------------
create table public.item_derivation_rules (
  item_id     uuid primary key references public.items(id) on delete cascade,
  contract_id uuid not null,
  coefficient numeric not null check (coefficient > 0),
  basis       text not null check (basis in ('area', 'length')),
  created_at  timestamptz not null default now(),
  unique (item_id, contract_id),
  foreign key (item_id, contract_id) references public.items (id, contract_id) on delete cascade
);

comment on table public.item_derivation_rules is
  'A quantity this Item cannot measure directly — computed from OTHER '
  'Items'' same-date records (item_derivation_sources) via coefficient x '
  '(summed area or length). Entered from the Special Provisions, never '
  'inferred. No row = no rule, the common case.';

-- -----------------------------------------------------------------------------
-- 2. item_derivation_sources — the set a rule draws from. contract_id is
--    forced to equal BOTH the rule's own contract and the source Item's
--    own contract by the two composite foreign keys below, referencing
--    the same column — a cross-contract source cannot be inserted, not
--    merely rejected after the fact.
-- -----------------------------------------------------------------------------
create table public.item_derivation_sources (
  rule_item_id   uuid not null,
  source_item_id uuid not null,
  contract_id    uuid not null,
  primary key (rule_item_id, source_item_id),
  check (source_item_id <> rule_item_id),
  foreign key (rule_item_id, contract_id) references public.item_derivation_rules (item_id, contract_id) on delete cascade,
  foreign key (source_item_id, contract_id) references public.items (id, contract_id) on delete cascade
);

comment on table public.item_derivation_sources is
  'Which Items a derivation rule sums, on the same work_date, at proposal '
  'time. A plain inclusion set — no record-level exclusion (see this '
  'migration''s own header on pullouts: handled by confirmation, not '
  'schema).';

-- -----------------------------------------------------------------------------
-- 3. item_application_rate_targets — same-Item design rate + bonus band.
--    Unrelated to the two tables above; see header for why it is not
--    combined with them.
-- -----------------------------------------------------------------------------
create table public.item_application_rate_targets (
  item_id           uuid primary key references public.items(id) on delete cascade,
  contract_id       uuid not null,
  target_rate       numeric not null check (target_rate > 0),
  band_low_percent  numeric check (band_low_percent > 0),
  band_high_percent numeric check (band_high_percent > 0),
  created_at        timestamptz not null default now(),
  unique (item_id, contract_id),
  foreign key (item_id, contract_id) references public.items (id, contract_id) on delete cascade,
  check (band_low_percent is null or band_high_percent is null or band_low_percent <= band_high_percent)
);

comment on table public.item_application_rate_targets is
  'A design application rate and bonus band from the Special Provisions '
  '(e.g. 124.35 kg/m2, band 96-104%), for an Item that already measures '
  'its own quantity and area. Not derived, not cross-Item — a benchmark '
  'an already-recorded figure is graded against, by a document this '
  'brief does not build. Band is optional: a rate may be entered before '
  'its band is confirmed (Hwy 5: provisional, unconfirmed).';

-- -----------------------------------------------------------------------------
-- 4. Grants — fresh tables, no prior grant of any kind to widen.
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on public.item_derivation_rules to authenticated;
grant select, insert, delete on public.item_derivation_sources to authenticated;
grant select, insert, update, delete on public.item_application_rate_targets to authenticated;

alter table public.item_derivation_rules enable row level security;
alter table public.item_derivation_sources enable row level security;
alter table public.item_application_rate_targets enable row level security;

-- -----------------------------------------------------------------------------
-- 5. RLS — read on membership (matches items_select_member's own no-
--    extra-gate posture), write on create_items (matches area_basis,
--    0038 — the same person entering classification enters these rules).
-- -----------------------------------------------------------------------------
create policy item_derivation_rules_select_member on public.item_derivation_rules
  for select to authenticated using (public.is_member(contract_id));

create policy item_derivation_rules_write_right on public.item_derivation_rules
  for all to authenticated
  using (public.has_right(contract_id, 'create_items'))
  with check (public.has_right(contract_id, 'create_items'));

create policy item_derivation_sources_select_member on public.item_derivation_sources
  for select to authenticated using (public.is_member(contract_id));

create policy item_derivation_sources_write_right on public.item_derivation_sources
  for all to authenticated
  using (public.has_right(contract_id, 'create_items'))
  with check (public.has_right(contract_id, 'create_items'));

create policy item_application_rate_targets_select_member on public.item_application_rate_targets
  for select to authenticated using (public.is_member(contract_id));

create policy item_application_rate_targets_write_right on public.item_application_rate_targets
  for all to authenticated
  using (public.has_right(contract_id, 'create_items'))
  with check (public.has_right(contract_id, 'create_items'));

-- =============================================================================
-- Verify:
--
--   select count(*) from item_derivation_rules;
--   select count(*) from item_derivation_sources;
--   select count(*) from item_application_rate_targets;
--   -- expect: 0, 0, 0 — every contract, including Hwy 5 and Venables.
--
--   insert into item_derivation_sources (rule_item_id, source_item_id, contract_id)
--   values ('<rule on contract A>', '<item on contract B>', '<contract A>');
--   -- expect: 23503 foreign_key_violation — no row in items has
--   -- (id, contract_id) = (that source item, contract A), because it
--   -- doesn't belong to contract A.
-- =============================================================================
