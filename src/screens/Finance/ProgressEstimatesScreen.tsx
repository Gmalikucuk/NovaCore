import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconFileInvoice } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices } from '../../lib/supabase/prices'
import { fetchEffectiveProductionRecords } from '../../lib/supabase/dashboard'
import { createProgressEstimate, fetchProgressEstimates, type ProgressEstimate, type ProgressEstimateStatus } from '../../lib/supabase/progressEstimates'
import { proposeClaimedFromRecords } from '../../lib/calculations/progressEstimates'
import { monthKeyFromDate, previousMonth } from '../../lib/calculations/overview'
import { formatDayLabel } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
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
 * per period, newest first. Opening a row goes to ProgressEstimateScreen,
 * where the claimed/certified/paid cycle for that period's Items lives.
 * "New estimate" proposes claimed figures from confirmed effective
 * records for unit_price Items only (proposeClaimedFromRecords's own doc
 * comment explains why Lump Sum/Provisional Sum aren't proposed) —
 * everything else on the estimate is entered by hand on the detail
 * screen.
 */
export function ProgressEstimatesScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()

  const [items, setItems] = useState<Item[]>([])
  const [unitPriceByItem, setUnitPriceByItem] = useState<Map<string, number | null>>(new Map())
  const [productionRecords, setProductionRecords] = useState<{ itemId: string; workDate: string; quantity: number }[]>([])
  const [estimates, setEstimates] = useState<ProgressEstimate[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const canManageEstimates = contract.setCost && contract.setUnitPrice

  const [showNewForm, setShowNewForm] = useState(false)
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [ministryReference, setMinistryReference] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    setStatus('loading')
    Promise.all([
      contract.viewRates ? fetchItems(contract.id) : Promise.resolve([]),
      contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
      contract.viewRates ? fetchEffectiveProductionRecords(contract.id) : Promise.resolve([]),
      contract.viewRates ? fetchProgressEstimates(contract.id) : Promise.resolve([]),
    ])
      .then(([itemRows, priceRows, records, estimateRows]) => {
        setItems(itemRows)
        setUnitPriceByItem(new Map(priceRows.map((p) => [p.itemId, p.unitPrice])))
        setProductionRecords(records)
        setEstimates(estimateRows)
        const d = defaultPeriod()
        setPeriodStart(d.start)
        setPeriodEnd(d.end)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id, contract.viewRates])

  const sortedEstimates = useMemo(() => [...estimates].sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1)), [estimates])

  async function handleCreate() {
    setCreating(true)
    setCreateError(null)
    try {
      const unitPriceItemIds = new Set(items.filter((i) => i.itemKind === 'unit_price').map((i) => i.id))
      const claims = proposeClaimedFromRecords(
        productionRecords.filter((r) => unitPriceItemIds.has(r.itemId)),
        periodStart,
        periodEnd,
        unitPriceByItem,
      )
      const estimate = await createProgressEstimate(contract.id, { periodStart, periodEnd, ministryReference: ministryReference.trim() || null }, claims)
      navigate(`/progress-estimates/${estimate.id}`)
    } catch (err) {
      setCreateError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  if (status === 'ready' && !contract.viewRates) {
    return (
      <div>
        <PageHeader title="Progress estimates" subtitle={contract.name} />
        <EmptyState icon={<IconFileInvoice size={32} stroke={1.5} />} title="You don't have permission to view progress estimates on this contract." />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Progress estimates"
        subtitle={contract.name}
        actions={
          canManageEstimates ? (
            <Button type="button" variant={showNewForm ? 'secondary' : 'primary'} onClick={() => setShowNewForm((v) => !v)}>
              {showNewForm ? 'Cancel' : 'New estimate'}
            </Button>
          ) : undefined
        }
      />
      <p className="mb-6 max-w-3xl text-xs text-nc-text-subtle">
        Claimed is what Keywest recorded for the period. Certified is what the Ministry Representative estimated (GC 52.01). Paid is what was actually paid. The three routinely diverge — GC
        52.04 — and the divergence is not an error.
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
          {showNewForm && (
            <div className="mb-6 rounded-lg border border-nc-border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-nc-text">New estimate</h2>
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
                Claimed quantity and value are proposed from confirmed records within this period, for unit_price Items only. Lump Sum and Provisional Sum lines are added by hand on the next
                screen.
              </p>
              {createError && (
                <NotificationBanner tone="danger" className="mt-3">
                  {createError}
                </NotificationBanner>
              )}
              <div className="mt-3">
                <Button type="button" disabled={creating || !periodStart || !periodEnd} onClick={() => void handleCreate()}>
                  {creating ? 'Creating…' : 'Create estimate'}
                </Button>
              </div>
            </div>
          )}

          {sortedEstimates.length === 0 ? (
            <EmptyState
              icon={<IconFileInvoice size={32} stroke={1.5} />}
              title="No progress estimates yet."
              description={canManageEstimates ? 'Start one with "New estimate" above.' : 'None have been created on this contract yet.'}
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
