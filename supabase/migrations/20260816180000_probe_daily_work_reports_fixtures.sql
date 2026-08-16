-- =============================================================================
-- NovaCore v1 — Migration: PROBE fixtures for record_force_account
--
-- record_force_account (per-contract) crossed against view_cost_register_
-- rates/maintain_cost_registers (company-wide) needs all four quadrants to
-- prove the AND-requirement on daily_work_report_line_items actually gates
-- both ways, not just one. Chosen by reusing exactly what each fixture
-- already holds, rather than inventing new accounts — no fixture needed a
-- company-wide right changed, only the one new per-contract right:
--
--   full (pm@novacore.test)        + record_force_account, on PROBE.
--     Already holds every OTHER per-project right (0016/0017's own
--     precedent for what "full" means) and NO company-wide right at all.
--     record_force_account alone, no view_cost_register_rates, no
--     maintain_cost_registers: proves the header/subcontractors are
--     reachable (record_force_account alone) while line items are NOT
--     (missing the rate-visibility half of the AND).
--
--   quantities (field@novacore.test) + record_force_account, on PROBE.
--     Already holds maintain_cost_registers (20260816140000) and nothing
--     else cost-register-adjacent. record_force_account + maintain: proves
--     BOTH halves together unlock line items, and that maintain satisfies
--     the AND exactly like view_cost_register_rates would (20260816170000).
--
--   readonly (owner@novacore.test) — untouched, already holds
--     view_cost_register_rates (20260816140000) and NOT record_force_account
--     on PROBE. Proves SELECT succeeds via the OR (rate-visibility alone)
--     while every write (header, subcontractor, line item, terms) is
--     rejected outright.
--
--   viewer (cfo@novacore.test) — untouched, holds neither
--     record_force_account nor any company-wide cost-register right.
--     Negative control: sees nothing, writes nothing.
--
-- Requires migrations through 20260816170000.
-- =============================================================================

update public.contract_members
set record_force_account = true
where contract_id = 'c0ffee00-c0de-0000-0000-000000000000'
  and user_id = '86cf63d5-d606-4ad7-924d-c4f6dda1da0b'; -- pm@novacore.test (full)

update public.contract_members
set record_force_account = true
where contract_id = 'c0ffee00-c0de-0000-0000-000000000000'
  and user_id = 'ee31c560-2015-4d7a-8a1d-ea3f93a73f96'; -- field@novacore.test (quantities)

-- =============================================================================
-- Verify —
--
--   select u.email, cm.record_force_account, p.view_cost_register_rates, p.maintain_cost_registers
--   from contract_members cm
--   join auth.users u on u.id = cm.user_id
--   join profiles p on p.id = cm.user_id
--   where cm.contract_id = 'c0ffee00-c0de-0000-0000-000000000000'
--     and u.email in ('pm@novacore.test', 'field@novacore.test', 'owner@novacore.test', 'cfo@novacore.test');
--   -- expect: pm      -> record_force_account=true,  view=false, maintain=false
--   --         field   -> record_force_account=true,  view=false, maintain=true
--   --         owner   -> record_force_account=false, view=true,  maintain=false
--   --         cfo     -> record_force_account=false, view=false, maintain=false
-- =============================================================================
