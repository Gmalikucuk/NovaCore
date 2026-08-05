import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchItemProgressRate, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { fetchPinnedItems, pinItem, unpinItem, type PinnedItem } from '../../lib/supabase/pinnedItems'
import { buildProblemList } from '../../lib/calculations/overview'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { margin as computeMargin } from '../../lib/calculations/margin'
import { errorMessage } from '../../lib/errorMessage'
import { money, percent, quantity as fmtQuantity } from '../../lib/format'
import { Button, EmptyState, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner } from '../../components/ui'
import { ProblemRow } from '../../components/ProblemRow'

const ATTENTION_CAP = 5

/**
 * Picking an Item to pin is one obvious action: choose from a list, click
 * Pin. Shared between the empty state (where it doubles as the "what do I
 * do" affordance) and the ordinary picker under an existing pinned list.
 */
function PinPicker({
  items,
  value,
  onChange,
  onPin,
  pinning,
}: {
  items: readonly { id: string; itemNumber: string; description: string }[]
  value: string
  onChange: (id: string) => void
  onPin: () => void
  pinning: boolean
}) {
  return (
    <div className="flex flex-wrap items-end justify-center gap-2">
      <div className="w-72 text-left">
        <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="pin-item-select">
          Pin an Item
        </label>
        <Select id="pin-item-select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose an Item…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.itemNumber} — {i.description}
            </option>
          ))}
        </Select>
      </div>
      <Button type="button" disabled={!value || pinning} onClick={onPin}>
        {pinning ? 'Pinning…' : 'Pin'}
      </Button>
    </div>
  )
}

/**
 * "How far along are we" — Pinned Items (the PM/owner's own chosen watch
 * list) and Needs attention (over quantity, behind rate, stalled — worst
 * consequence first). Split out of the old combined Overview screen (which
 * used to hold this alongside the money/month content, behind a tab) into
 * its own Production-section route: this works without a Unit Price, that
 * didn't.
 *
 * Deliberately no completion figure here. The quantity-weighted "Contract
 * complete" blend was removed (0015) for weighting Mobilization the same as
 * paving; "Items in progress — X of Y" replaced it briefly but is gone too
 * now — a bare count of how many Items have started doesn't answer a real
 * question on its own, and padding this screen with a stat card just to fill
 * space it doesn't organically need is worse than leaving it thin. A later
 * brief reimagines this as a cumulative production curve; nothing here is a
 * placeholder for that in the meantime.
 */
