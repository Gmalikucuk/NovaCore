-- =============================================================================
-- NovaCore v1 — Migration 0047: contracts — one guard, not six policies
--
-- Takes priority over finishing 0046's feature work, per the user's own
-- instruction — this ships first, 0046's four features sit on top of it.
--
-- THE GAP, discovered by 0046's own probes attempting a write (not by
-- reading a policy): `contracts` carries SIX permissive UPDATE policies —
-- contracts_tender_price_update_right, contracts_cost_tracking_update_
-- right, contracts_dates_update_right, contracts_state_update_right,
-- contracts_update_right, and 0046's own contracts_progress_claim_fields_
-- update_right. Each is written as though it gates its own column(s), and
-- none of them do. Postgres combines multiple PERMISSIVE policies for the
-- same command with OR — satisfying ANY ONE of the six grants row-level
-- write access to the WHOLE row, and every protected column's UPDATE grant
-- is broad (`grant update (col) on contracts to authenticated`, not
-- per-role), so a seat holding just ONE of these rights can then write
-- ANY of the others' columns too, by attempting a plain PATCH.
--
-- Proven live: correct_only (manage_members only, no set_cost/set_unit_
-- price) successfully PATCHed tender_price to 777 before this migration
-- touched anything — confirmed pre-existing, reverted immediately. 0046's
-- own probe run then caught the same shape from the other direction:
-- quantities (prepare_claims-only, the new right) could write tender_
-- price, cost_tracking_enabled, and readonly (manage_members alone) could
-- write the new holdback_percent/gst_percent columns. All values written
-- during that run were reverted; no lasting data change on any contract.
--
-- THIS IS THE THIRD INSTANCE OF THE SAME CLASS in this schema — items_
-- update_right making items_earned_fields_update_right decorative (0037),
-- v_contract_month computing cost with the wall only enforced client-side
-- (0044), and now this. Same shape each time: a narrow policy that reads
-- as a constraint while a broader one admits the write regardless.
--
-- FULL-SCHEMA AUDIT for this exact class (multiple permissive policies on
-- the same table+command, live query against pg_policy, not a memory of
-- what "should" exist):
--
--   select polrelid::regclass, polcmd, count(*), array_agg(polname)
--   from pg_policy where polpermissive group by polrelid, polcmd
--   having count(*) > 1;
--
--   contracts  UPDATE  6 policies  <- this migration
--   items      UPDATE  2 policies  <- items_earned_fields_update_right +
--                                     items_update_right. SAME class,
--                                     already fixed in 0037 by exactly the
--                                     mechanism this migration generalises
--                                     (guard_items_earned_fields, a BEFORE
--                                     INSERT OR UPDATE trigger checking
--                                     percent_complete/authorized_value
--                                     against set_cost+set_unit_price
--                                     regardless of which policy admitted
--                                     the row). Nothing further to do here.
--   profiles   SELECT  2 policies  <- profiles_select_self ("see your own
--                                     row") OR profiles_select_shared ("see
--                                     anyone you share a contract with").
--                                     NOT an instance of this class: SELECT
--                                     policies OR-ing together to WIDEN
--                                     visibility is the normal, intended
--                                     use of multiple permissive policies —
--                                     there is no column being masked that
--                                     a broader policy then exposes; both
--                                     policies admit the same full row
--                                     (id, full_name, global_role, create_
--                                     projects, manage_members — nothing
--                                     sensitive), they just differ in WHOSE
--                                     rows are visible. The failure mode
--                                     this migration fixes is specific to
--                                     WRITE policies that imply per-column
--                                     intent on a table with column-scoped
--                                     grants; a read union of full rows
--                                     does not have that shape.
--
-- No fourth instance. Total scope is exactly the six `contracts` policies.
--
-- THE FIX, the documented pattern going forward — same shape as guard_
-- items_earned_fields() (0037) and guard_entry_transitions() (0004+):
-- ONE BEFORE UPDATE trigger, guard_contracts_protected_columns(), checking
-- every column-that-implies-a-specific-right against that right,
-- independent of which of the six RLS policies actually admitted the row.
-- This REPLACES guard_contract_date_columns() (0016), which already did
-- exactly this for contract_start/contract_end vs manage_members — folded
-- in here rather than left as a second, narrower trigger beside a new
-- general one, so there is exactly one place on this table a future
-- column addition needs to touch. The six RLS policies themselves are left
-- in place, same as items_earned_fields_update_right was left in place in
-- 0037 — they are still the correct statement of intent for when a row is
-- reachable at all, and it is the trigger, not a seventh policy, that
-- narrows WHICH columns a given actor may move within that row. A future
-- protected column belongs in this trigger, not in a new policy — a new
-- policy only ever widens row access for every existing one at once.
--
-- Requires migrations through 0046.
-- =============================================================================

create or replace function public.guard_contracts_protected_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The Ministry's own contract period — company-wide administrative act,
  -- the same moment as creating the contract row and seating its members.
  if new.contract_start is distinct from old.contract_start
     or new.contract_end is distinct from old.contract_end
  then
    if not public.has_global_right('manage_members') then
      raise exception
        'contract_start/contract_end require manage_members — manage_schedule covers only planned_start/planned_end and Jobs'
        using errcode = '42501';
    end if;
  end if;

  -- Keywest's own planning dates — manage_schedule (per-contract) OR
  -- manage_members (company-wide), matching contracts_dates_update_right's
  -- own condition exactly (0016).
  if new.planned_start is distinct from old.planned_start
     or new.planned_end is distinct from old.planned_end
  then
    if not (public.has_global_right('manage_members') or public.has_right(new.id, 'manage_schedule')) then
      raise exception
        'planned_start/planned_end require manage_schedule or manage_members'
        using errcode = '42501';
    end if;
  end if;

  -- The award-document reconciliation figure — set_cost AND set_unit_
  -- price, the same "who may touch pricing figures on this contract"
  -- surface as item_prices (0035).
  if new.tender_price is distinct from old.tender_price then
    if not (public.has_right(new.id, 'set_cost') and public.has_right(new.id, 'set_unit_price')) then
      raise exception 'tender_price requires set_cost and set_unit_price' using errcode = '42501';
    end if;
  end if;

  -- Whether cost/margin render anywhere outside Rates' own entry columns —
  -- same pricing-figures surface as tender_price (0042).
  if new.cost_tracking_enabled is distinct from old.cost_tracking_enabled then
    if not (public.has_right(new.id, 'set_cost') and public.has_right(new.id, 'set_unit_price')) then
      raise exception 'cost_tracking_enabled requires set_cost and set_unit_price' using errcode = '42501';
    end if;
  end if;

  -- pipeline/active/warranty_period/closed_out/archived — administers the
  -- contract, the same right SeatMembers already requires to seat people
  -- on it (0028).
  if new.contract_state is distinct from old.contract_state then
    if not public.has_global_right('manage_members') then
      raise exception 'contract_state requires manage_members' using errcode = '42501';
    end if;
  end if;

  -- Holdback/GST — the population preparing the claim, independent of
  -- Rates' own pricing rights (0046).
  if new.holdback_percent is distinct from old.holdback_percent
     or new.gst_percent is distinct from old.gst_percent
  then
    if not public.has_right(new.id, 'prepare_claims') then
      raise exception 'holdback_percent/gst_percent require prepare_claims' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.guard_contracts_protected_columns() is
  'THE canonical per-column write guard for contracts (0047) — six RLS '
  'UPDATE policies on this table combine via OR at the row level and '
  'cannot be scoped to individual columns; this trigger is what actually '
  'restricts which columns a given actor may move, regardless of which '
  'policy admitted the row. A future protected column belongs here, as a '
  'new IF block — NOT as a seventh RLS policy, which would only widen row '
  'access for the other six at once. Same shape as items'' own guard_'
  'items_earned_fields() (0037).';

drop trigger if exists contracts_guard_date_columns on public.contracts;
drop function if exists public.guard_contract_date_columns();

create trigger contracts_guard_protected_columns
  before update on public.contracts
  for each row
  execute function public.guard_contracts_protected_columns();

-- -----------------------------------------------------------------------------
-- Correct the record on the six RLS policies themselves — each now says
-- plainly that it states intent, not enforcement, so nobody reads one in
-- isolation and concludes its column is safe.
-- -----------------------------------------------------------------------------
comment on policy contracts_tender_price_update_right on public.contracts is
  'States the intended right for tender_price. Does NOT by itself prevent '
  'a seat satisfying a DIFFERENT contracts UPDATE policy from writing this '
  'column too — six permissive UPDATE policies on this table combine via '
  'OR, and none of them are column-scoped. guard_contracts_protected_'
  'columns() (0047) is the actual enforcement.';
comment on policy contracts_cost_tracking_update_right on public.contracts is
  'States the intended right for cost_tracking_enabled. See contracts_'
  'tender_price_update_right''s comment — same caveat, same real '
  'enforcement (guard_contracts_protected_columns, 0047).';
comment on policy contracts_dates_update_right on public.contracts is
  'States the intended right for planned_start/planned_end/contract_'
  'start/contract_end. See contracts_tender_price_update_right''s comment '
  '— same caveat, same real enforcement (guard_contracts_protected_'
  'columns, 0047).';
comment on policy contracts_state_update_right on public.contracts is
  'States the intended right for contract_state. See contracts_tender_'
  'price_update_right''s comment — same caveat, same real enforcement '
  '(guard_contracts_protected_columns, 0047).';
comment on policy contracts_progress_claim_fields_update_right on public.contracts is
  'States the intended right for holdback_percent/gst_percent (0046). See '
  'contracts_tender_price_update_right''s comment — same caveat, same '
  'real enforcement (guard_contracts_protected_columns, 0047).';
comment on policy contracts_update_right on public.contracts is
  'Gated on manage_members, but has never been reachable — no base UPDATE '
  'grant on contracts to authenticated has ever existed (0016''s own '
  'discovery), only the column-scoped grants the other five policies '
  'rely on. Left in place for whenever a future migration grants broader '
  'UPDATE access; until then this policy admits nothing on its own.';

-- =============================================================================
-- Verify — as a seat holding SOME contracts UPDATE-satisfying right but
-- NOT the one that actually governs the column being touched, attempt the
-- write (not read the policy):
--
--   full (set_cost+set_unit_price+manage_schedule+prepare_claims, no
--   manage_members): PATCH contract_end -> rejected, 42501
--
--   quantities (prepare_claims only): PATCH planned_end -> rejected, 42501
--
--   readonly (manage_members only): PATCH tender_price -> rejected, 42501
--
--   correct_only (manage_members only): PATCH cost_tracking_enabled ->
--   rejected, 42501
--
--   full (set_cost+set_unit_price+manage_schedule+prepare_claims, no
--   manage_members): PATCH contract_state -> rejected, 42501
--
--   readonly (manage_members only, no prepare_claims): PATCH
--   holdback_percent -> rejected, 42501
--
-- Every EXISTING positive control (full sets tender_price/cost_tracking_
-- enabled/planned_end with the matching right; correct_only sets contract_
-- state; quantities sets holdback_percent/gst_percent, 0046) must keep
-- passing unchanged — the trigger only narrows what a WRONG-right seat can
-- reach, it adds nothing for the right one.
-- =============================================================================
