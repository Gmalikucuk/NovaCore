-- =============================================================================
-- NovaCore v1 — Migration 0038: area_basis — a stored classification,
-- replacing two string heuristics
--
-- THE PROBLEM. isAreaUnit and isApplicationRateItem (items.ts) decide
-- real behaviour on both entry screens — whether width/area inputs render
-- at all, and whether quantity itself is an Item's area or a separate
-- figure — by string-matching items.unit ('Square Metre') and an
-- item-number section-prefix convention ('03.' = supply/stockpile, not
-- applied). Both are documented in code as heuristics, not stored facts.
-- Neither is wrong on today's data — that's why nothing has broken — but
-- neither is safe: a contract arriving with "m²" or "SQ.M" instead of
-- "Square Metre" misclassifies silently, and "Shoulder Aggregate" (03.xx,
-- supply, no area) versus "Shouldering" (04.xx/05.xx, applied, has area) —
-- near-identical wording, opposite classification, both present on both
-- real contracts — is exactly the case a keyword match would get wrong.
--
-- THE SHAPE. One column, not two. Three values express everything the two
-- heuristics ever produced between them (they're mutually exclusive by
-- construction — a unit can't be both 'Square Metre' and 'Tonne' — so no
-- Item has ever satisfied both):
--
--   quantity_is_area     — the Item's own recorded quantity IS its area
--                           (milling, pulverize, cold mill — isAreaUnit's
--                           old 'Square Metre' set).
--   separately_measured   — area is a separate measured fact, entered
--                           alongside quantity, driving an application
--                           rate (paving lifts, shouldering, constructed
--                           base — isApplicationRateItem's old non-'03.'
--                           Tonne set).
--   not_applicable        — area has no meaning for this Item (Lump Sum,
--                           Provisional Sum, Each/Metre/Cubic Metre items,
--                           and stockpile-supply Tonne items under '03.').
--
-- Two independent booleans were considered and rejected: quantity_is_area
-- AND carries_a_rate simultaneously would be a state that has never
-- occurred and means nothing — the three-value enum can't represent it
-- because it doesn't exist. Same shape and naming precedent as cost_basis
-- (0023) — nullable, no default, a check constraint — not item_kind
-- (0002's not null default 'unit_price'), because a default here is
-- exactly the failure this migration exists to remove.
--
-- NULL is a fourth, distinct state: genuinely unclassified — nobody has
-- looked at this Item yet. It is never conflated with not_applicable,
-- which is itself a real, entered classification (someone confirmed area
-- has no meaning here). ItemsScreen renders them differently for exactly
-- this reason.
--
-- THE BACKFILL. Applies the current heuristic to every existing Item on
-- every contract (real and sandbox/demo alike) — not just Hwy 5/Venables —
-- because the app code stops reading isAreaUnit/isApplicationRateItem off
-- unit/item_number the moment this ships, uniformly, everywhere. Not
-- backfilling a sandbox or demo Item would silently regress its current,
-- correct rendering — exactly the "beyond swapping the source of truth"
-- behaviour change this brief forbids.
--
-- Eight Litre Items — "Supply and Apply..."/"Apply..." Tack Coat, Joint
-- Sealant, Emulsified Penetrating Primer, on both Hwy 5 and Venables — are
-- deliberately EXCLUDED from this backfill and stay NULL. They are
-- genuinely applied at a rate (tack coat ~0.26 L/m², primer ~1.66 L/m² on
-- Job A's base preparation, joint sealant a rate over a length) but that
-- area is not measured on their own record — it is the union of whatever
-- else was paved that day, derived from OTHER Items' records, not this
-- one's own quantity or a figure entered alongside it. That is a fourth
-- case none of the three values expresses, and the subject of a
-- separately queued brief on derivation rules. Backfilling them to
-- not_applicable now would be a claim nobody has checked; NULL is the
-- honest state until that brief lands. They fell outside both heuristics
-- only because those heuristics never looked past Tonne and Square Metre
-- — not because they were correctly assessed as area-less.
--
-- No new grant or RLS policy: items_update_right already gates every
-- column of items on create_items unconditionally (0002/0028), which is
-- exactly the right this column is meant to be gated on. Verified live
-- before writing this: items has a table-level, unrestricted UPDATE grant
-- to authenticated (inherited across the line_items -> items rename), so
-- any new column is writable the instant it exists, gated purely by
-- items_update_right's row check. items_earned_fields_guard (0037) only
-- fires on percent_complete/authorized_value and is untouched by this
-- column.
--
-- Requires migrations through 0037.
-- =============================================================================

alter table public.items
  add column area_basis text
    check (area_basis in ('quantity_is_area', 'separately_measured', 'not_applicable'));

update public.items
set area_basis = case
  when unit = 'Square Metre' then 'quantity_is_area'
  when unit = 'Tonne' and item_number not like '03.%' then 'separately_measured'
  else 'not_applicable'
end
where unit <> 'Litre';

-- =============================================================================
-- Verify:
--
--   select unit, area_basis, count(*) from items group by unit, area_basis
--   order by unit;
--   -- expect: every 'Square Metre' row -> quantity_is_area; every 'Tonne'
--   -- row with item_number not like '03.%' -> separately_measured; every
--   -- other 'Tonne' row (03.xx) and every non-Litre/non-Square-Metre/
--   -- non-Tonne unit -> not_applicable; every 'Litre' row -> null.
--
--   select contract_id, item_number, description from items
--   where unit = 'Litre' and area_basis is not null;
--   -- expect: 0 rows — the carve-out held.
-- =============================================================================
