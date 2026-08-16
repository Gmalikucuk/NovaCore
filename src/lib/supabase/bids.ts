import { supabase } from './client'

export type BidType = 'tender' | 'quote'
export type BidStatus = 'not_submitted' | 'submitted' | 'won' | 'lost' | 'no_award' | 'withdrawn'
export type CostSource = 'vendor_quote' | 'judgement' | 'calculated_build'
export type OwnerType = 'public' | 'private'

export interface Owner {
  id: string
  name: string
  ownerType: OwnerType
}

export interface StandardItem {
  id: string
  description: string
  unit: string
}

export interface Bid {
  id: string
  bidType: BidType
  ownerId: string
  ownerName: string
  ownerType: OwnerType
  name: string
  referenceNo: string | null
  status: BidStatus
  /** The published award price to whoever won — only ever present when status is 'lost' (bids_winning_price_only_when_lost). */
  winningPrice: number | null
  createdAt: string
}

export interface BidItem {
  id: string
  bidId: string
  /** The owner's own arbitrary code (tender) — no format assumed. Null for a quote line, which has no owner-supplied list. */
  itemNumber: string | null
  description: string
  unit: string
  quantity: number
  /** What Keywest bids for this line — nullable, same "priceable but not required yet" convention as item_prices. */
  sellPrice: number | null
  /** The rate-history join key (not built yet) — populated for a quote line drawn from the library, null for a tender line today (see 0047's own header for why tender lines don't map yet). */
  standardItemId: string | null
  sortOrder: number
}

/** Cost is optional and separately walled (view_bid_costs/set_bid_cost) — this is the finance-wall table, bid_item_costs, not a column on BidItem itself. */
export interface BidItemCost {
  bidItemId: string
  costPrice: number | null
  costSource: CostSource | null
}

// ---------------------------------------------------------------------------
// Owners — accumulate, no managed module. Open read to any authenticated
// seat (owners carry nothing sensitive); insert gated on create_bids.
// ---------------------------------------------------------------------------

interface RawOwnerRow {
  id: string
  name: string
  owner_type: OwnerType
}

function mapOwnerRow(row: RawOwnerRow): Owner {
  return { id: row.id, name: row.name, ownerType: row.owner_type }
}

export async function fetchOwners(): Promise<Owner[]> {
  const { data, error } = await supabase.from('owners').select('id, name, owner_type').order('name')
  if (error) throw error
  return (data ?? []).map((row) => mapOwnerRow(row as unknown as RawOwnerRow))
}

export async function createOwner(input: { name: string; ownerType: OwnerType }): Promise<Owner> {
  const { data, error } = await supabase.from('owners').insert({ name: input.name, owner_type: input.ownerType }).select('id, name, owner_type').single()
  if (error) throw error
  return mapOwnerRow(data as unknown as RawOwnerRow)
}

// ---------------------------------------------------------------------------
// Standard items — the quote work-type library. Same open-read/create_bids
// posture as owners.
// ---------------------------------------------------------------------------

interface RawStandardItemRow {
  id: string
  description: string
  unit: string
}

function mapStandardItemRow(row: RawStandardItemRow): StandardItem {
  return { id: row.id, description: row.description, unit: row.unit }
}

export async function fetchStandardItems(): Promise<StandardItem[]> {
  const { data, error } = await supabase.from('standard_items').select('id, description, unit').order('description')
  if (error) throw error
  return (data ?? []).map((row) => mapStandardItemRow(row as unknown as RawStandardItemRow))
}

export async function createStandardItem(input: { description: string; unit: string }): Promise<StandardItem> {
  const { data, error } = await supabase.from('standard_items').insert({ description: input.description, unit: input.unit }).select('id, description, unit').single()
  if (error) throw error
  return mapStandardItemRow(data as unknown as RawStandardItemRow)
}

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------

interface RawBidRow {
  id: string
  bid_type: BidType
  owner_id: string
  name: string
  reference_no: string | null
  status: BidStatus
  winning_price: string | null
  created_at: string
  owners: { name: string; owner_type: OwnerType }
}

const BID_SELECT = 'id, bid_type, owner_id, name, reference_no, status, winning_price, created_at, owners!inner ( name, owner_type )'

