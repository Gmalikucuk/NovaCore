-- =============================================================================
-- NovaCore v1 — Migration 0035: tender_price — one number that verifies 48
-- transcribed prices at once
--
-- Rates is being redesigned as a real bid summary (Ext. cost, Ext. amount,
-- subtotals, a grand total). Once every Item's Unit Price/Lump Sum/
-- Provisional Sum figure is transcribed from the award schedule, the sum of
-- every Ext. amount should equal the number the Ministry actually awarded —
-- that's the whole verification. tender_price is where that one number
-- lives: the tendered total off the award document, entered once by a
-- person reading it off that document. It is never derived from the sum
-- itself (that would make the check tautological) and never computed here.
--
-- Column name matches the existing contracts vocabulary — contract_no,
-- contract_name, contract_start, planned_start all name the THING, not a
-- verb or a screen; tender_price follows the same shape (Schedule 7 itself
-- calls this figure the "Tendered Price").
--
-- Nullable, no default: most contracts (including every sandbox fixture)
-- have no reconciliation figure on hand yet, and absence here means
-- "nothing to check against," not zero.
--
-- Gated the same as Rates' own edit surface (RatesScreen's `canEdit`,
-- set_cost + set_unit_price both) rather than a new right — this is the
-- same "who may touch pricing figures on this contract" surface Rates
-- already draws, not a new decision.
--
-- Requires migrations through 0034.
-- =============================================================================

alter table public.contracts
  add column tender_price numeric check (tender_price >= 0);

comment on column public.contracts.tender_price is
  'The tendered total off the award document (Schedule 7''s own "Tendered '
  'Price"), entered once by a person reading it off that document — never '
  'derived from the sum of Ext. amount, which would make Rates'' own '
  'reconciliation against it tautological. Null on every contract until '
  'someone enters it.';

grant update (tender_price) on public.contracts to authenticated;

create policy contracts_tender_price_update_right on public.contracts
  for update to authenticated
  using (
    public.is_member(id)
    and public.has_right(id, 'set_cost')
    and public.has_right(id, 'set_unit_price')
  )
  with check (
    public.is_member(id)
    and public.has_right(id, 'set_cost')
    and public.has_right(id, 'set_unit_price')
  );

-- =============================================================================
-- Verify —
--
--   -- as a set_cost + set_unit_price holder on a contract:
--   update contracts set tender_price = 15739126.37 where id = '<contract>';
--   -- expect: succeeds
--
--   -- as a seat with only view_rates (no set_cost/set_unit_price):
--   update contracts set tender_price = 1 where id = '<same contract>';
--   -- expect: 0 rows updated (RLS silently excludes, no error) — matches
--   -- every other rights-gated update in this schema
--
--   select tender_price from contracts where id = '<any contract you can see>';
--   -- expect: readable by any member regardless of rights, same as
--   -- contract_no/contract_name today — Rates' own canEdit gates the WRITE
--   -- affordance in the UI, not this SELECT
-- =============================================================================
