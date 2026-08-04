import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconAlertTriangle, IconCircleCheck, IconFlag } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchContractQuantityRecords, fetchPendingQuantityRecords, confirmQuantityRecord, type PendingQuantityRecord } from '../../lib/supabase/quantityRecords'
import { fetchItemProgressRate, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { isOutlier, prospectiveOverage } from '../../lib/calculations/confirmations'
import { errorMessage } from '../../lib/errorMessage'
import { quantity as fmtQuantity, station } from '../../lib/format'
import { Button, Card, EmptyState, NotificationBanner, PageHeader, Spinner } from '../../components/ui'

const RECENT_SAMPLE_SIZE = 10

interface DateGroup {
  workDate: string
  records: PendingQuantityRecord[]
}

export function ConfirmQueueScreen() {
  const contract = useOutletContext<MyContract>()

  const [pending, setPending] = useState<PendingQuantityRecord[]>([])
  const [allRecords, setAllRecords] = useState<Awaited<ReturnType<typeof fetchContractQuantityRecords>>>([])
  const [progressRate, setProgressRate] = useState<ItemProgressRate[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [confirmingDate, setConfirmingDate] = useState<string | null>(null)

  function reload() {
    setStatus('loading')
    Promise.all([fetchPendingQuantityRecords(contract.id), fetchContractQuantityRecords(contract.id), fetchItemProgressRate(contract.id)])
      .then(([pendingRows, allRows, progressRows]) => {
        setPending(pendingRows)
        setAllRecords(allRows)
        setProgressRate(progressRows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }

  useEffect(reload, [contract.id])

  const progressByItem = useMemo(() => new Map(progressRate.map((p) => [p.itemId, p])), [progressRate])

  // Last RECENT_SAMPLE_SIZE confirmed quantities per item, most recent
  // first — the outlier check's baseline (see isOutlier's minimum-3 guard).
  const recentQuantitiesByItem = useMemo(() => {
    const byItem = new Map<string, typeof allRecords>()
    for (const r of allRecords) {
      if (r.status !== 'confirmed') continue
      const list = byItem.get(r.itemId) ?? []
      list.push(r)
      byItem.set(r.itemId, list)
    }
    const result = new Map<string, number[]>()
    for (const [itemId, records] of byItem) {
      const sorted = [...records].sort((a, b) => b.workDate.localeCompare(a.workDate))
      result.set(
        itemId,
        sorted.slice(0, RECENT_SAMPLE_SIZE).map((r) => r.quantity),
      )
    }
    return result
  }, [allRecords])

  const lastConfirmedDate = useMemo(() => {
    const confirmedDates = allRecords.filter((r) => r.status === 'confirmed').map((r) => r.workDate)
    return confirmedDates.length > 0 ? confirmedDates.sort().reverse()[0] : null
  }, [allRecords])

  // Grouped by work_date, newest first — she reviews the way the work
  // happened, not as a flat list. Corrections sort above ordinary records
  // within a date: a pending correction means a known-stale number is
  // currently counting, the more urgent read of the two.
  const groups = useMemo<DateGroup[]>(() => {
    const byDate = new Map<string, PendingQuantityRecord[]>()
    for (const r of pending) {
      const list = byDate.get(r.workDate) ?? []
      list.push(r)
      byDate.set(r.workDate, list)
    }
    return [...byDate.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([workDate, records]) => ({
        workDate,
        records: [...records].sort((a, b) => Number(b.supersedes !== null) - Number(a.supersedes !== null)),
      }))
  }, [pending])

  async function handleConfirm(id: string) {
    setConfirmingId(id)
    try {
      await confirmQuantityRecord(id)
      reload()
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setConfirmingId(null)
    }
  }

  async function handleConfirmAll(group: DateGroup) {
    setConfirmingDate(group.workDate)
    try {
      await Promise.all(group.records.map((r) => confirmQuantityRecord(r.id)))
      reload()
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setConfirmingDate(null)
    }
  }

  if (!contract.confirmQuantity) {
    return (
      <div>
        <PageHeader title="Confirm" subtitle={contract.name} />
        {contract.isSandbox && (
          <NotificationBanner tone="danger" className="mb-4">
            This is a sandbox contract for exercising every screen state — {contract.name} is not a real contract, and its Unit Prices are invented, not tendered figures.
          </NotificationBanner>
        )}
        <EmptyState title="Confirming quantity records needs confirm_quantity on this contract." />
      </div>
    )
  }

  const subtitle = `${contract.name}${status === 'ready' ? ` · ${pending.length} pending` : ''}`

  return (
    <div>
      <PageHeader title="Confirm" subtitle={subtitle} />

      {/* Same danger tone as Overview/Tracker/Rates/Items, without their
          font-medium weight — a working/review screen, not a read-once
          reading screen (see QuantityRecordsScreen's identical reasoning). */}
      {contract.isSandbox && (
        <NotificationBanner tone="danger" className="mb-4">
          This is a sandbox contract for exercising every screen state — {contract.name} is not a real contract, and its Unit Prices are invented, not tendered figures.
        </NotificationBanner>
      )}

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}
      {status === 'ready' && loadError && (
        <NotificationBanner tone="danger" className="mb-4">
          {loadError}
        </NotificationBanner>
      )}

      {status === 'ready' &&
        (groups.length === 0 ? (
          <EmptyState
            icon={<IconCircleCheck size={32} stroke={1.5} />}
            title="All records confirmed."
            description={lastConfirmedDate ? `Last confirmed entry: ${lastConfirmedDate}.` : undefined}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.workDate}>
                <div className="mb-2 flex items-center justify-between gap-4">
                  <h2 className="text-sm font-semibold text-nc-text-muted">
                    {group.workDate} · {group.records.length} record{group.records.length === 1 ? '' : 's'}
                  </h2>
                  <Button type="button" variant="secondary" disabled={confirmingDate === group.workDate} onClick={() => void handleConfirmAll(group)}>
                    {confirmingDate === group.workDate ? 'Confirming…' : 'Confirm all for this date'}
                  </Button>
                </div>

                <div className="flex flex-col gap-2">
                  {group.records.map((r) => {
                    const isCorrection = r.supersedes !== null
                    const progress = progressByItem.get(r.itemId)
                    const overage = progress ? prospectiveOverage(r, progress) : null
                    const isOver = overage !== null && overage > 0
                    const outlier = isOutlier(r.quantity, recentQuantitiesByItem.get(r.itemId) ?? [])
                    const difference = r.originalQuantity !== null ? r.quantity - r.originalQuantity : null

                    return (
                      <Card key={r.id} className={`flex flex-col gap-1 p-3 ${isCorrection ? 'border-l-4 border-l-nc-info-text' : ''}`}>
                        <div className="flex flex-wrap items-baseline gap-3">
                          <span className="font-semibold text-nc-text">{r.itemNumber}</span>
                          <span className="text-sm text-nc-text-muted">{r.description}</span>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 text-sm text-nc-text-muted">
                          {r.location && <span>{r.location}</span>}
                          {r.stationFrom !== null && (
                            <span className="nc-numeric">
                              {station(r.stationFrom)}
                              {r.stationTo !== null ? `–${station(r.stationTo)}` : ''}
                            </span>
                          )}
                          <span>Entered by {r.createdByName ?? 'Unknown'}</span>
                        </div>

                        {isCorrection ? (
                          <div className="mt-1 rounded-md bg-nc-info-bg px-3 py-2 text-sm text-nc-info-text">
                            <p>
                              Correction: <span className="nc-numeric font-semibold">{r.originalQuantity !== null ? fmtQuantity(r.originalQuantity, r.unit) : '—'}</span> →{' '}
                              <span className="nc-numeric font-semibold">{fmtQuantity(r.quantity, r.unit)}</span>
                              {difference !== null && <span className="nc-numeric"> ({difference > 0 ? '+' : ''}{fmtQuantity(difference)})</span>}
                            </p>
                            {r.originalQuantity !== null && (
                              <p className="mt-0.5 text-xs">
                                The original {fmtQuantity(r.originalQuantity, r.unit)} still counts until you confirm this.
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="nc-numeric text-sm text-nc-text">{fmtQuantity(r.quantity, r.unit)}</p>
                        )}

                        {r.note && <p className="text-sm text-nc-text-muted">{r.note}</p>}

                        {(isOver || outlier) && (
                          <div className="flex flex-wrap gap-2">
                            {isOver && overage !== null && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-nc-over-bg px-2 py-0.5 text-xs font-medium text-nc-over-text">
                                <IconAlertTriangle size={13} stroke={1.75} />
                                {fmtQuantity(overage)} {r.unit} over the Approximate Quantity
                              </span>
                            )}
                            {outlier && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-nc-warning-bg px-2 py-0.5 text-xs font-medium text-nc-warning-text">
                                <IconFlag size={13} stroke={1.75} />
                                Far outside this item's recent range
                              </span>
                            )}
                          </div>
                        )}

                        <div className="mt-1 flex gap-2">
                          <Button type="button" variant="secondary" disabled={confirmingId === r.id} onClick={() => void handleConfirm(r.id)}>
                            {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                          </Button>
                        </div>
                      </Card>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        ))}
    </div>
  )
}