function mapBidRow(row: RawBidRow): Bid {
  return {
    id: row.id,
    bidType: row.bid_type,
    ownerId: row.owner_id,
    ownerName: row.owners.name,
    ownerType: row.owners.owner_type,
    name: row.name,
    referenceNo: row.reference_no,
    status: row.status,
    winningPrice: row.winning_price === null ? null : Number(row.winning_price),
    createdAt: row.created_at,
  }
}

/** Open read — bids are company-wide and visible to any seated user, same as any other object with no membership boundary to scope by (see 0047's own header). */
export async function fetchBids(): Promise<Bid[]> {
  const { data, error } = await supabase.from('bids').select(BID_SELECT).order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => mapBidRow(row as unknown as RawBidRow))
}

export async function fetchBid(id: string): Promise<Bid> {
  const { data, error } = await supabase.from('bids').select(BID_SELECT).eq('id', id).single()
  if (error) throw error
  return mapBidRow(data as unknown as RawBidRow)
}

export interface NewBidInput {
  bidType: BidType
  ownerId: string
  name: string
  referenceNo: string | null
}

/** create_bids only, per RLS (bids_insert_right) — created_by must be the caller. */
export async function createBid(input: NewBidInput): Promise<Bid> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in.')

  const { data, error } = await supabase
    .from('bids')
    .insert({ bid_type: input.bidType, owner_id: input.ownerId, name: input.name, reference_no: input.referenceNo, created_by: user.id })
    .select(BID_SELECT)
    .single()
  if (error) throw error
  return mapBidRow(data as unknown as RawBidRow)
}

export interface BidEditInput {
  bidType: BidType
  ownerId: string
  name: string
  referenceNo: string | null
}

/** create_bids only, per RLS (bids_update_right). */
export async function updateBid(id: string, input: BidEditInput): Promise<Bid> {
  const { data, error } = await supabase
    .from('bids')
    .update({ bid_type: input.bidType, owner_id: input.ownerId, name: input.name, reference_no: input.referenceNo })
    .eq('id', id)
    .select(BID_SELECT)
    .single()
  if (error) throw error
  return mapBidRow(data as unknown as RawBidRow)
}

/**
 * Status and winning price change together — bids_winning_price_only_when_
 * lost (0047) rejects a winning_price left over from a prior 'lost' status
 * once status moves away from it, so the caller must clear winningPrice in
 * the same call when switching off 'lost', not in a follow-up edit.
 */
export async function updateBidStatus(id: string, input: { status: BidStatus; winningPrice: number | null }): Promise<Bid> {
  const { data, error } = await supabase.from('bids').update({ status: input.status, winning_price: input.winningPrice }).eq('id', id).select(BID_SELECT).single()
  if (error) throw error
  return mapBidRow(data as unknown as RawBidRow)
}

// ---------------------------------------------------------------------------
// Bid items — the spine. sell_price lives here, open read (see 0047's
// header for why it isn't in the walled cost table).
// ---------------------------------------------------------------------------

interface RawBidItemRow {
  id: string
  bid_id: string
  item_number: string | null
  description: string
  unit: string
  quantity: string
  sell_price: string | null
  standard_item_id: string | null
  sort_order: number
}

const BID_ITEM_SELECT = 'id, bid_id, item_number, description, unit, quantity, sell_price, standard_item_id, sort_order'

function mapBidItemRow(row: RawBidItemRow): BidItem {
  return {
    id: row.id,
    bidId: row.bid_id,
    itemNumber: row.item_number,
    description: row.description,
    unit: row.unit,
    quantity: Number(row.quantity),
    sellPrice: row.sell_price === null ? null : Number(row.sell_price),
    standardItemId: row.standard_item_id,
    sortOrder: row.sort_order,
  }
}

export async function fetchBidItems(bidId: string): Promise<BidItem[]> {
  const { data, error } = await supabase.from('bid_items').select(BID_ITEM_SELECT).eq('bid_id', bidId).order('sort_order')
  if (error) throw error
  return (data ?? []).map((row) => mapBidItemRow(row as unknown as RawBidItemRow))
}

/**
 * Every bid_item across every bid, unfiltered — the list screen's own
 * value column and totals cards need each bid's sum(quantity * sell_price)
 * without an N+1 dispatch per row. Pre-award data is small (dozens of
 * bids, not thousands); one broad fetch grouped client-side by bidId is
 * the same shape PortfolioScreen's own summary load takes, scaled to a
 * dataset this size.
 */
