import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconFileInvoice } from '@tabler/icons-react'
import { updateContractClaimTerms, type MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import {
  createProgressEstimate,
  fetchPriorClaimQuantities,
  fetchProgressEstimateSummaries,
  fetchProgressEstimates,
  type ProgressEstimate,
  type ProgressEstimateStatus,
  type ProgressEstimateSummary,
} from '../../lib/supabase/progressEstimates'
import { monthKeyFromDate, previousMonth } from '../../lib/calculations/overview'
import { formatDayLabel } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { rate } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Spinner } from '../../components/ui'

const STATUS_LABEL: Record<ProgressEstimateStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  received: 'Received',
  reconciled: 'Reconciled',
}

const STATUS_TONE_CLASS: Record<ProgressEstimateStatus, string> = {
  draft: 'bg-nc-warning-bg text-nc-warning-text',
  submitted: 'bg-nc-info-bg text-nc-info-text',
  received: 'bg-nc-ready-bg text-nc-ready-text',
  reconciled: 'bg-nc-success-bg text-nc-success-text',
}

function periodLabel(periodStart: string, periodEnd: string): string {
  return `${formatDayLabel(periodStart)} → ${formatDayLabel(periodEnd)}`
}

/** The 1st and last day of the calendar month before today — GC 52.01's own default cadence (monthly, in arrears), offered as a starting point a person can still change before creating the estimate. */
function defaultPeriod(): { start: string; end: string } {
  const { year, month } = previousMonth(monthKeyFromDate(new Date()))
  const pad = (n: number) => String(n).padStart(2, '0')
  const lastDay = new Date(year, month, 0).getDate()
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay)}` }
}

/**
 * The list of progress estimates (GC 52.00) for this contract — one row
 * per period, newest first, plus holdback retained to date across every
 * claim on the contract (§3). Opening a row goes to ProgressEstimateScreen,
 * where the previous/current/to-date/projected cycle for that period's
 * Items lives.
 *
 * "New estimate" (§1) creates one line for EVERY unit_price Item on the
 * contract, always — not only ones with confirmed records — because most
 * of Keywest's contracts have none: the claim is prepared from site
 * knowledge and judgement, and the screen has to work with nothing behind
 * it. Every line starts with claimed_quantity empty; previous_quantity is
 * carried forward from each Item's own most recent prior claim
 * (fetchPriorClaimQuantities). The records-derived proposal itself is
 * shown beside the input on the detail screen, not written here — see
 * that screen's own comment for why.
 */
export function ProgressEstimatesScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()

  const [items, setItems] = useState<Item[]>([])
  const [priorQuantityByItem, setPriorQuantityByItem] = useState<Map<string, number | null>>(new Map())
  const [estimates, setEstimates] = useState<ProgressEstimate[]>([])
  const [summaries, setSummaries] = useState<ProgressEstimateSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const canView = contract.viewRates || contract.prepareClaims
  const canPrepare = contract.prepareClaims

  const [showNewForm, setShowNewForm] = useState(false)
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [ministryReference, setMinistryReference] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [holdbackDraft, setHoldbackDraft] = useState(contract.holdbackPercent?.toString() ?? '')
  const [gstDraft, setGstDraft] = useState(contract.gstPercent?.toString() ?? '')
  const [termsError, setTermsError] = useState<string | null>(null)

  useEffect(() => {
    setHoldbackDraft(contract.holdbackPercent?.toString() ?? '')
    setGstDraft(contract.gstPercent?.toString() ?? '')
  }, [contract.holdbackPercent, contract.gstPercent])

  async function commitClaimTerms() {
    const holdbackPercent = holdbackDraft.trim() === '' ? null : Number(holdbackDraft)
    const gstPercent = gstDraft.trim() === '' ? null : Number(gstDraft)
    if (holdbackPercent === contract.holdbackPercent && gstPercent === contract.gstPercent) return
    setTermsError(null)
    try {
      await updateContractClaimTerms(contract.id, { holdbackPercent, gstPercent })
    } catch (err) {
      setTermsError(errorMessage(err))
    }
  }

  useEffect(() => {
    setStatus('loading')
    Promise.all([
      canView ? fetchItems(contract.id) : Promise.resolve([]),
      canView ? fetchPriorClaimQuantities(contract.id) : Promise.resolve(new Map<string, number | null>()),
      canView ? fetchProgressEstimates(contract.id) : Promise.resolve([]),
      canView ? fetchProgressEstimateSummaries(contract.id) : Promise.resolve([]),
    ])
      .then(([itemRows, priorQuantities, estimateRows, summaryRows]) => {
        setItems(itemRows)
        setPriorQuantityByItem(priorQuantities)
        setEstimates(estimateRows)
        setSummaries(summaryRows)
        const d = defaultPeriod()
        setPeriodStart(d.start)
        setPeriodEnd(d.end)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.id, canView])

  const sortedEstimates = useMemo(() => [...estimates].sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1)), [estimates])

  // holdback_retained_to_date is a running total (0046) — the most recent
  // period's own figure already IS the sum across every claim to date.
  const holdbackRetainedToDate = useMemo(() => {
    if (sortedEstimates.length === 0) return null
    return summaries.find((s) => s.progressEstimateId === sortedEstimates[0].id)?.holdbackRetainedToDate ?? null
  }, [sortedEstimates, summaries])

  async function handleCreate() {
    setCreating(true)
    setCreateError(null)
    try {
      const unitPriceItems = items.filter((i) => i.itemKind === 'unit_price')
      const lines = unitPriceItems.map((item) => ({ itemId: item.id, previousQuantity: priorQuantityByItem.get(item.id) ?? null }))
      const estimate = await createProgressEstimate(contract.id, { periodStart, periodEnd, ministryReference: ministryReference.trim() || null }, lines)
      navigate(`/progress-estimates/${estimate.id}`)
    } catch (err) {
      setCreateError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  if (status === 'ready' && !canView) {
    return (
      <div>
        <PageHeader title="Progress claims" subtitle={contract.name} />
        <EmptyState icon={<IconFileInvoice size={32} stroke={1.5} />} title="You don't have permission to view progress claims on this contract." />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Progress claims"
        subtitle={contract.name}
        actions={
          canPrepare ? (
            <Button type="button" variant={showNewForm ? 'secondary' : 'primary'} onClick={() => setShowNewForm((v) => !v)}>
              {showNewForm ? 'Cancel' : 'New claim'}
            </Button>
          ) : undefined
        }
      />
      <p className="mb-6 max-w-3xl text-xs text-nc-text-subtle">
        Claimed is what Keywest is claiming for the period — entered by a person, from site knowledge and judgement, not derived from a record. Certified is what the Ministry Representative
        estimated (GC 52.01). Paid is what was actually paid. The three routinely diverge — GC 52.04 — and the divergence is not an error.
      </p>

      <SandboxBanner contract={contract} />

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' && (
        <>
          <div className="mb-6 flex flex-wrap items-start gap-6 rounded-lg border border-nc-border bg-white p-4">
            {sortedEstimates.length > 0 && (
              <div>
                <div className="text-xs text-nc-text-muted">Holdback retained to date</div>
                <div className="nc-numeric text-2xl font-semibold text-nc-text">{rate(holdbackRetainedToDate)}</div>
                <p className="mt-1 max-w-xs text-xs text-nc-text-muted">Earned, and withheld from every progress payment so far — money Keywest has not yet been paid.</p>
              </div>
            )}
            <div className="flex gap-4">
              <label className="text-xs text-nc-text-muted">
                Holdback %
                <Input
                  className="mt-1 w-24"
                  inputMode="decimal"
                  value={holdbackDraft}
                  disabled={!canPrepare}
                  placeholder="From contract docs"
                  onChange={(e) => setHoldbackDraft(e.target.value)}
                  onBlur={() => void commitClaimTerms()}
                />
              </label>
              <label className="text-xs text-nc-text-muted">
                GST %
                <Input
                  className="mt-1 w-24"
                  inputMode="decimal"
                  value={gstDraft}
                  disabled={!canPrepare}
                  placeholder="From contract docs"
                  onChange={(e) => setGstDraft(e.target.value)}
                  onBlur={() => void commitClaimTerms()}
                />
              </label>
            </div>
            {termsError && <NotificationBanner tone="danger">{termsError}</NotificationBanner>}
          </div>

          {showNewForm && (
            <div className="mb-6 rounded-lg border border-nc-border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-nc-text">New claim</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="text-xs text-nc-text-muted">
                  Period start
                  <Input type="date" className="mt-1" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
                </label>
                <label className="text-xs text-nc-text-muted">
                  Period end
                  <Input type="date" className="mt-1" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
                </label>
                <label className="text-xs text-nc-text-muted">
                  Ministry reference (optional)
                  <Input className="mt-1" value={ministryReference} onChange={(e) => setMinistryReference(e.target.value)} placeholder="Not yet known" />
                </label>
              </div>
              <p className="mt-3 text-xs text-nc-text-muted">
                A line is created for every unit_price Item, empty — nothing is filled in for you. Where confirmed records exist for the period, the next screen offers that figure beside the
                input; you can use it or type your own. Lump Sum and Provisional Sum lines are added by hand on the next screen.
              </p>
              {createError && (
                <NotificationBanner tone="danger" className="mt-3">
                  {createError}
                </NotificationBanner>
              )}
              <div className="mt-3">
                <Button type="button" disabled={creating || !periodStart || !periodEnd} onClick={() => void handleCreate()}>
                  {creating ? 'Creating…' : 'Create claim'}
                </Button>
              </div>
            </div>
          )}

          {sortedEstimates.length === 0 ? (
            <EmptyState
              icon={<IconFileInvoice size={32} stroke={1.5} />}
              title="No progress claims yet."
              description={canPrepare ? 'Start one with "New claim" above.' : 'None have been created on this contract yet.'}
            />
          ) : (
            <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
              {sortedEstimates.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => navigate(`/progress-estimates/${e.id}`)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-nc-secondary"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-nc-text">{periodLabel(e.periodStart, e.periodEnd)}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE_CLASS[e.status]}`}>{STATUS_LABEL[e.status]}</span>
                  </div>
                  <span className="text-xs text-nc-text-muted">{e.ministryReference ?? 'No Ministry reference yet'}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
