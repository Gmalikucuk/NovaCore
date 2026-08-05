import type { MyContract } from './contracts'
import { fetchItemProgressRate, type ItemProgressRate } from './monthlyPeriods'
import { fetchItemPrices, type ItemPrice } from './prices'
import { margin, sumOrNull } from '../calculations/margin'

export interface ContractSummary {
  contract: MyContract
  valueToDate: number | null
  marginToDate: number | null
  /** For a per-Item breakdown beyond the two totals above — the needs-attention aggregate on Overview. */
  progressRate: ItemProgressRate[]
  /** Raw price rows, not just the two summed totals — Overview merges these across contracts for the "at cost" figure on an over-quantity row. */
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
  const [progressRate, prices] = await Promise.all([fetchItemProgressRate(contract.id), contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([])])
  const priceByItem = new Map(prices.map((p) => [p.itemId, p]))
  const valueToDate = sumOrNull(
    progressRate.map((r) => {
      const price = priceByItem.get(r.itemId)
      return price?.unitPrice != null ? r.quantityToDate * price.unitPrice : null
    }),
  )
  const marginToDate = sumOrNull(
    progressRate.map((r) => margin(r.quantityToDate, priceByItem.get(r.itemId)?.costPrice ?? null, priceByItem.get(r.itemId)?.unitPrice ?? null, priceByItem.get(r.itemId)?.costBasis ?? null)),
  )
  return { contract, valueToDate, marginToDate, progressRate, prices }
}
