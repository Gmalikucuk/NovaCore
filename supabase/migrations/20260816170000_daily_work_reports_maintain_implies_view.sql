-- =============================================================================
-- NovaCore v1 — Migration: maintain_cost_registers implies the same DWR
-- visibility as view_cost_register_rates
--
-- BUG, caught before any real use: every cost-register rate table's own
-- SELECT policy (equipment_rates, labour_class_rates, payroll_additive_rates,
-- tool_allowance_rates, material_rates — 20260816130000) reads
-- `has_global_right('maintain_cost_registers') or has_global_right('view_cost_register_rates')`,
-- because maintain_cost_registers' own comment says plainly: "Implies read
-- of rates." The previous migration (20260816160000) checked
-- has_global_right('view_cost_register_rates') alone on every DWR-adjacent
-- policy — a maintain_cost_registers holder, who can already read every
-- rate a DWR line pulls from, would have been unable to see or enter a
-- single DWR. Fixed here by re-creating the five affected policies with the
-- same two-right OR the rest of the cost registers already use.
--
-- This does NOT change the user's own instruction from the DWR brief: two
-- explicit grants (record_force_account + view_cost_register_rates) are
-- still required together on daily_work_report_line_items' WRITE policy —
-- maintain_cost_registers is simply accepted as an alternative to
-- view_cost_register_rates specifically because it already implies the same
-- read, exactly as it does everywhere else in the cost registers. It is not
-- a new implication invented for DWRs.
--
-- Requires migrations through 20260816160000.
-- =============================================================================

drop policy contract_force_account_terms_select_right on public.contract_force_account_terms;
create policy contract_force_account_terms_select_right on public.contract_force_account_terms
  for select to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    or public.has_global_right('view_cost_register_rates')
    or public.has_global_right('maintain_cost_registers')
  );

drop policy daily_work_reports_select_right on public.daily_work_reports;
create policy daily_work_reports_select_right on public.daily_work_reports
  for select to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    or public.has_global_right('view_cost_register_rates')
    or public.has_global_right('maintain_cost_registers')
  );

drop policy daily_work_report_subcontractors_select_right on public.daily_work_report_subcontractors;
create policy daily_work_report_subcontractors_select_right on public.daily_work_report_subcontractors
  for select to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    or public.has_global_right('view_cost_register_rates')
    or public.has_global_right('maintain_cost_registers')
  );

drop policy daily_work_report_line_items_select_right on public.daily_work_report_line_items;
create policy daily_work_report_line_items_select_right on public.daily_work_report_line_items
  for select to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    or public.has_global_right('view_cost_register_rates')
    or public.has_global_right('maintain_cost_registers')
  );

drop policy daily_work_report_line_items_write_right on public.daily_work_report_line_items;
create policy daily_work_report_line_items_write_right on public.daily_work_report_line_items
  for all to authenticated
  using (
    public.has_right(contract_id, 'record_force_account')
    and (public.has_global_right('view_cost_register_rates') or public.has_global_right('maintain_cost_registers'))
    and exists (
      select 1 from public.daily_work_reports d
      where d.id = dwr_id and d.certified_at is null
    )
  )
  with check (
    public.has_right(contract_id, 'record_force_account')
    and (public.has_global_right('view_cost_register_rates') or public.has_global_right('maintain_cost_registers'))
    and exists (
      select 1 from public.daily_work_reports d
      where d.id = dwr_id and d.certified_at is null
    )
  );

-- =============================================================================
-- Verify — as the `quantities` fixture (maintain_cost_registers = true,
-- view_cost_register_rates = false, once seated with record_force_account
-- below in the probe fixtures migration):
--
--   select * from daily_work_reports limit 1;        -- expect: no longer
--   -- permission-denied purely for lack of view_cost_register_rates
-- =============================================================================
