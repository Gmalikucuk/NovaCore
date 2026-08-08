import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconAlertTriangle, IconTable } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemProgressRate, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { compareItemCodes, sectionLabel, sectionPrefix } from '../../lib/calculations/naturalSort'
import { remainingDisplay } from '../../lib/calculations/trackerRemaining'
import { errorMessage } from '../../lib/errorMessage'
import { exportTrackerWorkbook } from '../../lib/export/trackerExport'
import { money, percent, quantity as fmtQuantity } from '../../lib/format'
import { Button, EmptyState, NotificationBanner, PageHeader, SandboxBanner, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

/**
 * Contract → Item. The matrix (Items × months, Qty/$ alternating) moved to
 * the Excel export, where GC 52.01's monthly Ministry progress estimate
 * already lives as a season-long artifact — see trackerExport.ts. This
 * screen answers a different question ("where are we on 05.03.03") with a
 * lean list: one row per Item, Remaining as the primary figure. Its own
 * history is one click away, at /tracker/:itemId — that's the "records"
 * step of the drill-down, not a column here.
 *
 * No weighted contract-completion figure, no CPI/SPI/Earned Value — no
 * Planned Value baseline exists to compute them against, and Remaining is
 * already the contract-native answer to "how much is left."
 */
export function TrackerScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()

  const [items, setItems] = useState<Item[]>([])
  const [progress, setProgress] = useState<ItemProgressRate[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    setStatus('loading')
    Promise.all([fetchItems(contract.id), fetchItemProgressRate(contract.id)])
      .then(([itemRows, progressRows]) => {
        setItems(itemRows)
        setProgress(progressRows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id])

  const progressByItem = useMemo(() => new Map(progress.map((p) => [p.itemId, p])), [progress])

  const sections = useMemo(() => {
    const byPrefix = new Map<string, Item[]>()
    for (const item of items) {
      const prefix = sectionPrefix(item.itemNumber)
      const list = byPrefix.get(prefix) ?? []
      list.push(item)
      byPrefix.set(prefix, list)
    }
    return [...byPrefix.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([prefix, sectionItems]) => ({
        prefix,
        label: sectionLabel(prefix),
        items: [...sectionItems].sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber)),
      }))
  }, [items])

  async function handleExport() {
    setExporting(true)
    setExportError(null)
    try {
      await exportTrackerWorkbook(contract)
    } catch (err) {
      setExportError(errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Tracker"
        subtitle={contract.name}
        actions={
          contract.extractReport && (
            <Button type="button" variant="secondary" disabled={exporting} onClick={() => void handleExport()}>
              {exporting ? 'Exporting…' : 'Export to Excel'}
            </Button>
          )
        }
      />

      {exportError && (
        <NotificationBanner tone="danger" className="mb-4">
          {exportError}
        </NotificationBanner>
      )}

      <SandboxBanner contract={contract} />

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' &&
        (sections.length === 0 ? (
          <EmptyState icon={<IconTable size={32} stroke={1.5} />} title="No items to track yet." description="Add items on the Items screen first." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Item #</TH>
                <TH>Description</TH>
                <TH>Unit</TH>
                <TH align="right">Approx. Qty</TH>
                <TH align="right">Remaining</TH>
              </TR>
            </THead>
            <TBody>
              {sections.map((section) => (
                <Fragment key={section.prefix}>
                  {/* A section break reads as structure — typography, no
                      fill — not as a data row with something to scan.
                      First section gets no top rule; every following one
                      does, so "Section" reads as a break between groups,
                      not a label glued to the group below it. */}
                  <TR>
                    <TD colSpan={5} className={`text-xs font-semibold uppercase tracking-wide text-nc-text-muted ${section.prefix === sections[0]?.prefix ? '' : 'border-t border-nc-border'}`}>
                      {section.label}
                    </TD>
                  </TR>
                  {section.items.map((item) => {
                    const unitPriced = item.itemKind === 'unit_price'
                    // v_item_progress_rate is scoped to unit_price Items only —
                    // Lump Sum/Provisional Sum never have a row here, but their
                    // own figures (percentComplete/provisionalSum/authorizedValue)
                    // already live directly on the Item, no separate fetch needed.
                    const itemProgress = unitPriced ? progressByItem.get(item.id) : undefined
                    const remaining = itemProgress ? remainingDisplay(itemProgress) : null

                    return (
                      <TR key={item.id}>
                        <TD className="nc-numeric">
                          <button
                            type="button"
                            className="text-nc-info-text underline decoration-dotted hover:decoration-solid"
                            onClick={() => navigate(`/tracker/${item.id}`)}
                            title={`View ${item.itemNumber}'s history`}
                          >
                            {item.itemNumber}
                          </button>
                        </TD>
                        <TD prose>
                          <div className="max-w-[420px] truncate" title={item.description}>
                            {item.description}
                          </div>
                        </TD>
                        <TD>{item.unit}</TD>
                        <TD align="right" className="nc-numeric">
                          {unitPriced ? fmtQuantity(item.approximateQuantity) : '—'}
                        </TD>
                        {/* Remaining, the primary frame — Approximate Quantity
                            minus quantity to date, contract-native, no
                            weighting. Over quantity keeps the same violet
                            tone plus a non-colour signal as the Finance
                            screen and its export already use for the same
                            condition — one rule, three surfaces. */}
                        <TD align="right" className={`nc-numeric ${remaining?.isOverQuantity ? 'bg-nc-over-bg font-semibold text-nc-over-text' : ''}`}>
                          {item.itemKind === 'lump_sum' ? (
                            `${percent(item.percentComplete != null ? item.percentComplete / 100 : null)} complete`
                          ) : item.itemKind === 'provisional_sum' ? (
                            `${money(item.authorizedValue)} of ${money(item.provisionalSum)}`
                          ) : remaining?.isOverQuantity ? (
                            <span className="inline-flex items-center justify-end gap-1">
                              <IconAlertTriangle size={13} stroke={1.75} />
                              {fmtQuantity(remaining.amount)} over
                            </span>
                          ) : (
                            fmtQuantity(remaining?.amount ?? null)
                          )}
                        </TD>
                      </TR>
                    )
                  })}
                </Fragment>
              ))}
            </TBody>
          </Table>
        ))}
    </div>
  )
}
