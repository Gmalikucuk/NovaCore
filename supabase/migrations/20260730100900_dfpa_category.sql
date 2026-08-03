-- =============================================================================
-- NovaCore v1 — Migration 0012: DFPA category
--
-- Schedule 7 tags 18 of the 48 Items with a bracketed Diesel Fuel Price
-- Adjustment category — [DFPA 3], [DFPA 4], [DFPA 5b], [DFPA 5d], [DFPA 5e],
-- [DFPA 6], [DFPA 7]. These tie each Item to SP 1.35, which is itself Item
-- 01.04 (Diesel Fuel Price Adjustment, Provisional Sum 5,000.00).
--
-- Stored as its own column rather than left inside the description, so a fuel
-- adjustment claim is a query rather than a string parse. The tag is dropped
-- from the description text on seeding for the same reason.
--
-- Pre-apply verification: items.dfpa_category does not currently exist
-- (checked live). Purely additive — no renames, no dependent policies, no
-- risk of the dependency-ordering or function-signature hazards the last
-- three migrations hit.
-- =============================================================================

alter table public.items
  add column dfpa_category text;

comment on column public.items.dfpa_category is
  'Schedule 7 Diesel Fuel Price Adjustment category, e.g. "5b", "6", "7". '
  'Null where Schedule 7 carries no DFPA tag. Relates the Item to SP 1.35 '
  '(Item 01.04).';

create index items_dfpa_idx on public.items (contract_id, dfpa_category)
  where dfpa_category is not null;

-- Deliberately not a check constraint against a fixed list: DFPA categories are
-- defined by the Special Provisions and vary between contracts. A constraint
-- here would have to be amended for every new contract, which is a worse
-- failure mode than an unconstrained text column.
