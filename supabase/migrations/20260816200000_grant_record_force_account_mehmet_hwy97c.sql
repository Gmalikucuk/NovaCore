-- =============================================================================
-- NovaCore v1 — Migration: grant record_force_account to
-- mehmet.kucuk.scm@gmail.com on Hwy 97C Pennask Summit Resurfacing
-- (26914-0000)
--
-- Same shape as 20260816190000 (Hwy 5), a second grant on a second
-- contract — per-contract right, targeted UPDATE (not INSERT), cannot
-- clobber any other right already held on this contract. contract_id
-- resolved by contract_no lookup rather than a hardcoded id, matching
-- 20260804100000's own precedent for grants on this specific contract.
--
-- Already holds maintain_cost_registers (20260816150000, company-wide) —
-- satisfies daily_work_report_line_items' AND-of-both-rights requirement
-- here too, so this one grant is enough to fully use the DWR screen on
-- this contract as well, not just view it.
--
-- Requires migrations through 20260816190000.
-- =============================================================================

do $$
declare
  v_user     uuid;
  v_contract uuid;
  v_rows     int;
begin
  select id into v_user from auth.users where email = 'mehmet.kucuk.scm@gmail.com';

  if v_user is null then
    raise exception
      'No account exists for mehmet.kucuk.scm@gmail.com — this migration does not create accounts.';
  end if;

  select id into v_contract from public.contracts where contract_no = '26914-0000';

  if v_contract is null then
    raise exception 'No contract with contract_no = 26914-0000 (Hwy 97C Pennask Summit Resurfacing).';
  end if;

  update public.contract_members
  set record_force_account = true
  where contract_id = v_contract
    and user_id = v_user;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception
      'mehmet.kucuk.scm@gmail.com has no contract_members row on contract % (26914-0000) — not seated there yet; this migration does not seat.',
      v_contract;
  end if;
end $$;

-- =============================================================================
-- Verify —
--
--   select u.email, c.contract_no, cm.record_force_account, p.maintain_cost_registers
--   from contract_members cm
--   join auth.users u on u.id = cm.user_id
--   join contracts c on c.id = cm.contract_id
--   join profiles p on p.id = cm.user_id
--   where c.contract_no = '26914-0000'
--     and u.email = 'mehmet.kucuk.scm@gmail.com';
--   -- expect: record_force_account = true, maintain_cost_registers = true
-- =============================================================================
