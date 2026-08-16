// ─────────────────────────────────────────────────────────────────────────
// Daily Work Report (Force Account, GC 49.00) arithmetic — block subtotals,
// markup resolution, and the two threshold questions. Block subtotals and
// markup amounts are NEVER stored (see 20260816160000's header) — this
// module is the one place they get derived, from line items plus
// contract_force_account_terms resolved via rateHistory.ts's asOfDate
// against the DWR's own work_date, never today's.
//
// Reads the real template's own formulas, not the prose description:
//   - Blocks A-E: a BASIC markup on the whole block subtotal, THEN an
//     ADDITIONAL markup (the contract's subcontractor_markup_pct) stacked
//     on top, but only on the portion of that subtotal flagged sub_flag
//     'y'. Two tiers, not one.
//   - Block A alone also carries payroll additive % and tool allowance %,
//     applied as their own dollar lines on the labour subtotal BEFORE the
//     basic markup — GC 49.03(a)(i)/(a)(ii) are labour cost components,
//     not markups themselves, but the real template's own row order (I30
//     Payroll Additives, I31 Tool Allowance, THEN I32 Basic markup) treats
//     them as part of what the basic markup applies to.
//   - Block F ("Invoiced Work — Negotiated Price and Credits") builds up
//     no markup at all when sub_flag = 'n' (`=H98` directly in the real
//     workbook, and its own note: "Basic mark-up is zero (n/a) on
//     negotiated price Work done by the Contractor"). For sub_flag = 'y'
//     — a subcontractor's own negotiated price — the template's I108/I109
//     cells both read 10%, the same figure as
//     contract_force_account_terms.subcontractor_markup_pct elsewhere, so
//     this module reuses that one rate rather than inventing a Block-F-
//     specific constant. ASSUMPTION, not directly observed: whether both
//     the "basic" and "additional" 10% actually STACK for a sub_flag='y'
//     Block F line, the way they do for A-E's subcontractor portion — the
//     one real filled example available had sub_flag='n' throughout Block
//     F, so this is inferred from A-E's pattern, not witnessed. Flagged
//     here for whoever next has a real subcontractor-negotiated DWR to
//     check against.
//   - sub_flag can be 'y', 'n', or 'a' — the template documents only
//     y(es)/n(o); what 'a' means was never confirmed against a real
//     example. Treated here as equivalent to 'n' (counts toward the
//     Contractor's own amount, no subcontractor markup) — the more
//     conservative reading (doesn't invent extra subcontractor markup) —
//     flagged, not assumed correct.
// ─────────────────────────────────────────────────────────────────────────

export type DwrBlock = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
export type SubFlag = 'y' | 'n' | 'a'

export interface DwrLineItem {
  id: string
  block: DwrBlock
  subFlag: SubFlag
  quantity: number
  rate: number
  amount: number
  subcontractorId: string | null
}

export interface ForceAccountTerms {
  effectiveDate: string
  gcVersionDate: string
  labourBasicPct: number
  labourReducedPct: number
  equipmentBasicPct: number
  equipmentReducedPct: number
  materialsBasicPct: number
  materialsReducedPct: number
  prepBasicPct: number
  prepReducedPct: number
  foodBasicPct: number
  foodReducedPct: number
  subcontractorMarkupPct: number
  reducedThresholdPct: number
  subcontractorCapAmount: number
}

const BLOCK_PCT_KEYS: Record<Exclude<DwrBlock, 'F'>, { basic: keyof ForceAccountTerms; reduced: keyof ForceAccountTerms }> = {
  A: { basic: 'labourBasicPct', reduced: 'labourReducedPct' },
  B: { basic: 'equipmentBasicPct', reduced: 'equipmentReducedPct' },
  C: { basic: 'materialsBasicPct', reduced: 'materialsReducedPct' },
  D: { basic: 'prepBasicPct', reduced: 'prepReducedPct' },
  E: { basic: 'foodBasicPct', reduced: 'foodReducedPct' },
}

/** The basic markup percentage for a block (A-E only — Block F has no basic-markup concept, see module header) at this DWR's reduced_markups state. */
export function basicMarkupPct(block: Exclude<DwrBlock, 'F'>, terms: ForceAccountTerms, reducedMarkups: boolean): number {
  const keys = BLOCK_PCT_KEYS[block]
  return reducedMarkups ? (terms[keys.reduced] as number) : (terms[keys.basic] as number)
}

