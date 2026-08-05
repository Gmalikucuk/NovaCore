-- =============================================================================
-- NovaCore v1 — Migration 0030: probe fixtures for company-wide rights
--
-- readonly (owner@novacore.test) already holds BOTH create_projects and
-- manage_members — backfilled from global_role = 'owner' since 0008 — which
-- makes it useless for isolating either one cleanly: it is also
-- auto-enrolled on every contract that has ever existed (enrol_global_
-- roles() enrols every global_role holder, view_rates + extract_report,
-- the moment ANY contract is created), so any check of the form "sees a
-- contract it isn't a member of" or "the creator gets create_items and
-- NOTHING else" is confounded by that separate global_role grant landing
-- on the very same row.
--
-- Two more fixtures, each holding exactly ONE company-wide right the other
-- five don't already have some other way, and no global_role (so neither
-- is auto-enrolled anywhere):
--   quantities (field@novacore.test)        + create_projects
--   correct_only (probe-correct-only@...)   + manage_members
--
-- Company-wide rights on profiles are unrelated to the per-CONTRACT rights
-- columns on contract_members these two fixtures already carry (enter_
-- quantity/correct_quantity for quantities, correct_quantity/view_rates
-- for correct_only on Hwy 97C) — nothing about their existing probes
-- changes; this is purely additive on a different table.
--
-- Requires migrations through 0029.
-- =============================================================================

update public.profiles set create_projects = true where id = 'ee31c560-2015-4d7a-8a1d-ea3f93a73f96'; -- field@novacore.test (quantities)
update public.profiles set manage_members  = true where id = (select id from auth.users where email = 'probe-correct-only@novacore.test'); -- correct_only

-- =============================================================================
-- Verify —
--
--   select u.email, p.create_projects, p.manage_members, p.global_role
--   from profiles p join auth.users u on u.id = p.id
--   where u.email in ('field@novacore.test', 'probe-correct-only@novacore.test');
--   -- expect: field -> create_projects=true, manage_members=false, global_role=null
--   --         probe-correct-only -> create_projects=false, manage_members=true, global_role=null
-- =============================================================================
