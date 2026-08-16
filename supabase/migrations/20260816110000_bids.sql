-- =============================================================================
-- NovaCore v1 — Migration: Bids — the pre-award half of the lifecycle
--
-- Keywest bids for work; winning turns a bid into a contract. NovaCore has
-- only ever modelled the contract half. This migration adds the other half
-- as five new tables — no change to contracts, items, item_prices or
-- quantity_records. Conversion at award (copying a won bid's items/prices
-- into a real contract, plus contracts.source_bid_id) is a separate,
-- reported-but-not-built brief; Create Contract is untouched here.
--
-- WHY COMPANY-WIDE, NOT PER-CONTRACT (the substantive design question this
-- brief raised): a bid has no contract to be a member of — it is not yet
-- one, and most bids never become one. is_member()/has_right(contract_id,
-- ...) cannot apply to an object with no contract_id. has_global_right()
-- already exists for exactly this shape (create_projects/manage_members,
-- 0008) — a boolean on profiles, no project/contract in scope. Three new
-- columns follow that same pattern:
--
--   create_bids     create/edit a bid, its item lines, and each line's
--                    sell price (the bid price itself).
--   set_bid_cost     write cost_price/cost_source on a bid line.
--   view_bid_costs   read cost_price/cost_source.
--
-- Split three ways for the same reason set_cost/set_bid_rate/view_rates are
-- split per-contract: different people touch different numbers, and read
-- is never implied by write.
--
-- THE ONE REAL DEPARTURE FROM THE EXISTING FINANCE WALL. On a contract,
-- line_item_prices gates cost AND sell price behind one flag (view_rates)
-- as a single row — the Unit Price itself is confidential there. Here the
-- brief is explicit that the opposite holds: "costs on a bid... should not
-- be visible to everyone who can see a bid price" — the price is meant to
-- be seen more broadly than the cost. Rather than bend the one-flag-one-row
-- mechanism to do a job it wasn't built for, sell_price lives on the spine
-- table itself (bid_items — open read, like every other structural
-- column), and ONLY cost_price/cost_source sit in a separate, walled table
-- (bid_item_costs). This is "the wall's shape, not its mechanism": money
-- still gets its own gate, but the gate sits in a different place because
-- what needs walling here is narrower than on a live contract.
--
-- WHY NOT THE items TABLE. items.contract_id is not null, references
-- contracts — a bid has no contract, and forcing one would mean either a
-- nullable contract_id with an XOR check (breaking the composite-FK
-- structural guard quantity_records relies on, and every is_member(
-- contract_id) policy that assumes a real value) or permanent nulls across
-- area_basis/job_id/percent_complete/authorized_value, none of which mean
-- anything pre-award. RLS is a different mechanism entirely besides — one
-- table whose policies branch on "is contract_id null" is exactly the
-- dual-purpose shape this schema has consistently split apart instead of
-- conflating (the same instinct that already split items/item_prices, and
-- that keeps company-wide and per-contract rights on separate columns).
-- Conversion at award reads as a plain insert-select between two tables
-- this way, not something murkier inside a shared one.
--
-- Requires migrations through 20260816100000.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Company-wide rights
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column create_bids    boolean not null default false,
  add column set_bid_cost   boolean not null default false,
  add column view_bid_costs boolean not null default false;

comment on column public.profiles.create_bids is
  'Company-wide (has_global_right), same shape as create_projects/manage_members. '
  'Create/edit a bid, its item lines, and each line''s sell price. Does not '
  'grant cost read or write — those are separate.';
comment on column public.profiles.set_bid_cost is
  'Company-wide. Write cost_price/cost_source on a bid line. Independent of '
  'create_bids on purpose: the estimator who costs a line is often not the '
  'person pricing the submission.';
comment on column public.profiles.view_bid_costs is
  'Company-wide. Read cost_price/cost_source (and therefore margin) on a bid '
  'line. Never implied by create_bids or set_bid_cost.';