export function lineItemsForBlock(lineItems: readonly DwrLineItem[], block: DwrBlock): DwrLineItem[] {
  return lineItems.filter((li) => li.block === block)
}

/** Sum of a set of lines' amounts — signed, so a Block F credit (a negative amount) subtracts, not errors. */
export function subtotal(lineItems: readonly DwrLineItem[]): number {
  return lineItems.reduce((sum, li) => sum + li.amount, 0)
}

/** The portion of a set of lines done by an unaffiliated subcontractor — sub_flag 'y' only. 'a' is treated as NOT subcontractor-flagged; see module header. */
function subcontractorPortion(lineItems: readonly DwrLineItem[]): number {
  return subtotal(lineItems.filter((li) => li.subFlag === 'y'))
}

export interface BlockResult {
  block: DwrBlock
  rawSubtotal: number
  payrollAdditiveAmount: number
  toolAllowanceAmount: number
  basicMarkupAmount: number
  additionalMarkupAmount: number
  total: number
}

/**
 * One block's full build-up: raw subtotal, Block A's own payroll/tool
 * additions (zero for every other block), the basic markup on the
 * (subtotal + additions), and the additional subcontractor markup on just
 * the subcontractor-flagged portion of the raw subtotal — stacked, not
 * folded into the basic markup's own base. payrollAdditivePct/
 * toolAllowancePct are resolved by the caller via asOfDate against the
 * DWR's own work_date (payroll_additive_rates/tool_allowance_rates, cost
 * registers) — this function only multiplies, it does not resolve "as of
 * when" itself.
 */
export function computeBlock(
  block: Exclude<DwrBlock, 'F'>,
  lineItems: readonly DwrLineItem[],
  terms: ForceAccountTerms,
  reducedMarkups: boolean,
  payrollAdditivePct: number,
  toolAllowancePct: number,
): BlockResult {
  const lines = lineItemsForBlock(lineItems, block)
  const raw = subtotal(lines)
  const isLabour = block === 'A'
  const payroll = isLabour ? raw * payrollAdditivePct : 0
  const tool = isLabour ? raw * toolAllowancePct : 0
  const markupBase = raw + payroll + tool
  const basic = markupBase * basicMarkupPct(block, terms, reducedMarkups)
  const additional = subcontractorPortion(lines) * terms.subcontractorMarkupPct
  return {
    block,
    rawSubtotal: raw,
    payrollAdditiveAmount: payroll,
    toolAllowanceAmount: tool,
    basicMarkupAmount: basic,
    additionalMarkupAmount: additional,
    total: markupBase + basic + additional,
  }
}

/**
 * Block F — negotiated price, no cost-buildup markup. sub_flag 'n' (the
 * Contractor's own negotiated work): markup is zero, matching the real
 * template's own wiring and its own note. sub_flag 'y' (a subcontractor's
 * own negotiated price): GC 49.03(f)(iii)'s 10% subcontractor markup
 * applies — reusing terms.subcontractorMarkupPct, doubled (basic +
 * additional, per the template's own two 10% cells) per the ASSUMPTION
 * flagged in this module's header, not directly observed.
 */
export function computeBlockF(lineItems: readonly DwrLineItem[], terms: ForceAccountTerms): BlockResult {
  const lines = lineItemsForBlock(lineItems, 'F')
  const raw = subtotal(lines)
  const subPortion = subcontractorPortion(lines)
  const basic = subPortion * terms.subcontractorMarkupPct
  const additional = subPortion * terms.subcontractorMarkupPct
  return {
    block: 'F',
    rawSubtotal: raw,
    payrollAdditiveAmount: 0,
    toolAllowanceAmount: 0,
    basicMarkupAmount: basic,
    additionalMarkupAmount: additional,
    total: raw + basic + additional,
  }
}

/** Every block's result plus the grand total across all six — TOTAL PAYABLE Prime + Sub, before any contractor/subcontractor amount split. */
export function computeAllBlocks(
  lineItems: readonly DwrLineItem[],
  terms: ForceAccountTerms,
  reducedMarkups: boolean,
  payrollAdditivePct: number,
  toolAllowancePct: number,
): { blocks: BlockResult[]; totalPayable: number } {
  const blocks: BlockResult[] = [
    computeBlock('A', lineItems, terms, reducedMarkups, payrollAdditivePct, toolAllowancePct),
    computeBlock('B', lineItems, terms, reducedMarkups, 0, 0),
    computeBlock('C', lineItems, terms, reducedMarkups, 0, 0),
    computeBlock('D', lineItems, terms, reducedMarkups, 0, 0),
    computeBlock('E', lineItems, terms, reducedMarkups, 0, 0),
    computeBlockF(lineItems, terms),
  ]
  return { blocks, totalPayable: blocks.reduce((sum, b) => sum + b.total, 0) }
}

