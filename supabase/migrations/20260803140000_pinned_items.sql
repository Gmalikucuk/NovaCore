-- =============================================================================
-- NovaCore v1 — Migration 0015: pinned Items
--
-- Overview's "Contract complete" card was a quantity-weighted blend across
-- every Unit Price Item on the contract — Mobilization and sign installation
-- counted the same as paving. On a real contract the money is in a handful of
-- Items (paving, level course, milling), and a blended figure across all of
-- them measures nothing anyone acts on. Removed outright in this same change
-- (OverviewScreen.tsx), not replaced with a different weighting — the fix is
-- letting the person choose which Items they watch, not choosing better for
-- them.
--
-- Per-seat, per-contract: the same person sees the same pins whether they're
-- on a phone in the field or a laptop in the office, and two people on the
-- same contract can watch different Items without stepping on each other.
--
-- Only Unit Price Items are pinnable — enforced at the insert policy, not
-- just in the UI. A Lump Sum Item pays on percentage complete (GC 52.03(b))
-- and a Provisional Sum Item on value authorized in advance (GC 52.03(c)/
-- 47.01); neither has a quantity-against-Approximate-Quantity reading, so
-- neither has anything for this feature to show.
--
-- THE STANDING RULE, UNCHANGED: tenancy is expressed only through
-- is_member()/has_right(). No policy here inlines a subquery against
-- contract_members. The item_kind check below queries `items`, not
-- contract_members — that's a referential-correctness check (does this Item
-- actually belong to this contract, and is it the right kind), not a tenancy
-- check, so it doesn't fall under that rule.
-- =============================================================================

create table public.pinned_items (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  item_id     uuid not null,
  created_at  timestamptz not null default now(),

  -- One pin per (person, contract, Item) — pinning something already pinned
  -- is a no-op, not a duplicate row.
  unique (contract_id, user_id, item_id),

  -- items.id needs to be addressable with contract_id for this composite FK —
  -- 0001's `unique (id, project_id)` on line_items survived 0009's rename as
  -- `unique (id, contract_id)` on items (confirmed: 0010 relies on the same
  -- constraint). on delete cascade: an Item deleted out from under a pin
  -- leaves nothing to point at, and a stale pin referencing a gone Item is
  -- not a state worth keeping around to render.
  foreign key (item_id, contract_id)
    references public.items (id, contract_id) on delete cascade
);

create index pinned_items_contract_user_idx
  on public.pinned_items (contract_id, user_id);

comment on table public.pinned_items is
  'A seat''s chosen set of Items to watch on a contract''s Overview — replaces '
  'the removed quantity-weighted "Contract complete" figure. Per-seat and '
  'per-contract, so the same person keeps the same pins moving between '
  'devices, and different people on the same contract can watch different '
  'Items.';

alter table public.pinned_items enable row level security;

grant select, insert, delete on public.pinned_items to authenticated;

-- A seat reads only its own pins, and only on a contract it's still seated
-- on — matches every other per-contract read in the schema (mere membership,
-- nothing more, since a pin carries no money of its own).
create policy pinned_items_select_own on public.pinned_items
  for select to authenticated
  using (user_id = auth.uid() and public.is_member(contract_id));

-- A seat may only ever pin FOR ITSELF (user_id = auth.uid(), not settable to
-- anyone else), on a contract it's a member of, and only a real Unit Price
-- Item that actually belongs to that contract. The item_kind/contract match
-- is checked here rather than trusted from the client — a picker that only
-- lists Unit Price Items is a courtesy, not what's actually enforcing this.
create policy pinned_items_insert_own on public.pinned_items
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_member(contract_id)
    and exists (
      select 1 from public.items i
      where i.id = item_id
        and i.contract_id = pinned_items.contract_id
        and i.item_kind = 'unit_price'
    )
  );

-- Unpinning is deleting your own row. No update policy at all — a pin either
-- exists or doesn't; there is no in-place field on it worth editing.
create policy pinned_items_delete_own on public.pinned_items
  for delete to authenticated
  using (user_id = auth.uid() and public.is_member(contract_id));

-- =============================================================================
-- PROBES to add (scripts/probe-rls.sh)
--
--   - quantities: insert a pin on a unit_price Item it's a member of -> 201
--     (pinning needs no special right beyond membership — it's the seat's
--     own watch-list, not a contract-management action)
--   - quantities: insert a pin with user_id set to someone else's id -> 403
--     (a seat may only ever pin for itself)
--   - quantities: insert a pin on a lump_sum/provisional_sum Item -> 403
--     (only Unit Price Items are pinnable, enforced here, not just in the UI)
--   - readonly (zero rights, seated): insert a pin -> 201 (pinning is a
--     membership-level action, not gated behind any of the eight rights —
--     matches quantity_records' "membership grants visibility" positive
--     control, just for writes on this one table)
--   - readonly: cannot see or delete a pin created by a DIFFERENT seat on the
--     same contract (select returns it filtered out; delete matches 0 rows)
--   - a seat removed from a contract's membership (or querying a contract
--     it was never on): select/delete on that contract_id -> empty / 0 rows
-- =============================================================================