-- -----------------------------------------------------------------------------
-- 2. owners — accumulates, no managed module. Name and type is enough.
-- -----------------------------------------------------------------------------
create table public.owners (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner_type  text not null check (owner_type in ('public', 'private')),
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

comment on table public.owners is
  'The party Keywest bids to — MoTT, a municipality, a private customer. '
  'Accumulates as bids are entered; no dedicated management screen, same '
  'posture as items growing ad hoc rather than being pre-seeded.';
comment on column public.owners.owner_type is
  'public (MoTT, municipalities, agencies, school districts, TransLink — '
  'owner supplies the item schedule) or private (Keywest writes the lines, '
  'no owner-supplied codes). Matches bids.bid_type in spirit but is a fact '
  'about the owner, not derived from any one bid.';

grant select, insert on public.owners to authenticated;
alter table public.owners enable row level security;

create policy owners_select_authenticated on public.owners
  for select to authenticated using (true);

create policy owners_insert_right on public.owners
  for insert to authenticated
  with check (public.has_global_right('create_bids'));

-- -----------------------------------------------------------------------------
-- 3. standard_items — the quote work-type library. Grows when a quote line
--    has no match; also the future join key for rate history across quotes
--    ("what has Keywest charged for asphalt spillways") — that view is
--    explicitly not built in this brief, but this table is its key.
-- -----------------------------------------------------------------------------
create table public.standard_items (
  id           uuid primary key default gen_random_uuid(),
  description  text not null,
  unit         text not null,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);

comment on table public.standard_items is
  'Keywest''s own repertoire of quote work types (~15-16 today, growing). '
  'No de-duplication constraint on description — near-duplicates are a '
  'search/UI problem, not one this table forces a schema answer to.';

grant select, insert on public.standard_items to authenticated;
alter table public.standard_items enable row level security;

create policy standard_items_select_authenticated on public.standard_items
  for select to authenticated using (true);

create policy standard_items_insert_right on public.standard_items
  for insert to authenticated
  with check (public.has_global_right('create_bids'));

-- -----------------------------------------------------------------------------
-- 4. bids
-- -----------------------------------------------------------------------------
create table public.bids (
  id             uuid primary key default gen_random_uuid(),
  bid_type       text not null check (bid_type in ('tender', 'quote')),
  owner_id       uuid not null references public.owners(id),
  name           text not null,
  reference_no   text,
  status         text not null default 'not_submitted'
                   check (status in ('not_submitted', 'submitted', 'won', 'lost', 'no_award', 'withdrawn')),
  winning_price  numeric check (winning_price is null or winning_price >= 0),
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  -- A winning price is what a COMPETITOR was awarded — only legible when
  -- Keywest lost. On 'won' it would be Keywest's own price under a
  -- different name, which is nonsense; on every other status nobody has
  -- published an award yet. Changing status away from 'lost' while
  -- winning_price is still set will fail this check — clear it in the
  -- same statement, the same discipline as every other stale-figure guard
  -- in this schema.
  constraint bids_winning_price_only_when_lost
    check (winning_price is null or status = 'lost')
);

comment on table public.bids is
  'One bid, tender or quote. Status is plain and user-set, never derived '
  'from dates or from whether a contract exists — same standing rule as '
  'contract_state.';
comment on column public.bids.reference_no is
  'The owner''s own tender/RFP number, where one exists. Optional — most '
  'quotes have none.';
comment on column public.bids.winning_price is
  'The published award price to whoever won, entered by a person reading '
  'it off the owner''s own award notice — never inferred. Only meaningful, '
  'and only permitted, when status = ''lost'' (bids_winning_price_only_when_lost).';

grant select, insert on public.bids to authenticated;
grant update (bid_type, owner_id, name, reference_no, status, winning_price)
  on public.bids to authenticated;
alter table public.bids enable row level security;

create policy bids_select_authenticated on public.bids
  for select to authenticated using (true);

create policy bids_insert_right on public.bids
  for insert to authenticated
  with check (created_by = auth.uid() and public.has_global_right('create_bids'));

create policy bids_update_right on public.bids
  for update to authenticated
  using (public.has_global_right('create_bids'))
  with check (public.has_global_right('create_bids'));

-- -----------------------------------------------------------------------------
-- 5. bid_items — the spine. Quantity AND sell_price (see header for why
--    sell_price sits here rather than in the walled cost table).
--
-- NO APPEND-ONLY GUARD, DELIBERATELY, AND DELIBERATELY LEFT OPEN. A bid
-- pre-submission is a draft an estimator is actively reshaping, not
-- evidence of work performed — quantity_records' append-only rule exists
-- for a different reason that doesn't hold here. Whether a SUBMITTED bid's
-- lines should lock against further edits is a real, undecided question —
-- it was raised and explicitly deferred, not overlooked. Decide it when
-- the first real bid is actually submitted; until then any create_bids
-- holder can edit a line at any status.
-- -----------------------------------------------------------------------------
create table public.bid_items (
  id                uuid primary key default gen_random_uuid(),
  bid_id            uuid not null references public.bids(id) on delete cascade,
  item_number       text,
  description       text not null,
  unit              text not null,
  quantity          numeric not null default 0 check (quantity >= 0),
  sell_price        numeric check (sell_price >= 0),
  standard_item_id  uuid references public.standard_items(id),
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  unique (id, bid_id)
);

comment on column public.bid_items.item_number is
  'The owner''s own arbitrary code for a tender line (MoTT: 05.03.04; '
  'Delta/MMCD: 32 12 16) — no format assumed, never parsed. Null for a '
  'quote line, which has no owner-supplied list.';
comment on column public.bid_items.sell_price is
  'What Keywest bids for this line. Nullable — a bid must be enterable '
  'with its item list before every line is priced, same convention as an '
  'Item existing with no item_prices row yet.';
comment on column public.bid_items.standard_item_id is
  'The rate-history join key (view not built in this brief). Populated '
  'for a quote line drawn from the library; null for a tender line today. '
  'OPEN QUESTION FOR THE NEXT BRIEF, not decided here: whether tender '
  'lines should ALSO map to standard_items. Without it, "what has Keywest '
  'charged for cold milling" is answerable across quotes only — item '
  'description alone is not a reliable join across tenders (04.03.02 is '
  'Cold Mill on Venables and Pulverize on Hwy 5). Whether that gap is '
  'closed decides whether rate history covers the whole book or half of it.';
comment on column public.bid_items.sort_order is
  'Preserves the owner''s schedule order (tender) or the quote''s own line '
  'order — item_number cannot be trusted to sort correctly across formats '
  '(MMCD "32 12 16" vs MoTT "05.03.04"). Assigned by the application at '
  'entry time.';

grant select, insert, update, delete on public.bid_items to authenticated;
alter table public.bid_items enable row level security;

create policy bid_items_select_authenticated on public.bid_items
  for select to authenticated using (true);

create policy bid_items_write_right on public.bid_items
  for all to authenticated
  using (public.has_global_right('create_bids'))
  with check (public.has_global_right('create_bids'));

-- -----------------------------------------------------------------------------
-- 6. bid_item_costs — THE finance wall. Separate table, separately gated,
--    same reasoning as line_item_prices but split at cost/price rather than
--    row/no-row (see header).
-- -----------------------------------------------------------------------------
create table public.bid_item_costs (
  bid_item_id  uuid primary key references public.bid_items(id) on delete cascade,
  bid_id       uuid not null,
  cost_price   numeric check (cost_price >= 0),
  cost_source  text check (cost_source in ('vendor_quote', 'judgement', 'calculated_build')),
  updated_by   uuid references public.profiles(id),
  updated_at   timestamptz not null default now(),
  foreign key (bid_item_id, bid_id) references public.bid_items (id, bid_id) on delete cascade,
  constraint bid_item_costs_price_source_together
    check ((cost_price is null) = (cost_source is null))
);

comment on table public.bid_item_costs is
  'Cost is never required (a bid must be enterable with no cost at all) — '
  'this row need not exist. Where it does, cost_price and cost_source are '
  'entered together or not at all (bid_item_costs_price_source_together), '
  'same absent-means-absent-on-both rule as items.cost_basis/cost_price '
  '(0023). bid_id is denormalized purely so RLS can gate without a join, '
  'same reason line_item_prices carries project_id alongside line_item_id.';
comment on column public.bid_item_costs.cost_source is
  'Where the cost figure came from — vendor_quote (precise), judgement '
  '(tribal knowledge), or calculated_build (an estimate built up from '
  'rates). Shown alongside the figure so a bid with twelve judged lines '
  'and four quoted lines reads as a different object from the reverse, '
  'without blocking either.';

grant select, insert, update on public.bid_item_costs to authenticated;
alter table public.bid_item_costs enable row level security;

create policy bid_item_costs_select_right on public.bid_item_costs
  for select to authenticated
  using (public.has_global_right('view_bid_costs'));

create policy bid_item_costs_insert_right on public.bid_item_costs
  for insert to authenticated
  with check (public.has_global_right('set_bid_cost'));

create policy bid_item_costs_update_right on public.bid_item_costs
  for update to authenticated
  using (public.has_global_right('set_bid_cost'))
  with check (public.has_global_right('set_bid_cost'));

-- =============================================================================
-- VERIFY —
--
--   -- as a create_bids holder, with no set_bid_cost/view_bid_costs:
--   insert into owners (name, owner_type) values ('City of Coquitlam', 'public');
--   insert into bids (bid_type, owner_id, name, created_by)
--     values ('tender', '<owner>', 'Test Tender', auth.uid());
--   insert into bid_items (bid_id, description, unit, quantity, sell_price)
--     values ('<bid>', 'Test line', 'Each', 1, 100);
--   -- expect: all three succeed
--
--   insert into bid_item_costs (bid_item_id, bid_id, cost_price, cost_source)
--     values ('<bid_item>', '<bid>', 80, 'judgement');
--   -- expect: 0 rows / rejected — no set_bid_cost
--
--   select * from bid_item_costs;
--   -- expect: empty — no view_bid_costs, even for rows this seat itself
--   -- could theoretically have caused to exist via a different seat
--
--   -- as a seat with NONE of the three new rights:
--   select * from bids;              -- expect: rows (open read)
--   select * from bid_items;         -- expect: rows, including sell_price
--   select * from bid_item_costs;    -- expect: empty
--   insert into bids (...);          -- expect: rejected
--
--   -- winning_price guard:
--   update bids set winning_price = 500000 where id = '<a bid with status = won>';
--   -- expect: rejected, bids_winning_price_only_when_lost
--   update bids set status = 'lost', winning_price = 500000 where id = '<bid>';
--   -- expect: succeeds (same statement, both change together)
-- =============================================================================