// ─────────────────────────────────────────────────────────────────────────
// Threshold 1 — the 25%-of-Tender-Price reduced-markup trigger. Computed
// and pre-filled, never enforced (0048's brief, confirmed): the caller
// decides what to DO with this (pre-fill a checkbox, show an annotation);
// this function only answers the arithmetic question.
// ─────────────────────────────────────────────────────────────────────────

export interface ReducedMarkupSuggestion {
  cumulativeForceAccount: number
  tenderPrice: number
  ratio: number
  suggestReduced: boolean
}

/**
 * cumulativeForceAccount is the sum of TOTAL PAYABLE across every OTHER
 * certified DWR on this contract (the caller's job to gather — this
 * function is pure arithmetic, not a fetch) PLUS this DWR's own total,
 * against reduced_threshold_pct of the contract's Tender Price. Null
 * tenderPrice (not yet set — see tender_price's own "as at bid submission,
 * a person's judgement, never inferred" convention) means no suggestion is
 * possible; returns suggestReduced: false rather than guessing.
 */
export function suggestReducedMarkups(cumulativeForceAccount: number, tenderPrice: number | null, terms: ForceAccountTerms): ReducedMarkupSuggestion {
  if (tenderPrice === null || tenderPrice <= 0) {
    return { cumulativeForceAccount, tenderPrice: 0, ratio: 0, suggestReduced: false }
  }
  const ratio = cumulativeForceAccount / tenderPrice
  return { cumulativeForceAccount, tenderPrice, ratio, suggestReduced: ratio >= terms.reducedThresholdPct }
}

// ─────────────────────────────────────────────────────────────────────────
// Threshold 2 — the $100,000 per-subcontractor cap (GC 49.03(f)(iii)).
// Computed and surfaced, never enforced, and explicitly marked INCOMPLETE
// wherever a subcontractor-flagged line has no subcontractor_id — the
// source template itself never ties a line to a named subcontractor beyond
// a header list, so this total is only ever as complete as what's been
// attributed (0048's brief: "An incomplete total presented as complete is
// worse than no total").
// ─────────────────────────────────────────────────────────────────────────

export interface SubcontractorCapSummary {
  subcontractorId: string
  markupToDate: number
  capAmount: number
  overCap: boolean
}

export interface SubcontractorCapResult {
  bySubcontractor: SubcontractorCapSummary[]
  /** Total subcontractor-markup dollars from lines with NO subcontractor_id — real money, just not attributable to any one subcontractor's cap. Always show this figure alongside bySubcontractor; never fold it silently into "0 unattributed". */
  unattributedMarkup: number
}

/**
 * lineItemsWithMarkup pairs each line with the subcontractor-markup dollar
 * amount already attributed to it (the caller derives this from
 * computeBlock/computeBlockF's additionalMarkupAmount, apportioned back to
 * individual lines within a block — out of scope for this function, which
 * only aggregates what it's handed). Only sub_flag 'y' lines carry a
 * markup amount in practice; a line with markup > 0 but no
 * subcontractor_id falls into unattributedMarkup instead of a per-
 * subcontractor bucket.
 */
export function summarizeSubcontractorCap(
  lineItemsWithMarkup: readonly { subcontractorId: string | null; markupAmount: number }[],
  capAmount: number,
): SubcontractorCapResult {
  const bySub = new Map<string, number>()
  let unattributed = 0
  for (const { subcontractorId, markupAmount } of lineItemsWithMarkup) {
    if (markupAmount === 0) continue
    if (subcontractorId === null) {
      unattributed += markupAmount
      continue
    }
    bySub.set(subcontractorId, (bySub.get(subcontractorId) ?? 0) + markupAmount)
  }
  return {
    bySubcontractor: [...bySub.entries()].map(([subcontractorId, markupToDate]) => ({
      subcontractorId,
      markupToDate,
      capAmount,
      overCap: markupToDate > capAmount,
    })),
    unattributedMarkup: unattributed,
  }
}
