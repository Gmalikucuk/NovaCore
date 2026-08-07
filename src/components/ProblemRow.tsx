import { IconAlertTriangle, IconClockPause, IconFlag } from '@tabler/icons-react'
import type { ItemPrice } from '../lib/supabase/prices'
import type { ProblemItem } from '../lib/calculations/overview'
import { money, quantity as fmtQuantity } from '../lib/format'

const PROBLEM_KIND_LABEL: Record<ProblemItem['kind'], string> = {
  stalled: 'Stalled',
  over_quantity: 'Over quantity',
  behind_rate: 'Behind rate',
}

function ProblemIcon({ kind }: { kind: ProblemItem['kind'] }) {
  if (kind === 'stalled') return <IconClockPause size={16} stroke={1.75} className="text-nc-warning-text" />
  if (kind === 'over_quantity') return <IconAlertTriangle size={16} stroke={1.75} className="text-nc-over-text" />
  return <IconFlag size={16} stroke={1.75} className="text-nc-info-text" />
}

function problemSentence(p: ProblemItem, priceByItem: Map<string, ItemPrice>): string {
  const { kind, row } = p
  if (kind === 'stalled') {
    return row.lastWorkDate ? `No activity since ${row.lastWorkDate} — not finished.` : 'No confirmed activity yet — not finished.'
  }
  if (kind === 'over_quantity') {
    const overage = row.quantityToDate - row.approximateQuantity
    const price = priceByItem.get(row.itemId)
    // A per-unit rate turns the overage into a dollar figure directly. A
    // total cost has no such reading — "overage x total" isn't a real
    // number, it's just wrong, so this stays silent rather than showing
    // one (0023).
    const atCost = price?.costPrice !== null && price?.costPrice !== undefined && price.costBasis === 'per_unit' ? ` — ${money(overage * price.costPrice)} at cost` : ''
    return `${fmtQuantity(overage)} ${row.unit} over the Approximate Quantity${atCost}.`
  }
  // behind_rate — the classification still uses workingDaysRemaining
  // internally (overview.ts, unchanged), but that figure is a projection
  // (remaining ÷ a 30-day rate) and is deliberately not stated here. What
  // IS observable, and what's shown instead: how much has actually been
  // recorded lately, over how many days, against how much is left. The
  // reader draws their own conclusion about whether that pace is adequate
  // — NovaCore doesn't divide it into a day-count and hand over an
  // implied verdict.
  return `${fmtQuantity(row.quantityLast30)} ${row.unit} recorded in the last 30 days (${row.workingDaysLast30 ?? 0} working day${row.workingDaysLast30 === 1 ? '' : 's'}) — ${fmtQuantity(row.quantityRemaining)} ${row.unit} remains.`
}

/**
 * One "needs attention" row — shared by the per-contract Progress screen and
 * the company Overview's cross-contract aggregate. `contractLabel` is the
 * only thing that differs between the two: Progress already knows which
 * contract it's looking at, Overview is mixing rows from several and needs
 * to say which one each row is from.
 */
export function ProblemRow({ problem, priceByItem, contractLabel }: { problem: ProblemItem; priceByItem: Map<string, ItemPrice>; contractLabel?: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <ProblemIcon kind={problem.kind} />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="nc-numeric font-semibold text-nc-text">{problem.row.itemNumber}</span> <span className="text-nc-text-muted">{problem.row.description}</span>
          {contractLabel && <span className="ml-2 text-xs text-nc-text-subtle">· {contractLabel}</span>}
        </p>
        <p className="text-sm text-nc-text-muted">{problemSentence(problem, priceByItem)}</p>
      </div>
      <span className="shrink-0 rounded-full bg-nc-secondary px-2 py-0.5 text-xs font-medium text-nc-text-muted">{PROBLEM_KIND_LABEL[problem.kind]}</span>
    </div>
  )
}
