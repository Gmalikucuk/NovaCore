-- =============================================================================
-- NovaCore v1 — Migration: probe fixtures for the two cost-register rights
--
-- Same discipline as 0047's own bids fixtures: each new right needs an
-- isolated holder that doesn't already carry it, or no probe can prove it
-- gates independently.
--
--   quantities (field@novacore.test)   + maintain_cost_registers
--     Already holds create_projects only (0030) — none of create_bids/
--     set_bid_cost/view_bid_costs/view_cost_register_rates — proves
--     maintain_cost_registers works on its own, and that maintaining
--     implies read without any separate grant.
--
--   readonly (owner@novacore.test)     + view_cost_register_rates
--     Already holds create_projects + manage_members (backfilled from
--     global_role='owner') — company-wide admin rights unrelated to cost
--     registers, none of the bids rights either. Proves read-only access
--     to rate figures without maintain, alongside unrelated company-wide
--     rights that must not imply it.
--
-- full/viewer/correct_only are left untouched — full (create_bids) becomes
-- the "holds a DIFFERENT company-wide right, neither cost-register one"
-- case: open read on equipment/labour_classes/materials, empty on every
-- rate table, every write rejected.
--
-- Requires migrations through 20260816130000.
-- =============================================================================

update public.profiles set maintain_cost_registers  = true where id = (select id from auth.users where email = 'field@novacore.test'); -- quantities
update public.profiles set view_cost_register_rates = true where id = (select id from auth.users where email = 'owner@novacore.test'); -- readonly

-- =============================================================================
-- Verify —
--
--   select u.email, p.maintain_cost_registers, p.view_cost_register_rates
--   from profiles p join auth.users u on u.id = p.id
--   where u.email in ('field@novacore.test', 'owner@novacore.test');
--   -- expect: field -> maintain_cost_registers=true, view_cost_register_rates=false
--   --         owner -> maintain_cost_registers=false, view_cost_register_rates=true
-- =============================================================================
