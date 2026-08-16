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
import { quantity as fmtQuantity } from '../../lib/format'
import { Button, EmptyState, NotificationBanner, PageHeader, SandboxBanner, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

/**
 * Description read, item number as the drill-down beneath it — same
 * identity line as Rates and the month detail. The kind tag is the one
 * thing about an Item's identity that isn't a quantity: it's what tells a
 * reader why Remaining is about to read em-dash for this row (§3 below),
 * before they've scanned that far right.
 */
function ItemIdentity({ item, onOpen }: { item: Item; onOpen: () => void }) {
  return (
    <div>
      <div className="max-w-[260px] truncate text-sm text-nc-text" title={item.description}>
        {item.description}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs">
        <button type="button" className="text-nc-info-text underline decoration-dotted hover:decoration-solid" onClick={onOpen} title={`View ${item.itemNumber}'s history`}>
          {item.itemNumber}
        </button>
        {item.itemKind !== 'unit_price' && (
          <span className="inline-flex items-center rounded-full bg-nc-neutral-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-nc-neutral-text">
            {item.itemKind === 'lump_sum' ? 'Lump sum' : 'Provisional sum'}
          </span>
        )}
      </div>
    </div>
  )
}

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
 *
 * Remaining is Approximate Quantity minus quantity to date — a question
 * that only has an answer for a unit_price Item; Lump Sum and Provisional
 * Sum don't have an Approximate Quantity to be "remaining" against, so
 * their own row renders em-dash here rather than a different metric
 * (percent complete, authorized value) standing in under the same header.
 * Those two figures already have a home — Rates' own optional columns —
 * so nothing here goes unreachable, and "Remaining" keeps one meaning
 * instead of three.
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

  // Design-target pixel widths — see Rates' own COL_W comment for why
  // these are ratios (pctW below), not literal pixels. Only two fixed
  // columns here, so identity almost always clamps to its own maximum
  // rather than TABLE_TARGET_W ever binding.
  const COL_W = { quantity: 170, remaining: 170 }
  const IDENTITY_MIN_W = 220
  const IDENTITY_MAX_W = 300
  const TABLE_TARGET_W = 1360
  const fixedColumnsW = COL_W.quantity + COL_W.remaining
  const identityW = Math.min(IDENTITY_MAX_W, Math.max(IDENTITY_MIN_W, TABLE_TARGET_W - fixedColumnsW))
  const tableWidthPx = fixedColumnsW + identityW
  const pctW = (px: number) => `${Math.round((px / tableWidthPx) * 10000) / 100}%`

  return (
    // tableWidthPx caps the whole screen — title through table — the same
    // one-shared-measure rule Rates and the month detail now follow.
    <div style={{ maxWidth: tableWidthPx, marginLeft: 'auto', marginRight: 'auto' }}>
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
          <div style={{ width: '100%' }}>
            <Table style={{ tableLayout: 'fixed', width: '100%' }}>
              <THead>
                <TR>
                  <TH style={{ width: pctW(identityW) }}>Item</TH>
                  <TH align="right" style={{ width: pctW(COL_W.quantity) }}>
                    Approx. Qty
                  </TH>
                  <TH align="right" style={{ width: pctW(COL_W.remaining) }}>
                    Remaining
                  </TH>
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
                      <TD colSpan={3} className={`text-xs font-semibold uppercase tracking-wide text-nc-text-muted ${section.prefix === sections[0]?.prefix ? '' : 'border-t border-nc-border'}`}>
                        {section.label}
                      </TD>
                    </TR>
                    {section.items.map((item) => {
                      const unitPriced = item.itemKind === 'unit_price'
                      // v_item_progress_rate is scoped to unit_price Items
                      // only — Lump Sum/Provisional Sum never have a row
                      // here, and (per this screen's own doc comment) have
                      // no Approximate Quantity to be "remaining" against
                      // either, so Remaining renders em-dash for them
                      // rather than standing in a different figure.
                      const itemProgress = unitPriced ? progressByItem.get(item.id) : undefined
                      const remaining = itemProgress ? remainingDisplay(itemProgress) : null

                      return (
                        <TR key={item.id}>
                          <TD className="align-top">
                            <ItemIdentity item={item} onOpen={() => navigate(`/tracker/${item.id}`)} />
                          </TD>
                          <TD align="right" className="nc-numeric align-top">
                            {unitPriced ? fmtQuantity(item.approximateQuantity, item.unit) : '—'}
                          </TD>
                          {/* Remaining, the primary frame — Approximate
                              Quantity minus quantity to date, contract-
                              native, no weighting. Over quantity keeps the
                              same violet tone plus a non-colour signal as
                              the Finance screen and its export already use
                              for the same condition — one rule, three
                              surfaces. */}
                          <TD align="right" className={`nc-numeric align-top ${remaining?.isOverQuantity ? 'bg-nc-over-bg font-semibold text-nc-over-text' : ''}`}>
                            {!unitPriced ? (
                              '—'
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
          </div>
        ))}
    </div>
  )
}
