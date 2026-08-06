-- =============================================================================
-- NovaCore v1 — Migration: contract_state
--
-- Venables (26754-0000) finished paving July 31; its contract period ends
-- August 10. Loaded as a live contract, it is indistinguishable from one
-- still being worked: Overview counts it in company totals as work in
-- progress, Needs Attention flags every incomplete Item as stalled the
-- moment contract_end passes, and Portfolio shows it beside Hwy 5 as if
-- both were active. A boolean (archived) cannot express "finished but
-- still being updated, with a possible extension" — that is neither
-- "active" nor "archived," it is its own state.
--
-- Five states, a person sets the value, never a date:
--   pipeline           — awarded, not yet started (NovaCore's own Tenders
--                         screen covers pre-award; a "contract" here means
--                         one that exists to be scheduled)
--   active              — work in progress (today's only real behaviour,
--                         and the default for both new and existing rows —
--                         see below)
--   warranty_period      — substantively complete, not closed out. Matches
--                         Portfolio's own pre-existing "Warranty Period"
--                         section and this contract's own domain term —
--                         substantial completion followed by a defects
--                         liability period before final acceptance, not a
--                         NovaCore invention.
--   closed_out          — finished and reconciled, kept visible for
--                         reference (distinct from archived: closed_out is
--                         still normal history; archived is put away).
--   archived             — removed from view. This is the one existing
--                         `archived` boolean's own stated meaning; see
--                         below for why it becomes this enum value instead
--                         of staying a second, independent flag.
--
-- contract_end passing is evidence a person MIGHT want to change state —
-- it is never the trigger. Venables is exactly the counter-example: its
-- own contract_end says August 10, but paving stopped July 31 and records
-- are still arriving August 4, with a possible extension still open. No
-- date reliably means "finished," and no absence of one means "not
-- finished" — only a person reading the actual situation knows that.
-- Hence: a plain column, no derivation, no trigger, no CHECK tying it to
-- contract_end/contract_start/planned_start/planned_end.
--
-- No enforced transition graph either. pipeline -> active -> warranty_period
-- -> closed_out -> archived is the expected path, but nothing stops a
-- correction (archived by mistake -> active again) — a rigid state machine
-- would fail exactly the kind of judgement call this column exists to hold.
--
-- `archived` (the existing boolean, 20260730100000_foundation_schema.sql) —
-- folded into this enum, not kept as a second independent flag. It has
-- never been fetched or read anywhere in the application (grep confirms
-- zero call sites outside this contracts table); two ways to say "hidden"
-- that could silently disagree is worse than one. The column is NOT
-- dropped, NOT written by this migration, and NOT read by it either — it
-- stays exactly as it is, inert, so nothing that might reference it later
-- breaks. contract_state is the single live source of truth for this
-- concept going forward.
--
-- Default 'active' for both new and existing rows: NovaCore's own Tenders
-- screen is where a pre-award opportunity lives; a row reaching `contracts`
-- has, in every case seeded or created so far, already started. Defaulting
-- existing rows to 'active' is also the non-destructive choice — it
-- preserves exactly today's behaviour (every contract treated as live)
-- until a person deliberately moves one. Venables is NOT set to
-- warranty_period here — that is explicitly a person's call, made
-- separately, on the real contract, outside this migration.
--
-- Gated on manage_members, the same right (once actually reachable) as the
-- blanket contracts_update_right intends and the same right SeatMembers
-- already requires to administer a contract's own membership — this is
-- that same "runs the contract" surface, not a new decision. Unlike
-- contracts_update_right, this policy has its own explicit column grant,
-- so it does not repeat that policy's own discovered bug (no table-level
-- update grant to fall back on).
-- =============================================================================

alter table public.contracts
  add column contract_state text not null default 'active'
    check (contract_state in ('pipeline', 'active', 'warranty_period', 'closed_out', 'archived'));

comment on column public.contracts.contract_state is
  'Five states (pipeline/active/warranty_period/closed_out/archived), set '
  'by a person, never inferred from contract_end or any other date — a '
  'contract can be finished before its own end date, or still active past '
  'it. Supersedes the archived boolean as the live source of truth for '
  '"removed from view"; that column stays in place, unused, rather than '
  'being dropped or repurposed silently.';

grant update (contract_state) on public.contracts to authenticated;

create policy contracts_state_update_right on public.contracts
  for update to authenticated
  using (
    public.is_member(id)
    and public.has_global_right('manage_members')
  )
  with check (
    public.is_member(id)
    and public.has_global_right('manage_members')
  );

-- =============================================================================
-- Verify —
--
--   select contract_no, contract_state from contracts order by contract_no;
--   -- expect: every existing row (Hwy 5, Venables, sandbox, PROBE fixtures)
--   -- reads 'active' — no row silently changed behaviour by this migration
--
--   -- as a manage_members holder:
--   update contracts set contract_state = 'warranty_period' where id = '<contract>';
--   -- expect: succeeds
--
--   -- as a seat member without manage_members:
--   update contracts set contract_state = 'archived' where id = '<same contract>';
--   -- expect: 0 rows updated (RLS silently excludes)
--
--   update contracts set contract_state = 'not_a_real_state' where id = '<contract>';
--   -- expect: rejected — check constraint violation
-- =============================================================================
