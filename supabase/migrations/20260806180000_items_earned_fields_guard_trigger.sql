-- =============================================================================
-- NovaCore v1 — Migration 0037: close the create_items path to
-- percent_complete/authorized_value — items_earned_fields_update_right was
-- decorative
--
-- THE GAP. 0036 (items_earned_fields_write) added a policy gating
-- percent_complete/authorized_value on set_cost AND set_unit_price,
-- intending to keep them Finance-only, separate from create_items. It did
-- not work. items_update_right — the pre-existing, unconditional
-- create_items policy — is PERMISSIVE and applies to the whole row
-- regardless of which columns an UPDATE touches; RLS has no column
-- granularity. Permissive policies on the same table OR together, so any
-- row items_update_right admits is already writable in full, and
-- items_earned_fields_update_right's narrower condition adds no actual
-- restriction — it only looked like it did, because the app's own UI
-- (RatesScreen) never rendered the input for a seat lacking those rights.
--
-- Proven live: signed in as a seat holding create_items only (no set_cost,
-- no set_unit_price, on the PROBE-ADMIN sandbox contract) and successfully
-- PATCHed percent_complete to a nonzero value — 200, not rejected. The same
-- seat could also POST a brand-new Item with percent_complete already set
-- in the same INSERT. Both confirmed against the live database, both
-- cleaned up (PROBE-ADMIN sandbox fixture only; Hwy 5 and Venables were
-- never touched).
--
-- The existing probe (0036, "quantities: set percent_complete rejected")
-- never caught this: on that contract quantities holds NEITHER create_items
-- NOR set_cost/set_unit_price, so the rejection it observed came from
-- items_update_right's own row check failing, not from anything
-- finance-specific. It tested "no rights at all", not "create_items
-- without set_cost/set_unit_price" — the one shape that actually exercises
-- the claim. This migration's own probes (below) isolate that shape on
-- PROBE-ADMIN, where the seat's rights are exactly create_items=true,
-- set_cost=false, set_unit_price=false.
--
-- WHY NOT ANOTHER POLICY. A column-scoped GRANT can't fix this either:
-- grants are per-ROLE, unconditional — every seat shares the single
-- `authenticated` role, so a grant can express "this column is writable at
-- all" but never "writable only by rows where this contract_members
-- entry has X". That's row-level, which only RLS or procedural code can
-- express. And RLS policies can't be scoped to specific columns of an
-- UPDATE — only to rows. A THIRD permissive policy would face the exact
-- same OR-together problem as the second one did. A RESTRICTIVE policy
-- (ANDed against the permissive set) could work in principle, but would
-- need a self-referential subquery to see the pre-update value from inside
-- a WITH CHECK clause (which only exposes NEW) — fragile, and this
-- codebase already has a clean, tested precedent for exactly this shape of
-- problem.
--
-- THE FIX, belt and braces, same pattern as 0021 (draft_edit_confirm_wall
-- / guard_entry_transitions): a BEFORE INSERT OR UPDATE trigger, which is
-- the one enforcement layer that actually sees both OLD and NEW at once
-- and runs below every policy regardless of which one admitted the row.
-- guard_items_earned_fields() raises an exception whenever
-- percent_complete or authorized_value would end up non-null and changed
-- (INSERT: NEW is non-null at all; UPDATE: NEW differs from OLD) unless
-- the actor holds set_cost AND set_unit_price on that Item's contract. A
-- plain edit that never touches these two columns is untouched by this
-- trigger regardless of which right the actor holds — item_number,
-- description, unit, approximate_quantity, item_kind, provisional_sum,
-- and the new area_basis column (0038) all continue to need only
-- create_items, exactly as before.
--
-- items_earned_fields_update_right (0036) is left in place — it's still
-- the correct RLS-level statement of intent, and it's exactly the branch a
-- set_cost+set_unit_price seat travels through today. It was never wrong,
-- only insufficient on its own; the trigger is what actually closes the
-- gap, the same relationship guard_entry_transitions() has to
-- quantity_records_edit_draft_right.
--
-- Requires migrations through 0036.
-- =============================================================================

create or replace function public.guard_items_earned_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  changed boolean;
begin
  -- INSERT has no OLD row — a non-null value at creation is the only thing
  -- to gate. UPDATE gates any real change in either direction, including
  -- clearing a figure back to null: nulling out a Finance-entered value is
  -- still an act on Finance's own data, not a neutral no-op, so it needs
  -- the same right setting it did.
  if tg_op = 'INSERT' then
    changed := new.percent_complete is not null or new.authorized_value is not null;
  else
    changed := new.percent_complete is distinct from old.percent_complete
            or new.authorized_value is distinct from old.authorized_value;
  end if;

  if changed and not (
    public.has_right(new.contract_id, 'set_cost')
    and public.has_right(new.contract_id, 'set_unit_price')
  ) then
    raise exception
      'percent_complete and authorized_value require set_cost and set_unit_price — create_items alone is not enough'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger items_earned_fields_guard
  before insert or update on public.items
  for each row
  execute function public.guard_items_earned_fields();

-- =============================================================================
-- Verify — as a seat holding create_items only:
--
--   patch items set percent_complete = 50 where id = '<some lump_sum item>';
--   -- expect: 42501, not 200
--
--   insert into items (contract_id, item_number, ..., percent_complete)
--   values (..., 50);
--   -- expect: 42501, not 201
--
-- As a seat holding set_cost + set_unit_price, both continue to succeed
-- exactly as 0036 intended.
-- =============================================================================
