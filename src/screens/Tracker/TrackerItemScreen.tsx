import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { IconAlertTriangle, IconArrowLeft, IconCalendarPlus } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchItemMonths, fetchItemProgress, type ItemMonth, type ItemProgress } from '../../lib/supabase/monthlyPeriods'
import { fetchContractQuantityRecords } from '../../lib/supabase/quantityRecords'
import { formatMonthLabel, monthKeyFromDate, monthKeyToPeriod, previousMonth } from '../../lib/calculations/overview'
import { formatDayLabel } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { money, percent, quantity as fmtQuantity, station } from '../../lib/format'
import { Button, EmptyState, NotificationBanner, PageHeader, SandboxBanner, Spinner, StatusBadge, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

/**
 * The "records" step of contract → Item → its records. Everything here is
 * scoped to one Item: This period / Previous period / To date / Remaining —
 * the same billing-industry vocabulary the Finance month screen already
 * uses, for the same reason (consistency beats a locally-optimised table) —
 * followed by every record ever entered against it. No new fetches beyond
 * what TrackerScreen and QuantityRecordsScreen already call, filtered
 * client-side to this one Item; no month/day matrix to page through.
 */
export function TrackerItemScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()
  const { itemId } = useParams<{ itemId: string }>()

  const nowMonthKey = useMemo(() => monthKeyFromDate(new Date()), [])
  const previousMonthKey = useMemo(() => previousMonth(nowMonthKey), [nowMonthKey])
  const currentPeriod = monthKeyToPeriod(nowMonthKey)
  const previousPeriod = monthKeyToPeriod(previousMonthKey)

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [itemMonths, setItemMonths] = useState<ItemMonth[]>([])
  const [progress, setProgress] = useState<ItemProgress[]>([])
  const [records, setRecords] = useState<Awaited<ReturnType<typeof fetchContractQuantityRecords>>>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    setStatus('loading')
    Promise.all([
      fetchItems(contract.id),
      contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
      fetchItemMonths(contract.id),
      fetchItemProgress(contract.id),
      fetchContractQuantityRecords(contract.id),
    ])
      .then(([itemRows, priceRows, itemMonthRows, progressRows, recordRows]) => {
        setItems(itemRows)
        setPrices(priceRows)
        setItemMonths(itemMonthRows)
        setProgress(progressRows)
        setRecords(recordRows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id, contract.viewRates])

  const item = items.find((i) => i.id === itemId)
  const itemProgress = progress.find((p) => p.itemId === itemId)
  const unitPrice = contract.viewRates ? (prices.find((p) => p.itemId === itemId)?.unitPrice ?? null) : null

  const itemRecords = useMemo(() => [...records.filter((r) => r.itemId === itemId)].sort((a, b) => b.workDate.localeCompare(a.workDate)), [records, itemId])

  // Mirrors QuantityRecordsScreen's own badge logic — a confirmed entry with
  // a CONFIRMED correction against it reads "superseded" alongside its own
  // status, not replaced by it (the original stays visible, it just no
  // longer counts).
  const supersededByConfirmed = useMemo(() => {
    const set = new Set<string>()
    for (const r of itemRecords) {
      if (r.supersedes && r.status === 'confirmed') set.add(r.supersedes)
    }
    return set
  }, [itemRecords])

  if (status === 'ready' && !item) {
    return (
      <div>
        <PageHeader
          title="Item not found"
          actions={
            <Button type="button" variant="ghost" onClick={() => navigate('/tracker')}>
              <IconArrowLeft size={16} stroke={2} className="mr-1 inline" />
              Back to Tracker
            </Button>
          }
        />
        <EmptyState title="This Item doesn't exist on this contract." description="It may have been removed, or the link is stale." />
      </div>
    )
  }

  const unitPriced = item?.itemKind === 'unit_price'

  // Absent (no itemMonth row yet for the current, still-open month) reads
  // "—" — nothing entered yet, not a zero. A fully elapsed month with no row
  // is a real zero: the month happened and nothing was recorded against
  // this Item. Quantity to Date defaults to 0 rather than "—" once the Item
  // itself exists — same established rule as the old Tracker/Finance screens.
  const inCurrentPeriod = unitPriced ? itemMonths.find((m) => m.itemId === itemId && m.periodMonth === currentPeriod) : undefined
  const inPreviousPeriod = unitPriced ? itemMonths.find((m) => m.itemId === itemId && m.periodMonth === previousPeriod) : undefined
  const quantityInPeriod = unitPriced ? (inCurrentPeriod?.quantityInPeriod ?? null) : null
  const quantityInPreviousPeriod = unitPriced ? (inPreviousPeriod?.quantityInPeriod ?? 0) : null
  const quantityToDate = unitPriced ? (itemProgress?.quantityToDate ?? 0) : null
  const remaining = unitPriced && item ? item.approximateQuantity - (quantityToDate ?? 0) : null
  const isOverQuantity = remaining !== null && remaining < 0

  const valueInPeriod = unitPriced && unitPrice !== null && quantityInPeriod !== null ? quantityInPeriod * unitPrice : null
  const valueInPreviousPeriod = unitPriced && unitPrice !== null && quantityInPreviousPeriod !== null ? quantityInPreviousPeriod * unitPrice : null
  const valueToDate = unitPriced && unitPrice !== null && quantityToDate !== null ? quantityToDate * unitPrice : null

  return (
    <div>
      <PageHeader
        title={item?.itemNumber ?? '…'}
        subtitle={item ? `${item.description} · ${contract.name}` : contract.name}
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate('/tracker')}>
              <IconArrowLeft size={16} stroke={2} className="mr-1 inline" />
              Back to Tracker
            </Button>
            {itemId && (
              <Button type="button" variant="secondary" onClick={() => navigate(`/daily-entry?itemId=${itemId}`)}>
                Open in Daily Entry
              </Button>
            )}
          </div>
        }
      />

      <SandboxBanner contract={contract} />

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' && item && (
        <>
          <section className="mb-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Progress</h2>
            {unitPriced ? (
              <Table>
                <THead>
                  <TR>
                    <TH>&nbsp;</TH>
                    <TH align="right">This period — {formatMonthLabel(nowMonthKey)}</TH>
                    <TH align="right">Previous period — {formatMonthLabel(previousMonthKey)}</TH>
                    <TH align="right">To date</TH>
                    <TH align="right">Remaining</TH>
                  </TR>
                </THead>
                <TBody>
                  <TR>
                    <TD className="font-medium text-nc-text-muted">Quantity</TD>
                    <TD align="right" className="nc-numeric">
                      {fmtQuantity(quantityInPeriod, item.unit)}
                    </TD>
                    <TD align="right" className="nc-numeric">
                      {fmtQuantity(quantityInPreviousPeriod, item.unit)}
                    </TD>
                    <TD align="right" className="nc-numeric">
                      {fmtQuantity(quantityToDate, item.unit)}
                    </TD>
                    {/* Remaining, the primary frame — Approximate Quantity minus
                        quantity to date, contract-native, no weighting, no
                        derived completion figure. Over quantity carries the
                        same violet tone plus a non-colour signal as Finance
                        and its export use for the same condition. */}
                    <TD align="right" className={`nc-numeric ${isOverQuantity ? 'bg-nc-over-bg font-semibold text-nc-over-text' : ''}`}>
                      {isOverQuantity ? (
                        <span className="inline-flex items-center justify-end gap-1">
                          <IconAlertTriangle size={13} stroke={1.75} />
                          {fmtQuantity(Math.abs(remaining as number))} over
                        </span>
                      ) : (
                        fmtQuantity(remaining)
                      )}
                    </TD>
                  </TR>
                  {contract.viewRates && (
                    <TR>
                      <TD className="font-medium text-nc-text-muted">Value</TD>
                      <TD align="right" className="nc-numeric">
                        {money(valueInPeriod)}
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {money(valueInPreviousPeriod)}
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {money(valueToDate)}
                      </TD>
                      {/* No "value remaining" — that would be a projection
                          (remaining qty × unit price), not a recorded fact,
                          and this frame stays contract-native throughout. */}
                      <TD align="right" className="nc-numeric text-nc-text-muted">
                        —
                      </TD>
                    </TR>
                  )}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-nc-text">
                {item.itemKind === 'lump_sum'
                  ? `${percent(itemProgress?.percentComplete != null ? itemProgress.percentComplete / 100 : null)} complete.`
                  : `${money(itemProgress?.authorizedValue ?? null)} of ${money(itemProgress?.provisionalSum ?? null)} authorized.`}
              </p>
            )}
          </section>

          {/* Lump Sum/Provisional Sum Items are never recorded by quantity
              (GC 52.03(b)/(c) — paid on percent complete or value
              authorized) — no entry screen ever lets one be picked for a new
              record, so this section would only ever render a permanently-
              empty state. Omitted rather than shown empty, same reasoning
              as the item pickers that exclude these two kinds already. */}
          {unitPriced && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Records</h2>
              {itemRecords.length === 0 ? (
                <EmptyState icon={<IconCalendarPlus size={32} stroke={1.5} />} title="No records yet for this Item." />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Date</TH>
                      <TH>Location</TH>
                      <TH align="right">Station</TH>
                      <TH align="right">Quantity</TH>
                      <TH>Note</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {itemRecords.map((r) => (
                      <TR key={r.id}>
                        <TD className="nc-numeric">{formatDayLabel(r.workDate)}</TD>
                        <TD prose>{r.location}</TD>
                        <TD align="right" className="nc-numeric">
                          {r.stationFrom !== null ? `${station(r.stationFrom)}${r.stationTo !== null ? `–${station(r.stationTo)}` : ''}` : ''}
                        </TD>
                        <TD align="right" className="nc-numeric">
                          {fmtQuantity(r.quantity, item.unit)}
                        </TD>
                        <TD prose>{r.note}</TD>
                        <TD>
                          <div className="flex flex-wrap items-center gap-1">
                            <StatusBadge status={r.status} />
                            {supersededByConfirmed.has(r.id) && <StatusBadge status="superseded" />}
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
