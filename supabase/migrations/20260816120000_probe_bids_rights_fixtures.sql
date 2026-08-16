-- =============================================================================
-- NovaCore v1 — Migration: probe fixtures for the three new bid rights
--
-- Same discipline as 0030 (probe_admin_company_rights): each of the three
-- new company-wide rights (create_bids, set_bid_cost, view_bid_costs) needs
-- an isolated holder — a seat with exactly that one right and neither of
-- the other two — or no probe can prove any one of them gates independently
-- of the others.
--
-- Three fixtures, none already holding any of the three (checked against
-- 0030's grants: quantities has create_projects only, readonly has
-- create_projects + manage_members, correct_only has manage_members only —
-- none overlap with create_bids/set_bid_cost/view_bid_costs):
--
--   full (pm@novacore.test)                 + create_bids
--   viewer (cfo@novacore.test)               + view_bid_costs
--   correct_only (probe-correct-only@...)    + set_bid_cost  (added
--     alongside its existing manage_members — proves set_bid_cost is
--     independent of manage_members too, and gives a "can write cost,
--     cannot read it back" case matching this fixture's own established
--     character of holding a write right without its paired read right)
--
-- readonly and quantities are left untouched — readonly becomes the "sees
-- bids/prices exist via the open SELECT, can do nothing bid-related" case;
-- quantities is unaffected since nothing about it changes here.
--
-- Company-wide rights on profiles, unrelated to the per-contract rights
-- these three fixtures already carry — purely additive, different table.
--
-- Requires migrations through 20260816110000.
-- =============================================================================

update public.profiles set create_bids    = true where id = (select id from auth.users where email = 'pm@novacore.test'); -- full
update public.profiles set view_bid_costs = true where id = (select id from auth.users where email = 'cfo@novacore.test'); -- viewer
update public.profiles set set_bid_cost   = true where id = (select id from auth.users where email = 'probe-correct-only@novacore.test'); -- correct_only

-- =============================================================================
-- Verify —
--
--   select u.email, p.create_bids, p.set_bid_cost, p.view_bid_costs
--   from profiles p join auth.users u on u.id = p.id
--   where u.email in ('pm@novacore.test', 'cfo@novacore.test', 'probe-correct-only@novacore.test');
--   -- expect: pm -> create_bids=true, others false
--   --         cfo -> view_bid_costs=true, others false
--   --         probe-correct-only -> set_bid_cost=true, others false
-- =============================================================================