export async function fetchAllBidItems(): Promise<BidItem[]> {
  const { data, error } = await supabase.from('bid_items').select(BID_ITEM_SELECT)
  if (error) throw error
  return (data ?? []).map((row) => mapBidItemRow(row as unknown as RawBidItemRow))
}

export interface BidItemInput {
  itemNumber: string | null
  description: string
  unit: string
  quantity: number
  sellPrice: number | null
  standardItemId: string | null
  sortOrder: number
}

/** create_bids only, per RLS (bid_items_write_right). */
export async function createBidItem(bidId: string, input: BidItemInput): Promise<BidItem> {
  const { data, error } = await supabase
    .from('bid_items')
    .insert({
      bid_id: bidId,
      item_number: input.itemNumber,
      description: input.description,
      unit: input.unit,
      quantity: input.quantity,
      sell_price: input.sellPrice,
      standard_item_id: input.standardItemId,
      sort_order: input.sortOrder,
    })
    .select(BID_ITEM_SELECT)
    .single()
  if (error) throw error
  return mapBidItemRow(data as unknown as RawBidItemRow)
}

export async function updateBidItem(id: string, input: BidItemInput): Promise<BidItem> {
  const { data, error } = await supabase
    .from('bid_items')
    .update({
      item_number: input.itemNumber,
      description: input.description,
      unit: input.unit,
      quantity: input.quantity,
      sell_price: input.sellPrice,
      standard_item_id: input.standardItemId,
      sort_order: input.sortOrder,
    })
    .eq('id', id)
    .select(BID_ITEM_SELECT)
    .single()
  if (error) throw error
  return mapBidItemRow(data as unknown as RawBidItemRow)
}

/**
 * No append-only guard on bid_items (0047's own header) — a pre-submission
 * bid is a draft, not evidence of work performed, so a line entered by
 * mistake can simply be removed. Whether a SUBMITTED bid's lines should
 * lock is a real, open question, deliberately deferred — see the migration.
 */
export async function deleteBidItem(id: string): Promise<void> {
  const { error } = await supabase.from('bid_items').delete().eq('id', id)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Bid item costs — THE finance wall. Empty result means either "nothing
// costed yet" or "you can't see cost" — RLS (view_bid_costs) is what makes
// those the same shape from this function's own point of view, same as
// item_prices returning empty for a seat lacking view_rates.
// ---------------------------------------------------------------------------

interface RawBidItemCostRow {
  bid_item_id: string
  cost_price: string | null
  cost_source: CostSource | null
}

function mapBidItemCostRow(row: RawBidItemCostRow): BidItemCost {
  return { bidItemId: row.bid_item_id, costPrice: row.cost_price === null ? null : Number(row.cost_price), costSource: row.cost_source }
}

export async function fetchBidItemCosts(bidId: string): Promise<BidItemCost[]> {
  const { data, error } = await supabase.from('bid_item_costs').select('bid_item_id, cost_price, cost_source').eq('bid_id', bidId)
  if (error) throw error
  return (data ?? []).map((row) => mapBidItemCostRow(row as unknown as RawBidItemCostRow))
}

/**
 * Deliberately returns void, and deliberately does NOT chain .select() —
 * a set_bid_cost holder without view_bid_costs can WRITE this row but
 * cannot read it back (that split is the whole point of the two rights
 * being independent). Requesting a representation (.select()) sends
 * Prefer: return=representation, which requires the INSERT/UPDATE's own
 * RETURNING to satisfy the SELECT policy too — for a write-only seat that
 * fails outright, turning a permitted write into an apparent 403. Chasing
 * this call with a re-fetch is the caller's job, and only makes sense when
 * the caller actually holds view_bid_costs.
 */
export async function upsertBidItemCost(input: { bidItemId: string; bidId: string; costPrice: number | null; costSource: CostSource | null }): Promise<void> {
  const { error } = await supabase.from('bid_item_costs').upsert(
    { bid_item_id: input.bidItemId, bid_id: input.bidId, cost_price: input.costPrice, cost_source: input.costPrice === null ? null : input.costSource },
    { onConflict: 'bid_item_id' },
  )
  if (error) throw error
}
