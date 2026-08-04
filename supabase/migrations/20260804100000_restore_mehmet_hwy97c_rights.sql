-- =============================================================================
-- NovaCore v1 — Migration 0019: restore mehmet.kucuk.scm@gmail.com's Hwy 97C
-- rights lost to the rights regression
--
-- WHAT HAPPENED (full account in the "rights regression on Hwy 97C"
-- investigation this session) — summarized here since this migration is the
-- data repair for it:
--
-- seed_demo_contract.sql opened with `delete from public.contracts where
-- contract_no = '26914-0000'`. contract_members.contract_id -> contracts.id
-- is ON DELETE CASCADE, so every rerun of that seed destroyed every
-- membership row on the sandbox contract, including any manually-granted
-- rights beyond the auto-enrol trigger's own baseline (view_rates,
-- extract_report — enrol_global_roles, 0001/0009). The reseed then minted a
-- FRESH contract row and re-ran that trigger, which re-seated every
-- global_role profile at the baseline only. mehmet.kucuk.scm@gmail.com
-- (global owner) had real create_items/enter_quantity/correct_quantity/
-- confirm_quantity rights on Hwy 97C before this session's reseeds; those
-- were never the seed script's own creator grant (that has always gone to
-- a different, older profile — "Test owner", the actual `v_creator` by
-- `order by created_at limit 1`), so they came from an out-of-band grant
-- with no record of exactly when. Two reruns of seed_demo_contract.sql this
-- session (adding Jobs/dates, then adding record_actual_cost) each
-- silently reset it to the baseline.
--
-- This migration is the data repair — deliberately sequenced after, not
-- before, the seed itself was fixed so it can never do this again: see the
-- rewritten seed_demo_contract.sql (found-or-insert, never delete, every
-- table it owns upserted) and probe-rls.sh's new "Preservation, not just
-- denial" section, both landed alongside this file. Restoring rights before
-- fixing the mechanism would have just set up the third loss.
--
-- THE GRANT — confirmed against the actual gating code, not inferred from
-- what the sidebar was reported to show:
--   create_items      Items nav link (Sidebar.tsx)
--   enter_quantity   ┐ Daily Entry's own empty-state needs EITHER of these
--   correct_quantity ┘ (an OR, not an AND — QuantityRecordsScreen.tsx) but
--                       holding only one leaves half its form permanently
--                       disabled, which does not match "the full sidebar"
--                       as originally seen, so both are granted
--   confirm_quantity   Confirm nav link AND the screen itself
--                       (Sidebar.tsx, ConfirmQueueScreen.tsx)
-- manage_schedule and record_actual_cost are NOT granted here — nothing in
-- this session's account of what the sidebar showed ever claimed Jobs/dates
-- or actual-cost access, and this migration restores exactly what regressed,
-- not a broader guess at what else might be reasonable.
--
-- This UPDATEs an EXISTING row (the auto-enrol trigger already seated this
-- user on the current Hwy 97C contract with the baseline two rights) rather
-- than inserting one — scoped to the one known user_id and the one known
-- contract, same shape as 0017's targeted grant to full's PROBE seat.
-- =============================================================================

update public.contract_members
set create_items = true,
    enter_quantity = true,
    correct_quantity = true,
    confirm_quantity = true
where user_id = '20b7059c-eeb2-450d-99a1-f22071b5e8ee'
  and contract_id = (select id from public.contracts where contract_no = '26914-0000');

-- Verify:
--
--   select create_items, enter_quantity, correct_quantity, confirm_quantity,
--          view_rates, extract_report, manage_schedule, record_actual_cost
--   from contract_members cm
--   join contracts c on c.id = cm.contract_id
--   where c.contract_no = '26914-0000'
--     and cm.user_id = '20b7059c-eeb2-450d-99a1-f22071b5e8ee';
--   -- expect: true, true, true, true, true, true, false, false
-- =============================================================================
