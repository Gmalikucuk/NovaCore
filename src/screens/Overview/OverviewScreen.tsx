import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconBuildingSkyscraper } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import type { ContractState } from '../../lib/supabase/contracts'
import { loadContractSummary, type ContractSummary } from '../../lib/supabase/contractSummary'
import { fetchViewPreferences, resetViewPreferences, saveViewPreferences } from '../../lib/supabase/viewPreferences'
import { aggregateFinancials, rowFinancials } from '../../lib/calculations/bidSummary'
import {
  buildAttention,
  contractCountsToward,
  contractNeedsStalledSuppression,
  contractParticipatesInProduction,
  coverageNote,
  DEFAULT_OVERVIEW_PREFERENCES,
  figureCoverage,
  moneyMakerRow,
  overQuantityValueAboveSchedule,
  pipelineFigures,
  sanitizeOverviewPreferences,
  type MoneyMakerRow,
  type MoneyMakerSortKey,
  type OverviewPreferences,
  type PipelineSortKey,
  type ProblemItem,
  type SortDir,
} from '../../lib/calculations/overview'
import { sumOrNull } from '../../lib/calculations/margin'
import type { ItemPrice } from '../../lib/supabase/prices'
import { errorMessage } from '../../lib/errorMessage'
import { percent, quantity as fmtQuantity, rate } from '../../lib/format'
import { Button, ContractStateTag, EmptyState, NotificationBanner, PageHeader, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'
import { ProblemRow } from '../../components/ProblemRow'

const PREFS_SCOPE = 'overview_dashboard'
const OVER_QUANTITY_CAP = 5
const PROBLEM_CAP = 5
const PROBLEM_ORDER: Record<ProblemItem['kind'], number> = { over_quantity: 0, behind_rate: 1, stalled: 2 }

// 'active' never appears here — contractNeedsStalledSuppression is false for
// it, so the suppression banner never fires for an actively-worked contract.
const CONTRACT_STATE_SUPPRESSION_REASON: Record<ContractState, string> = {
  pipeline: 'it hasn’t started yet',
  active: 'it is active',
  warranty_period: 'it is in its warranty period',
  closed_out: 'it is closed out',
  archived: 'it is archived',
}

function contractLabel(contract: ContractSummary['contract']): string {
  return contract.contractNo ? `${contract.contractNo} — ${contract.name}` : contract.name
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <IconArrowsSort size={13} stroke={1.75} className="inline-block opacity-40" />
  return dir === 'asc' ? <IconArrowUp size={13} stroke={2} className="inline-block" /> : <IconArrowDown size={13} stroke={2} className="inline-block" />
}

/**
 * Company level — every contract the signed-in user is a member of, rolled
 * up. Reimagined around the two questions the owner/CFO actually open this
 * screen to answer, in order: how much is in the pipeline (§1), then how
 * the money-makers are doing (§2). Margin (§3) is a secondary, opt-in view
 * — Keywest doesn't have cost for most Items and may never, so a blended
 * margin figure would be computed over a handful of Items and read as the
 * whole picture. Needs-attention (a genuine but third question) stays last.
 *
 * No single-contract mode and no picker — it always shows the whole book.
 * A row here is navigation, not a mode switch: clicking sets the active
 * contract and sends you into that contract's Finance (Months) if the seat
 * can price it, Production (Progress) otherwise.
 *
 * Sandbox contracts are excluded from every aggregate below (pipeline
 * totals, money-makers ranking, needs-attention) — same rule Portfolio's
 * own totals already use. They still get their own row in the pipeline
 * table, tagged, same as Portfolio.
 *
 * contract_state further narrows which contracts count toward which
 * figure — see overview.ts's own contractCountsToward/coverageNote
 * comments for the full rule table. archived is excluded from every
 * figure AND the pipeline table's row list entirely (removed from view,
 * by that state's own definition); pipeline counts toward contract value
 * and backlog but not earned, and is excluded from money-makers and
 * needs-attention (nothing has started, so there's no production to rank
 * and no schedule to be behind or stalled on); closed_out counts toward
 * earned only. A non-active state gets a small tag wherever its row could
 * otherwise be mistaken for an active one.
 *
 * Desktop-only by design (1400px and up) — no phone breakpoints here; a
 * separate mobile surface is planned.
 */
export function OverviewScreen() {
  const { contracts, setCurrentId } = useOutletContext<CurrentContractState>()
  const navigate = useNavigate()

  const [summaries, setSummaries] = useState<ContractSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [prefs, setPrefs] = useState<OverviewPreferences>(DEFAULT_OVERVIEW_PREFERENCES)
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const lastPersisted = useRef<string | null>(null)

  const [overQuantityExpanded, setOverQuantityExpanded] = useState(false)
  const [problemsExpanded, setProblemsExpanded] = useState(false)

  useEffect(() => {
    setStatus('loading')
    Promise.all(contracts.map(loadContractSummary))
      .then((rows) => {
        setSummaries(rows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contracts])

  // Preferences are pure convenience, never load-bearing — a fetch failure
  // or a malformed blob both just leave the screen on its own defaults,
  // never an error state of their own. lastPersisted tracks the exact
  // value last loaded from (or saved to) the server as a plain string —
  // the save-effect below compares against it directly rather than a
  // "have we saved once yet" flag, which is what actually guarantees a
  // load never triggers its own immediate re-save: a flag-based skip is
  // one render/effect-ordering assumption away from firing on the very
  // value it just loaded (which is exactly what happened during testing —
  // loading an existing non-default row still fired an immediate save).
  useEffect(() => {
    fetchViewPreferences(PREFS_SCOPE)
      .then((raw) => {
        const sanitized = sanitizeOverviewPreferences(raw)
        lastPersisted.current = JSON.stringify(sanitized)
        setPrefs(sanitized)
      })
      .catch(() => {
        lastPersisted.current = JSON.stringify(DEFAULT_OVERVIEW_PREFERENCES)
        setPrefs(DEFAULT_OVERVIEW_PREFERENCES)
      })
      .finally(() => setPrefsLoaded(true))
  }, [])

  useEffect(() => {
    if (!prefsLoaded) return
    const serialized = JSON.stringify(prefs)
    if (serialized === lastPersisted.current) return // unchanged since load (or since the last successful save) — nothing to persist
    const handle = setTimeout(() => {
      void saveViewPreferences(PREFS_SCOPE, prefs as unknown as Record<string, unknown>).then(() => {
        lastPersisted.current = serialized
      })
    }, 500)
    return () => clearTimeout(handle)
  }, [prefs, prefsLoaded])

  function resetToDefault() {
    lastPersisted.current = JSON.stringify(DEFAULT_OVERVIEW_PREFERENCES)
    setPrefs(DEFAULT_OVERVIEW_PREFERENCES)
    void resetViewPreferences(PREFS_SCOPE)
  }

  // archived is "removed from view" by its own definition — excluded here,
  // upstream of every aggregate and the pipeline table's row list both,
  // rather than filtered out at each individual call site.
  const realSummaries = useMemo(() => summaries.filter((s) => !s.contract.isSandbox && s.contract.contractState !== 'archived'), [summaries])
  // The pipeline table itself keeps sandbox rows (tagged, same as
  // Portfolio) — only archived drops out of the row list entirely.
  const visibleSummaries = useMemo(() => summaries.filter((s) => s.contract.contractState !== 'archived'), [summaries])
  // pipeline hasn't started: no Item progress to rank as a money-maker and
  // no schedule to be behind or stalled on. See contractParticipatesInProduction's own comment.
  const productionSummaries = useMemo(() => realSummaries.filter((s) => contractParticipatesInProduction(s.contract.contractState)), [realSummaries])
  // Margin is only ever worth offering when at least one real contract can
  // actually be priced — otherwise the toggle would just reveal columns of
  // em-dashes across the board.
  const marginAvailable = useMemo(() => realSummaries.some((s) => s.contract.viewRates), [realSummaries])

  // ── Pipeline band ─────────────────────────────────────────────────────
  const pipelineRows = useMemo(
    () =>
      visibleSummaries.map((s) => ({
        summary: s,
        figures: pipelineFigures(s.contract.tenderPrice, s.valueToDate),
      })),
    [visibleSummaries],
  )
  // Three totals, three different state-eligible subsets — see
  // contractCountsToward's own rule table (pipeline: value+backlog, not
  // earned; closed_out: earned only; warranty_period: all three, same as
  // active). archived never reaches this — already dropped from
  // realSummaries above.
  const contractValueTotal = useMemo(
    () => sumOrNull(realSummaries.filter((s) => contractCountsToward('contractValue', s.contract.contractState)).map((s) => s.contract.tenderPrice)),
    [realSummaries],
  )
  const earnedTotal = useMemo(
    () => sumOrNull(realSummaries.filter((s) => contractCountsToward('earned', s.contract.contractState)).map((s) => s.valueToDate)),
    [realSummaries],
  )
  const backlogTotal = useMemo(
    () =>
      sumOrNull(
        realSummaries.filter((s) => contractCountsToward('backlog', s.contract.contractState)).map((s) => pipelineFigures(s.contract.tenderPrice, s.valueToDate).backlog),
      ),
    [realSummaries],
  )
  // Coverage — how many of the real, non-archived contracts each total
  // actually reflects, and why the rest don't: excluded by contract_state
  // (a rule, not a gap) versus simply missing the underlying number (an
  // actual gap). Backlog reuses contract value's own coverage — same
  // eligible state set, same tenderPrice-presence check, exactly as before
  // this brief (the pre-existing approximation already treated the two as
  // one gap; not revisited here).
  const contractValueCoverage = useMemo(
    () => figureCoverage('contractValue', realSummaries.map((s) => ({ state: s.contract.contractState, hasData: s.contract.tenderPrice !== null }))),
    [realSummaries],
  )
  const earnedCoverage = useMemo(
    () => figureCoverage('earned', realSummaries.map((s) => ({ state: s.contract.contractState, hasData: s.valueToDate !== null }))),
    [realSummaries],
  )
  const contractValueNote = coverageNote(contractValueCoverage, 'have no tender price on file yet')
  const earnedNote = coverageNote(earnedCoverage, 'have no value recorded yet')

  const sortedPipelineRows = useMemo(() => {
    const dir = prefs.pipelineSortDir === 'asc' ? 1 : -1
    const value = (r: (typeof pipelineRows)[number]): number | null => {
      if (prefs.pipelineSortKey === 'value') return r.figures.contractValue
      if (prefs.pipelineSortKey === 'earned') return r.figures.earned
      if (prefs.pipelineSortKey === 'backlog') return r.figures.backlog
      return r.figures.percent
    }
    return [...pipelineRows].sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * dir
    })
  }, [pipelineRows, prefs.pipelineSortKey, prefs.pipelineSortDir])

  function togglePipelineSort(key: PipelineSortKey) {
    setPrefs((p) => (p.pipelineSortKey === key ? { ...p, pipelineSortDir: p.pipelineSortDir === 'asc' ? 'desc' : 'asc' } : { ...p, pipelineSortKey: key, pipelineSortDir: 'desc' }))
  }

  function openContract(contract: ContractSummary['contract']) {
    setCurrentId(contract.id)
    navigate(contract.viewRates ? '/finance' : '/progress')
  }

  // ── Money makers ──────────────────────────────────────────────────────
  const allMoneyMakerRows = useMemo(() => {
    const rows: MoneyMakerRow[] = []
    for (const s of productionSummaries) {
      const priceByItem = new Map(s.prices.map((p) => [p.itemId, p]))
      const progressByItem = new Map(s.progressRate.map((p) => [p.itemId, p]))
      const label = contractLabel(s.contract)
      for (const item of s.items) {
        rows.push(
          moneyMakerRow({ contractId: s.contract.id, contractLabel: label, contractState: s.contract.contractState, item, price: priceByItem.get(item.id), progress: progressByItem.get(item.id) }),
        )
      }
    }
    return rows
  }, [productionSummaries])

  const sortedMoneyMakerRows = useMemo(() => {
    const dir = prefs.moneyMakerSortDir === 'asc' ? 1 : -1
    const value = (r: MoneyMakerRow): number | null => {
      if (prefs.moneyMakerSortKey === 'value') return r.valueTendered
      if (prefs.moneyMakerSortKey === 'quantityPercent') return r.quantityPercent
      if (prefs.moneyMakerSortKey === 'valueEarned') return r.valueEarned
      return r.margin
    }
    return [...allMoneyMakerRows].sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * dir
    })
  }, [allMoneyMakerRows, prefs.moneyMakerSortKey, prefs.moneyMakerSortDir])

  const [moneyMakersExpanded, setMoneyMakersExpanded] = useState(false)
  const visibleMoneyMakerRows = moneyMakersExpanded ? sortedMoneyMakerRows : sortedMoneyMakerRows.slice(0, prefs.moneyMakerVisibleCount)
  const hiddenMoneyMakerCount = sortedMoneyMakerRows.length - visibleMoneyMakerRows.length

  function toggleMoneyMakerSort(key: MoneyMakerSortKey) {
    setPrefs((p) => (p.moneyMakerSortKey === key ? { ...p, moneyMakerSortDir: p.moneyMakerSortDir === 'asc' ? 'desc' : 'asc' } : { ...p, moneyMakerSortKey: key, moneyMakerSortDir: 'desc' }))
  }

  // Margin coverage — scoped to contracts the seat can actually price
  // (view_rates), and to the two cost-applicable kinds (unit_price,
  // lump_sum) — a Provisional Sum Item was never a margin candidate,
  // structurally, not just currently uncosted (matches aggregateFinancials'
  // own scoping on Rates).
  const marginCoverage = useMemo(() => {
    const financialRows = realSummaries
      .filter((s) => s.contract.viewRates)
      .flatMap((s) => {
        const priceByItem = new Map(s.prices.map((p) => [p.itemId, p]))
        return s.items.map((item) => {
          const price = priceByItem.get(item.id)
          return {
            itemKind: item.itemKind,
            financials: rowFinancials({
              itemKind: item.itemKind,
              approximateQuantity: item.approximateQuantity,
              provisionalSum: item.provisionalSum,
              costPrice: price?.costPrice ?? null,
              costBasis: price?.costBasis ?? null,
              unitPrice: price?.unitPrice ?? null,
            }),
          }
        })
      })
    return aggregateFinancials(financialRows)
  }, [realSummaries])

  // ── Needs attention (third band) ─────────────────────────────────────
  const now = useMemo(() => new Date(), [])
  const attentionByContract = useMemo(
    () =>
      productionSummaries.map((s) => ({
        summary: s,
        result: buildAttention(s.progressRate, now, contractNeedsStalledSuppression(s.contract.contractState)),
      })),
    [productionSummaries, now],
  )
  const taggedOverQuantity = useMemo(
    () => attentionByContract.flatMap(({ summary, result }) => result.overQuantity.map((problem) => ({ problem, contractLabel: contractLabel(summary.contract) }))),
    [attentionByContract],
  )
  const taggedProblems = useMemo(() => {
    const tagged = attentionByContract.flatMap(({ summary, result }) => result.problems.map((problem) => ({ problem, contractLabel: contractLabel(summary.contract) })))
    return tagged.slice().sort((a, b) => PROBLEM_ORDER[a.problem.kind] - PROBLEM_ORDER[b.problem.kind])
  }, [attentionByContract])
  const suppressedNotes = useMemo(
    () => attentionByContract.filter(({ result }) => result.suppressedStalledCount > 0).map(({ summary, result }) => ({ summary, count: result.suppressedStalledCount })),
    [attentionByContract],
  )

  const priceByItem = useMemo(() => {
    const map = new Map<string, ItemPrice>()
    for (const s of realSummaries) for (const p of s.prices) map.set(p.itemId, p)
    return map
  }, [realSummaries])

  const overQuantityValue = useMemo(() => overQuantityValueAboveSchedule(taggedOverQuantity.map((t) => t.problem), priceByItem), [taggedOverQuantity, priceByItem])

  const visibleOverQuantity = overQuantityExpanded ? taggedOverQuantity : taggedOverQuantity.slice(0, OVER_QUANTITY_CAP)
  const hiddenOverQuantityCount = taggedOverQuantity.length - visibleOverQuantity.length
  const visibleProblems = problemsExpanded ? taggedProblems : taggedProblems.slice(0, PROBLEM_CAP)
  const hiddenProblemCount = taggedProblems.length - visibleProblems.length

  const attentionBandHasContent = taggedOverQuantity.length > 0 || taggedProblems.length > 0 || suppressedNotes.length > 0

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={`${contracts.length} contract${contracts.length === 1 ? '' : 's'}`}
        actions={
          <Button type="button" variant="ghost" onClick={resetToDefault}>
            Reset to default
          </Button>
        }
      />

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' &&
        (summaries.length === 0 ? (
          <EmptyState icon={<IconBuildingSkyscraper size={32} stroke={1.5} />} title="No contracts yet." description="You aren't seated on a contract yet." />
        ) : (
          <>
            {/* §1 Pipeline — how much is in the pipeline, revenue first. */}
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Pipeline</h2>
              <div className="mb-4 grid grid-cols-3 gap-4">
                <StatCard label="Contract value under management" value={rate(contractValueTotal)} sub={contractValueNote ?? 'Real contracts only — sandbox excluded'} />
                <StatCard label="Earned to date" value={rate(earnedTotal)} sub={earnedNote ?? 'Real contracts only — sandbox excluded'} />
                <StatCard
                  label="Backlog remaining"
                  value={rate(backlogTotal)}
                  sub={contractValueNote ? `${contractValueNote} — same gap as contract value` : 'Real contracts only — sandbox excluded'}
                />
              </div>

              {marginAvailable && (
                <div className="mb-3 flex items-center gap-3">
                  <Button type="button" variant="secondary" onClick={() => setPrefs((p) => ({ ...p, marginOn: !p.marginOn }))} aria-pressed={prefs.marginOn}>
                    {prefs.marginOn ? 'Hide margin' : 'Show margin'}
                  </Button>
                  <label className="flex items-center gap-1.5 text-xs text-nc-text-muted">
                    <input
                      type="checkbox"
                      className="accent-nc-navy"
                      checked={prefs.showPipelineBacklog}
                      onChange={(e) => setPrefs((p) => ({ ...p, showPipelineBacklog: e.target.checked }))}
                    />
                    Backlog column
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-nc-text-muted">
                    <input
                      type="checkbox"
                      className="accent-nc-navy"
                      checked={prefs.showPipelinePercent}
                      onChange={(e) => setPrefs((p) => ({ ...p, showPipelinePercent: e.target.checked }))}
                    />
                    % earned column
                  </label>
                </div>
              )}

              {prefs.marginOn && (
                <NotificationBanner tone="info" className="mb-3">
                  Margin reflects cost entered on {marginCoverage.costCoverage.count} of {marginCoverage.costCoverage.total} cost-applicable Items across contracts you can price — most
                  Items have no cost recorded yet, so treat this as a partial read, not the whole picture.
                </NotificationBanner>
              )}

              <Table>
                <THead>
                  <TR>
                    <TH>Contract</TH>
                    <TH align="right" onClick={() => togglePipelineSort('value')} className="cursor-pointer select-none hover:bg-nc-border/40">
                      <span className="inline-flex items-center gap-1">
                        Contract value
                        <SortIndicator active={prefs.pipelineSortKey === 'value'} dir={prefs.pipelineSortDir} />
                      </span>
                    </TH>
                    <TH align="right" onClick={() => togglePipelineSort('earned')} className="cursor-pointer select-none hover:bg-nc-border/40">
                      <span className="inline-flex items-center gap-1">
                        Earned
                        <SortIndicator active={prefs.pipelineSortKey === 'earned'} dir={prefs.pipelineSortDir} />
                      </span>
                    </TH>
                    {prefs.showPipelineBacklog && (
                      <TH align="right" onClick={() => togglePipelineSort('backlog')} className="cursor-pointer select-none hover:bg-nc-border/40">
                        <span className="inline-flex items-center gap-1">
                          Backlog
                          <SortIndicator active={prefs.pipelineSortKey === 'backlog'} dir={prefs.pipelineSortDir} />
                        </span>
                      </TH>
                    )}
                    {prefs.showPipelinePercent && (
                      <TH align="right" onClick={() => togglePipelineSort('percent')} className="cursor-pointer select-none hover:bg-nc-border/40">
                        <span className="inline-flex items-center gap-1">
                          % earned
                          <SortIndicator active={prefs.pipelineSortKey === 'percent'} dir={prefs.pipelineSortDir} />
                        </span>
                      </TH>
                    )}
                    {prefs.marginOn && <TH align="right">Est. margin</TH>}
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {sortedPipelineRows.map(({ summary: s, figures }) => (
                    <TR key={s.contract.id} className="cursor-pointer hover:bg-nc-secondary/60" onClick={() => openContract(s.contract)}>
                      <TD>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-nc-text">{contractLabel(s.contract)}</span>
                          {s.contract.contractState !== 'active' && <ContractStateTag state={s.contract.contractState} />}
                          {s.contract.isSandbox && <span className="shrink-0 rounded-full bg-nc-danger-bg px-2 py-0.5 text-xs font-medium text-nc-danger-text">Sandbox</span>}
                        </div>
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {rate(figures.contractValue)}
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {rate(figures.earned)}
                      </TD>
                      {prefs.showPipelineBacklog && (
                        <TD align="right" className="nc-numeric">
                          {rate(figures.backlog)}
                        </TD>
                      )}
                      {prefs.showPipelinePercent && (
                        <TD align="right" className="nc-numeric">
                          {figures.percent === null ? '—' : percent(figures.percent)}
                        </TD>
                      )}
                      {prefs.marginOn && (
                        <TD align="right" className={`nc-numeric ${s.marginToDate !== null && s.marginToDate < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                          {rate(s.marginToDate)}
                        </TD>
                      )}
                      <TD align="right" dense>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={(e) => {
                            e.stopPropagation()
                            openContract(s.contract)
                          }}
                        >
                          Open {s.contract.viewRates ? 'Finance' : 'Progress'}
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </section>

            {/* §2 Money makers — the most useful thing on the screen. */}
            <section className="mb-8">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Money makers</h2>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-nc-text-muted">
                    <input
                      type="checkbox"
                      className="accent-nc-navy"
                      checked={prefs.showMoneyMakerQuantity}
                      onChange={(e) => setPrefs((p) => ({ ...p, showMoneyMakerQuantity: e.target.checked }))}
                    />
                    Quantity column
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-nc-text-muted">
                    <input
                      type="checkbox"
                      className="accent-nc-navy"
                      checked={prefs.showMoneyMakerPercent}
                      onChange={(e) => setPrefs((p) => ({ ...p, showMoneyMakerPercent: e.target.checked }))}
                    />
                    % column
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-nc-text-muted">
                    Rows:
                    <select
                      className="rounded border border-nc-border bg-white px-1.5 py-1"
                      value={prefs.moneyMakerVisibleCount}
                      onChange={(e) => setPrefs((p) => ({ ...p, moneyMakerVisibleCount: Number(e.target.value) }))}
                    >
                      {[5, 10, 25, 50].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              {allMoneyMakerRows.length === 0 ? (
                <p className="text-sm text-nc-text-muted">No Items on any contract you can see yet.</p>
              ) : (
                <>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Contract</TH>
                        <TH>Item #</TH>
                        <TH>Description</TH>
                        {prefs.showMoneyMakerQuantity && (
                          <TH align="right" onClick={() => toggleMoneyMakerSort('quantityPercent')} className="cursor-pointer select-none hover:bg-nc-border/40">
                            <span className="inline-flex items-center gap-1">
                              Quantity
                              <SortIndicator active={prefs.moneyMakerSortKey === 'quantityPercent'} dir={prefs.moneyMakerSortDir} />
                            </span>
                          </TH>
                        )}
                        {prefs.showMoneyMakerPercent && <TH align="right">%</TH>}
                        <TH align="right" onClick={() => toggleMoneyMakerSort('valueEarned')} className="cursor-pointer select-none hover:bg-nc-border/40">
                          <span className="inline-flex items-center gap-1">
                            Value earned / tendered
                            <SortIndicator active={prefs.moneyMakerSortKey === 'valueEarned' || prefs.moneyMakerSortKey === 'value'} dir={prefs.moneyMakerSortDir} />
                          </span>
                        </TH>
                        {prefs.marginOn && <TH align="right">Margin</TH>}
                      </TR>
                    </THead>
                    <TBody>
                      {visibleMoneyMakerRows.map((r) => (
                        <TR key={r.itemId}>
                          <TD className="text-xs text-nc-text-subtle">
                            <div className="flex items-center gap-1.5">
                              <span>{r.contractLabel}</span>
                              {r.contractState !== 'active' && <ContractStateTag state={r.contractState} />}
                            </div>
                          </TD>
                          <TD className="nc-numeric">{r.itemNumber}</TD>
                          <TD prose>
                            <div className="max-w-[220px] truncate" title={r.description}>
                              {r.description}
                            </div>
                            {r.quantityToDate === null && <div className="text-xs text-nc-text-subtle">Not quantity-measured</div>}
                          </TD>
                          {prefs.showMoneyMakerQuantity && (
                            <TD align="right" className="nc-numeric">
                              {r.quantityToDate === null ? '—' : `${fmtQuantity(r.quantityToDate)} of ${fmtQuantity(r.approximateQuantity)} ${r.unit}`}
                            </TD>
                          )}
                          {prefs.showMoneyMakerPercent && (
                            <TD align="right" className="nc-numeric">
                              {r.quantityPercent === null ? '—' : percent(r.quantityPercent)}
                            </TD>
                          )}
                          <TD align="right" className="nc-numeric">
                            <div>{rate(r.valueEarned)}</div>
                            <div className="text-xs text-nc-text-muted">of {rate(r.valueTendered)}</div>
                          </TD>
                          {prefs.marginOn && (
                            <TD align="right" className={`nc-numeric ${r.margin !== null && r.margin < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                              {rate(r.margin)}
                            </TD>
                          )}
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  {hiddenMoneyMakerCount > 0 && (
                    <Button type="button" variant="ghost" className="mt-2" onClick={() => setMoneyMakersExpanded(true)}>
                      and {hiddenMoneyMakerCount} more
                    </Button>
                  )}
                </>
              )}
            </section>

            {/* §4 Needs attention — a real third question, but not the one this screen opens to answer. Renders nothing at all when there's genuinely nothing to say. */}
            {attentionBandHasContent && (
              <section>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Needs attention</h2>

                {suppressedNotes.length > 0 && (
                  <NotificationBanner tone="info" className="mb-3">
                    {suppressedNotes.map(({ summary, count }) => (
                      <p key={summary.contract.id}>
                        Stalled detection is suppressed for {contractLabel(summary.contract)} — {CONTRACT_STATE_SUPPRESSION_REASON[summary.contract.contractState]}, and {count} Item
                        {count === 1 ? '' : 's'} would otherwise read as stalled.
                      </p>
                    ))}
                  </NotificationBanner>
                )}

                {taggedOverQuantity.length > 0 && (
                  <div className="mb-4">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-nc-text-subtle">Over quantity — not a fault</h3>
                    <p className="mb-2 text-sm text-nc-text-muted">
                      Ahead of tendered quantity, already earned. {overQuantityValue !== null && <>Roughly {rate(overQuantityValue)} earned above schedule, combined.</>}
                    </p>
                    <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
                      {visibleOverQuantity.map(({ problem, contractLabel: label }) => {
                        const pct = problem.row.approximateQuantity > 0 ? problem.row.quantityToDate / problem.row.approximateQuantity : null
                        return (
                          <div key={`${label}-${problem.row.itemId}`} className="flex items-start justify-between gap-3 px-4 py-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm">
                                <span className="nc-numeric font-semibold text-nc-text">{problem.row.itemNumber}</span>{' '}
                                <span className="text-nc-text-muted">{problem.row.description}</span>
                                <span className="ml-2 text-xs text-nc-text-subtle">· {label}</span>
                              </p>
                              <p className="text-sm text-nc-text-muted">
                                {fmtQuantity(problem.row.quantityToDate)} of {fmtQuantity(problem.row.approximateQuantity)} {problem.row.unit} tendered
                              </p>
                            </div>
                            <span className="nc-numeric shrink-0 rounded-full bg-nc-over-bg px-2 py-0.5 text-xs font-medium text-nc-over-text">{pct === null ? '—' : percent(pct)} of tendered quantity</span>
                          </div>
                        )
                      })}
                    </div>
                    {hiddenOverQuantityCount > 0 && (
                      <Button type="button" variant="ghost" className="mt-2" onClick={() => setOverQuantityExpanded(true)}>
                        and {hiddenOverQuantityCount} more
                      </Button>
                    )}
                  </div>
                )}

                {taggedProblems.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-nc-text-subtle">Behind rate or stalled</h3>
                    <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
                      {visibleProblems.map(({ problem, contractLabel: label }) => (
                        <ProblemRow key={`${label}-${problem.kind}-${problem.row.itemId}`} problem={problem} priceByItem={priceByItem} contractLabel={label} />
                      ))}
                    </div>
                    {hiddenProblemCount > 0 && (
                      <Button type="button" variant="ghost" className="mt-2" onClick={() => setProblemsExpanded(true)}>
                        and {hiddenProblemCount} more
                      </Button>
                    )}
                  </div>
                )}
              </section>
            )}
          </>
        ))}
    </div>
  )
}
