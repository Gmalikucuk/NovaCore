-- =============================================================================
-- NovaCore v1 — Migration: grant record_force_account to
-- mehmet.kucuk.scm@gmail.com on Hwy 5 (26607-0000)
--
-- Per-contract right (contract_members), not company-wide — a targeted
-- UPDATE, not an INSERT, so it cannot clobber any other right this seat
-- already holds on this contract. Guarded twice: raises if the account
-- doesn't exist (same posture as 20260816150000), and separately if no
-- contract_members row exists to update (this migration seats no one; a
-- missing row means the account was never seated on this contract, a
-- different problem this migration does not solve).
--
-- Already holds maintain_cost_registers (20260816150000, company-wide) —
-- satisfies daily_work_report_line_items' AND-of-both-rights requirement
-- alongside this grant (20260816170000 confirmed maintain implies the same
-- visibility as view_cost_register_rates), so this one grant is enough to
-- fully use the DWR screen on this contract, not just view it.
--
-- Requires migrations through 20260816180000.
-- =============================================================================

do $$
declare
  v_user uuid;
  v_contract uuid := 'be9ed906-6a33-4a4c-aa3e-81f5707b5684'; -- Hwy 5 Snowshed Hill, 26607-0000
  v_rows int;
begin
  select id into v_user from auth.users where email = 'mehmet.kucuk.scm@gmail.com';

  if v_user is null then
    raise exception
      'No account exists for mehmet.kucuk.scm@gmail.com — this migration does not create accounts.';
  end if;

  update public.contract_members
  set record_force_account = true
  where contract_id = v_contract
    and user_id = v_user;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception
      'mehmet.kucuk.scm@gmail.com has no contract_members row on contract % — not seated there yet; this migration does not seat.',
      v_contract;
  end if;
end $$;

-- =============================================================================
-- Verify —
--
--   select u.email, cm.record_force_account, p.maintain_cost_registers
--   from contract_members cm
--   join auth.users u on u.id = cm.user_id
--   join profiles p on p.id = cm.user_id
--   where cm.contract_id = 'be9ed906-6a33-4a4c-aa3e-81f5707b5684'
--     and u.email = 'mehmet.kucuk.scm@gmail.com';
--   -- expect: record_force_account = true, maintain_cost_registers = true
-- =============================================================================
