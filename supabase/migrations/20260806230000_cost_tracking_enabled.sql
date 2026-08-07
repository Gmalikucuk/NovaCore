-- =============================================================================
-- NovaCore v1 — Migration 0042: cost_tracking_enabled — suppress derived
-- cost figures until cost coverage is real
--
-- Keywest has no cost breakdown and no tender module yet, so actual cost
-- cannot be entered and bid cost is not reliably available. Hwy 5 carried
-- four Est. cost figures of unknown provenance; Venables carries essentially
-- none. Every margin figure NovaCore derives from item_prices.cost_price —
-- Rates' own Margin/Margin % columns and tercile bands, Overview's margin
-- toggle and money-makers ranking, Portfolio's Est. margin to date, Months'
-- and the per-month detail screen's cost/margin columns, the pinned-Item
-- "Est. margin to date" line on Owner/Progress, Needs Attention's "at cost"
-- sentence, both Excel exports — renders as if it means something regardless
-- of whether the cost behind it is a real bid figure or a guess.
--
-- This column is the single switch that decides whether any of that renders
-- at all, per contract, defaulting off. A deliberate statement, not an
-- emergent one from a coverage threshold: several of the screens above
-- aggregate ACROSS contracts (Portfolio, Overview), where a threshold would
-- have to be silently re-evaluated at each one and could flip a company-wide
-- figure on without anyone deciding it should. Gated exactly like
-- tender_price (0035) — set_cost + set_unit_price, both, the same "who may
-- touch pricing figures on this contract" surface Rates already draws, not
-- a new decision.
--
-- WHAT THIS DOES NOT DO — the machinery stays exactly as it is: item_prices,
-- its entry paths, the view_rates wall, item_price_history,
-- guard_items_earned_fields, every policy and probe around them. Unit cost
-- and Ext. cost stay visible and enterable on Rates regardless of this flag
-- — they're the entry surface itself, how a real cost figure gets back into
-- the system, not a claim about what it means. This is about what renders,
-- not what exists. view_rates is untouched and unrelated — a seat that can
-- see prices still can; there is simply nothing derived to show them until
-- this is on.
--
-- Requires migrations through 0041.
-- =============================================================================

alter table public.contracts
  add column cost_tracking_enabled boolean not null default false;

comment on column public.contracts.cost_tracking_enabled is
  'Whether derived cost figures (Margin, Margin %, Est. cost/margin on '
  'Months and the per-month detail screen, the pinned-Item margin line, '
  'Needs Attention''s at-cost sentence, both Excel exports) are shown '
  'anywhere outside Rates'' own entry columns. Defaults false — cost '
  'coverage is not yet real on any contract. A person''s deliberate call, '
  'never inferred from how many Items happen to have a cost entered. '
  'Unit cost/Ext. cost on Rates stay visible and enterable regardless — '
  'they are the entry surface, not a derived figure.';

grant update (cost_tracking_enabled) on public.contracts to authenticated;

create policy contracts_cost_tracking_update_right on public.contracts
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
--   select contract_no, cost_tracking_enabled from contracts order by contract_no;
--   -- expect: every existing row (Hwy 5, Venables, sandbox, PROBE fixtures)
--   -- reads false — no row silently changed behaviour by this migration
--
--   -- as a set_cost + set_unit_price holder on a contract:
--   update contracts set cost_tracking_enabled = true where id = '<contract>';
--   -- expect: succeeds
--
--   -- as a seat with only view_rates (no set_cost/set_unit_price):
--   update contracts set cost_tracking_enabled = true where id = '<same contract>';
--   -- expect: 0 rows updated (RLS silently excludes, no error)
--
--   select cost_tracking_enabled from contracts where id = '<any contract you can see>';
--   -- expect: readable by any member regardless of rights, same as
--   -- tender_price/contract_state today
-- =============================================================================
