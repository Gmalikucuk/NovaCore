-- =============================================================================
-- NovaCore v1 — Migration 0031: contracts_select_member — the creator's own
-- RETURNING race
--
-- FOUND WHILE PROBING 0028, NOT PART OF THE BRIEF'S OWN TEXT — a real bug in
-- the shipped CreateContractScreen, caught only because the new probe
-- section insisted on exercising create_projects with NO manage_members
-- (exactly the brief's own "do not conflate them" scenario), which nothing
-- before this had actually exercised end-to-end.
--
-- THE RACE. createContract() (contracts.ts) does
-- `.insert({...}).select('id, ...').single()` — supabase-js's .select()
-- after .insert() sends `Prefer: return=representation`, which makes
-- PostgREST build `INSERT ... RETURNING *` inside its CTE. Postgres checks
-- RETURNING rows from an INSERT against the table's SELECT policies at the
-- moment the row is inserted — which is BEFORE any AFTER INSERT trigger
-- runs. enrol_global_roles() (0001, extended by 0028) is an AFTER INSERT
-- trigger: it is what gives the creator their own contract_members row
-- (create_items, via 0028) — but that happens too late to satisfy
-- contracts_select_member's is_member(id) check for the RETURNING clause
-- of the SAME statement that created the row.
--
-- This was invisible before 0028 because nobody without a global_role had
-- ever created a contract through the API (only the seed scripts insert
-- contracts, and always as a fixture with no RETURNING requirement chained
-- the way the app does). It surfaced now because 0028's own
-- contracts_select_member (is_member(id) OR has_global_right(
-- 'manage_members')) has no third branch for "I am the row's own creator" —
-- has_global_right('manage_members') incidentally covers every global_role
-- holder (backfilled true in 0011), which is why readonly (owner@novacore.
-- test) never tripped this, and why quantities (create_projects only, no
-- manage_members, no global_role — deliberately isolated that way by 0030)
-- is exactly the fixture that caught it.
--
-- THE FIX. Add created_by = auth.uid() as a third OR branch. A contract's
-- own creator can always see the row they just made, full stop — this is
-- true regardless of trigger timing and doesn't depend on is_member()
-- catching up. Additive only: is_member() and manage_members keep working
-- exactly as before for everyone else.
--
-- Requires migrations through 0030.
-- =============================================================================

drop policy if exists contracts_select_member on public.contracts;

create policy contracts_select_member on public.contracts
  for select to authenticated
  using (
    public.is_member(id)
    or public.has_global_right('manage_members')
    or created_by = auth.uid()
  );

-- =============================================================================
-- Verify —
--
--   -- as a create_projects-only holder with no manage_members and no
--   -- global_role (quantities/field@novacore.test):
--   POST /rest/v1/contracts  (Prefer: return=representation)
--     {"contract_name": "...", "created_by": "<quantities' own id>"}
--   -- expect 201 with the row in the body, not a 42501 RLS violation.
-- =============================================================================