export function ProgressScreen() {
  const contract = useOutletContext<MyContract>()

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [progressRate, setProgressRate] = useState<ItemProgressRate[]>([])
  const [pins, setPins] = useState<PinnedItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [pinSelection, setPinSelection] = useState('')
  const [pinning, setPinning] = useState(false)
  const [unpinningId, setUnpinningId] = useState<string | null>(null)
  const [pinActionError, setPinActionError] = useState<string | null>(null)

  const [attentionExpanded, setAttentionExpanded] = useState(false)

  useEffect(() => {
    setStatus('loading')
    Promise.all([
      fetchItems(contract.id),
      contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
      fetchItemProgressRate(contract.id),
      fetchPinnedItems(contract.id),
    ])
      .then(([itemRows, priceRows, progressRows, pinRows]) => {
        setItems(itemRows)
        setPrices(priceRows)
        setProgressRate(progressRows)
        setPins(pinRows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id, contract.viewRates])

  const priceByItem = useMemo(() => new Map(prices.map((p) => [p.itemId, p])), [prices])
  const progressByItem = useMemo(() => new Map(progressRate.map((p) => [p.itemId, p])), [progressRate])

  const problemList = useMemo(() => buildProblemList(progressRate, new Date()), [progressRate])
  const visibleProblems = attentionExpanded ? problemList : problemList.slice(0, ATTENTION_CAP)
  const hiddenProblemCount = problemList.length - visibleProblems.length

  const unitPriceItems = useMemo(() => items.filter((i) => i.itemKind === 'unit_price'), [items])

  const pinnedItemIds = useMemo(() => new Set(pins.map((p) => p.itemId)), [pins])
  const pinnableItems = useMemo(
    () =>
      unitPriceItems
        .filter((i) => !pinnedItemIds.has(i.id))
        .slice()
        .sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber)),
    [unitPriceItems, pinnedItemIds],
  )
  const pinnedRows = useMemo(
    () =>
      pins
        .map((pin) => ({ pin, progress: progressByItem.get(pin.itemId) }))
        .filter((row): row is { pin: PinnedItem; progress: ItemProgressRate } => row.progress !== undefined)
        .map((row) => ({
          ...row,
          margin: contract.viewRates
            ? computeMargin(
                row.progress.quantityToDate,
                priceByItem.get(row.pin.itemId)?.costPrice ?? null,
                priceByItem.get(row.pin.itemId)?.unitPrice ?? null,
                priceByItem.get(row.pin.itemId)?.costBasis ?? null,
              )
            : null,
        })),
    [pins, progressByItem, priceByItem, contract.viewRates],
  )

  async function handlePin() {
    if (!pinSelection) return
    setPinning(true)
    setPinActionError(null)
    try {
      const pin = await pinItem(contract.id, pinSelection)
      setPins((prev) => [...prev, pin])
      setPinSelection('')
    } catch (err) {
      setPinActionError(errorMessage(err))
    } finally {
      setPinning(false)
    }
  }

  async function handleUnpin(pinId: string) {
    setUnpinningId(pinId)
    setPinActionError(null)
    try {
      await unpinItem(pinId)
      setPins((prev) => prev.filter((p) => p.id !== pinId))
    } catch (err) {
      setPinActionError(errorMessage(err))
    } finally {
      setUnpinningId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Progress" subtitle={contract.name} />

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
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Pinned Items</h2>

            {pinActionError && (
              <NotificationBanner tone="danger" className="mb-3">
                {pinActionError}
              </NotificationBanner>
            )}

            {pinnedRows.length === 0 ? (
              <EmptyState
                title="Nothing pinned yet"
                description={
                  unitPriceItems.length === 0
                    ? "This contract has no Unit Price Items — Lump Sum and Provisional Sum Items don't have a quantity-against-Approximate-Quantity reading, so there's nothing here to pin."
                    : 'Pin the Items where the money actually is — quantity against Approximate Quantity, and margin to date if you have rate-viewing permission on this contract. Only Unit Price Items are pinnable; everything else stays out of the way until you ask for it.'
                }
                action={
                  unitPriceItems.length > 0 ? <PinPicker items={pinnableItems} value={pinSelection} onChange={setPinSelection} onPin={() => void handlePin()} pinning={pinning} /> : undefined
                }
              />
            ) : (
              <>
                <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
                  {pinnedRows.map(({ pin, progress, margin: pinMargin }) => (
                    <div key={pin.id} className="flex items-start justify-between gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          <span className="nc-numeric font-semibold text-nc-text">{progress.itemNumber}</span> <span className="text-nc-text-muted">{progress.description}</span>
                        </p>
                        <p className="nc-numeric text-sm text-nc-text">
                          {fmtQuantity(progress.quantityToDate)} of {fmtQuantity(progress.approximateQuantity, progress.unit)} — {percent(progress.proportionComplete)}
                        </p>
                        {contract.viewRates && (
                          <p className="text-sm text-nc-text-muted">
                            Est. margin to date: <span className="nc-numeric">{money(pinMargin)}</span>
                          </p>
                        )}
                      </div>
                      <Button type="button" variant="ghost" disabled={unpinningId === pin.id} onClick={() => void handleUnpin(pin.id)}>
                        {unpinningId === pin.id ? 'Unpinning…' : 'Unpin'}
                      </Button>
                    </div>
                  ))}
                </div>
                {pinnableItems.length > 0 && (
                  <div className="mt-3">
                    <PinPicker items={pinnableItems} value={pinSelection} onChange={setPinSelection} onPin={() => void handlePin()} pinning={pinning} />
                  </div>
                )}
              </>
            )}
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Needs attention</h2>
            {problemList.length === 0 ? (
              <p className="text-sm text-nc-text">Every Unit Price Item is progressing normally — nothing over quantity, nothing behind the recent rate, nothing stalled.</p>
            ) : (
              <>
                <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
                  {visibleProblems.map((p) => (
                    <ProblemRow key={`${p.kind}-${p.row.itemId}`} problem={p} priceByItem={priceByItem} />
                  ))}
                </div>
                {hiddenProblemCount > 0 && (
                  <Button type="button" variant="ghost" className="mt-2" onClick={() => setAttentionExpanded(true)}>
                    and {hiddenProblemCount} more
                  </Button>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  )
}
