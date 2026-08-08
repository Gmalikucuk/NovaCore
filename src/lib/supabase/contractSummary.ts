import type { MyContract } from './contracts'
import { fetchItems, type Item } from './items'
import { fetchItemProgressRate, type ItemProgressRate } from './monthlyPeriods'
import { fetchItemPrices, type ItemPrice } from './prices'
import { gateOnCostTracking, margin, sumOrNull } from '../calculations/margin'

export interface ContractSummary {
  contract: MyContract
  valueToDate: number | null
  marginToDate: number | null
  /** Every Item on the contract, all three kinds — progressRate below only ever covers unit_price. Overview's money-makers ranking needs Lump Sum/Provisional Sum Items too (rowFinancials' extAmount applies to all three kinds; a per-Item quantity reading does not). */
  items: Item[]
  /** For a per-Item breakdown beyond the two totals above — the needs-attention aggregate on Overview. unit_price only, same as items_kind's own scope (0013's v_item_progress_rate). */
  progressRate: ItemProgressRate[]
  /** Raw price rows, not just the two summed totals — Overview merges these across contracts for the "at cost" figure on an over-quantity row, and for the money-makers ranking's own Ext. amount/margin figures. */
  prices: ItemPrice[]
}

/**
 * Quantity/rate data is per-contract, so this is one round trip per
 * contract, not one big query — same shape as every screen already fetching
 * per-contract progress. fetchItemPrices is skipped (not just filtered)
 * when the seat lacks view_rates on THIS contract, mirroring the existing
 * courtesy pattern (RLS is the real wall either way) — that leaves
 * priceByItem empty, which is what makes valueToDate/marginToDate come out
 * null (absent), not zero, for a contract the seat can't price. The exact
 * same code path also covers a real case: view_rates granted, but no
 * item_prices rows exist yet because nothing's been entered. Absent reads
 * identically either way, which is correct.
 *
 * Shared by PortfolioScreen (one row per contract) and the company Overview
 * (the same totals, plus progressRate/prices for its own needs-attention and
 * at-cost figures) — one fetch, not two independent copies of this logic.
 */
export async function loadContractSummary(contract: MyContract): Promise<ContractSummary> {
  const [items, progressRate, prices] = await Promise.all([
    fetchItems(contract.id),
    fetchItemProgressRate(contract.id),
    contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
  ])
  const priceByItem = new Map(prices.map((p) => [p.itemId, p]))
  const valueToDate = sumOrNull(
    progressRate.map((r) => {
      const price = priceByItem.get(r.itemId)
      return price?.unitPrice != null ? r.quantityToDate * price.unitPrice : null
    }),
  )
  // Null the whole computation, not just its cost input, when this
  // contract has cost tracking off (0042) — margin.ts's own null-
  // propagation would already zero the RESULT out from a null cost, but
  // this reads more directly as "not computed" than "computed from a
  // costPrice that happens to be null."
  const marginToDate = gateOnCostTracking(
    sumOrNull(
      progressRate.map((r) => margin(r.quantityToDate, priceByItem.get(r.itemId)?.costPrice ?? null, priceByItem.get(r.itemId)?.unitPrice ?? null, priceByItem.get(r.itemId)?.costBasis ?? null)),
    ),
    contract.costTrackingEnabled,
  )
  return { contract, valueToDate, marginToDate, items, progressRate, prices }
}
