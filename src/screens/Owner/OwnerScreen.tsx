import { useEffect, useMemo, useState } from 'react'
import { IconAlertTriangle, IconClockPause } from '@tabler/icons-react'
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
import { Button, NotificationBanner, Select, Spinner } from '../../components/ui'

/**
 * The owner's phone surface. One sentence: are my money-makers on pace, and
 * where am I bleeding? Anything that doesn't serve that sentence isn't here
 * — no contract-wide rollup, no charts, no completion figure.
 *
 * Deliberately NOT the desktop Overview reflowed. That screen answers a
 * different question (a PM's "what's the state of everything"), and its
 * shape — tabs, a month table, stat cards in a grid — is what a laptop
 * affords. This is one cluster per scroll position, read with one thumb in
 * portrait.
 *
 * Which seats actually land here is a separate, unsettled question — the
 * routing condition in FieldHeader is a proxy, and its own comment explains
 * what for. Read that before assuming the audience is only the owner.
 *
 * NO COMPLETION METRIC, deliberately, and this is not an oversight to fix
 * later: the quantity-weighted "Contract complete" card was removed (0015)
 * because it weighted Mobilization the same as paving. Do not reintroduce
 * it under a different weighting. Do not compute CPI/SPI or any other
 * Earned Value figure either — every one of them needs a Planned Value
 * baseline (a time-phased budget), and NovaCore has no such thing. An EV
 * number computed without it is arithmetic wearing the costume of a
 * schedule forecast.
 */
export function OwnerScreen({ contract }: { contract: MyContract }) {
  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [progressRate, setProgressRate] = useState<ItemProgressRate[]>([])
  const [pins, setPins] = useState<PinnedItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [managing, setManaging] = useState(false)
  const [pinSelection, setPinSelection] = useState('')
  const [pinning, setPinning] = useState(false)
  const [unpinningId, setUnpinningId] = useState<string | null>(null)
  const [pinActionError, setPinActionError] = useState<string | null>(null)

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

  const progressByItem = useMemo(() => new Map(progressRate.map((p) => [p.itemId, p])), [progressRate])
  const priceByItem = useMemo(() => new Map(prices.map((p) => [p.itemId, p])), [prices])

  const pinnedItemIds = useMemo(() => new Set(pins.map((p) => p.itemId)), [pins])
  const pinnableItems = useMemo(
    () =>
      items
        .filter((i) => i.itemKind === 'unit_price' && !pinnedItemIds.has(i.id))
        .slice()
        .sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber)),
    [items, pinnedItemIds],
  )
  const hasPinnableItems = useMemo(() => items.some((i) => i.itemKind === 'unit_price'), [items])

  const pinnedRows = useMemo(
    () =>
      pins
        .map((pin) => ({ pin, progress: progressByItem.get(pin.itemId) }))
        .filter((row): row is { pin: PinnedItem; progress: ItemProgressRate } => row.progress !== undefined)
        .map((row) => ({
          ...row,
          // Absent, not zero, when there's no price — and omitted from the
          // block entirely (not blanked) for a seat without view_rates.
          margin: contract.viewRates
            ? computeMargin(
                row.progress.quantityToDate,
                priceByItem.get(row.pin.itemId)?.costPrice ?? null,
                priceByItem.get(row.pin.itemId)?.unitPrice ?? null,
                priceByItem.get(row.pin.itemId)?.costBasis ?? null,
              )
            : null,
        }))
        .sort((a, b) => compareItemCodes(a.progress.itemNumber, b.progress.itemNumber)),
    [pins, progressByItem, priceByItem, contract.viewRates],
  )

  // Over-quantity first — that's what costs money today — then stalled.
  // buildProblemList also ranks a 'behind_rate' kind, deliberately dropped
  // here: it's a projection off a 30-day rate, which is a PM's planning
  // input, not one of the two things this screen exists to answer.
  const problems = useMemo(() => buildProblemList(progressRate, new Date()).filter((p) => p.kind === 'over_quantity' || p.kind === 'stalled'), [progressRate])

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
    <div className="pb-10">
      {/* THE FOLD FIX.
          The full SandboxBanner (three lines of prose at 375px) pushed the
          pinned block from y≈213 to y≈339 — past the top third, on the only
          contract carrying money. The marking is NOT weakened to buy that
          space back: on this surface it becomes a sticky strip instead, so
          it is on screen at every scroll position rather than only at the
          top, which is strictly harder to miss than the banner it replaces
          — it just spends one line doing it instead of three. The full
          banner still renders unchanged on every other screen.
          Icon + text, never colour alone. */}
      {contract.isSandbox && (
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-nc-danger-bg px-4 py-2 text-nc-danger-text">
          <IconAlertTriangle size={16} stroke={2} className="shrink-0" />
          {/* The contract's own name is on the line directly below, so it
              isn't repeated here — that's what kept this to one line. */}
          <p className="text-label font-semibold uppercase tracking-wide">Sandbox — not a real contract, figures invented</p>
        </div>
      )}

      <div className="px-4 pt-3">
        <p className="truncate text-label font-semibold uppercase tracking-wide text-nc-text-muted">{contract.name}</p>
      </div>

      {status === 'loading' && (
        <div className="flex items-center gap-2 px-4 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && (
        <div className="px-4 pt-3">
          <NotificationBanner tone="danger">{loadError}</NotificationBanner>
        </div>
      )}

      {status === 'ready' && (
        <>
          {pinActionError && (
            <div className="px-4 pt-3">
              <NotificationBanner tone="danger">{pinActionError}</NotificationBanner>
            </div>
          )}

          {/* ── 1. Pinned Items — one block per scroll position ────────── */}
          <section className="px-4 pt-2">
            {pinnedRows.length === 0 ? (
              <div className="rounded-lg border border-nc-border bg-white p-4 shadow-sm">
                <p className="text-sm font-medium text-nc-text">Nothing pinned yet</p>
                <p className="mt-1 text-sm text-nc-text-muted">
                  {hasPinnableItems
                    ? 'Pin the Items where the money is. Each one shows quantity against Approximate Quantity, what’s left, and what it has earned.'
                    : 'This contract has no Unit Price Items, so there is nothing here to pin — a Lump Sum or Provisional Sum Item is not paid by quantity.'}
                </p>
                {hasPinnableItems && (
                  <div className="mt-3 flex flex-col gap-2">
                    <Select value={pinSelection} onChange={(e) => setPinSelection(e.target.value)} aria-label="Pin an Item">
                      <option value="">Choose an Item…</option>
                      {pinnableItems.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.itemNumber} — {i.description}
                        </option>
                      ))}
                    </Select>
                    <Button type="button" disabled={!pinSelection || pinning} onClick={() => void handlePin()}>
                      {pinning ? 'Pinning…' : 'Pin this Item'}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {pinnedRows.map(({ pin, progress, margin: pinMargin }) => (
                  <article key={pin.id} className="rounded-lg border border-nc-border bg-white p-4 shadow-sm">
                    <p className="text-sm">
                      <span className="nc-numeric font-semibold text-nc-text">{progress.itemNumber}</span> <span className="text-nc-text-muted">{progress.description}</span>
                    </p>

                    {/* Progress is the dominant figure in the block. */}
                    <p className={`nc-numeric mt-2 text-4xl font-semibold ${progress.isOverQuantity ? 'text-nc-over-text' : 'text-nc-text'}`}>{percent(progress.proportionComplete)}</p>

                    <p className="nc-numeric mt-1 text-sm text-nc-text">
                      {fmtQuantity(progress.quantityToDate)} of {fmtQuantity(progress.approximateQuantity, progress.unit)}
                    </p>
                    <p className="nc-numeric text-sm text-nc-text-muted">
                      {progress.isOverQuantity
                        ? `${fmtQuantity(progress.quantityToDate - progress.approximateQuantity)} ${progress.unit} over`
                        : `${fmtQuantity(progress.quantityRemaining, progress.unit)} left`}
                    </p>

                    {contract.viewRates && (
                      <p className="mt-2 border-t border-nc-border pt-2 text-sm text-nc-text-muted">
                        Est. margin to date <span className="nc-numeric font-semibold text-nc-text">{money(pinMargin)}</span>
                      </p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          {/* ── 2. Needs attention — over quantity, then stalled ───────── */}
          {problems.length > 0 && (
            <section className="mt-8 px-4">
              <h2 className="mb-2 text-label font-semibold uppercase tracking-wide text-nc-text-muted">Needs attention</h2>
              <div className="flex flex-col gap-3">
                {problems.map((p) => {
                  const over = p.kind === 'over_quantity'
                  return (
                    <article
                      key={`${p.kind}-${p.row.itemId}`}
                      className={`rounded-lg border bg-white p-4 shadow-sm ${over ? 'border-l-4 border-nc-border border-l-nc-over-text' : 'border-l-4 border-nc-border border-l-nc-warning-text'}`}
                    >
                      {/* Colour is never the only signal — icon and label carry it too. */}
                      <p className={`flex items-center gap-1.5 text-label font-semibold uppercase tracking-wide ${over ? 'text-nc-over-text' : 'text-nc-warning-text'}`}>
                        {over ? <IconAlertTriangle size={14} stroke={2} /> : <IconClockPause size={14} stroke={2} />}
                        {over ? 'Over quantity' : 'Stalled'}
                      </p>
                      <p className="mt-1.5 text-sm">
                        <span className="nc-numeric font-semibold text-nc-text">{p.row.itemNumber}</span> <span className="text-nc-text-muted">{p.row.description}</span>
                      </p>
                      <p className="nc-numeric mt-0.5 text-sm text-nc-text">
                        {over
                          ? `${fmtQuantity(p.row.quantityToDate - p.row.approximateQuantity)} ${p.row.unit} over the Approximate Quantity`
                          : p.row.lastWorkDate
                            ? `No activity since ${p.row.lastWorkDate} — not finished`
                            : 'No confirmed activity yet — not finished'}
                      </p>
                    </article>
                  )
                })}
              </div>
            </section>
          )}

          {/* Pin management lives at the BOTTOM, behind a disclosure — the
              owner sets this up once and then only reads. Keeping it off the
              top is what lets the first screenful be nothing but the answer
              to the screen's own sentence. */}
          {pinnedRows.length > 0 && (
            <section className="mt-8 px-4">
              <Button type="button" variant="ghost" onClick={() => setManaging((v) => !v)} aria-expanded={managing}>
                {managing ? 'Done' : 'Change pinned Items'}
              </Button>

              {managing && (
                <div className="mt-2 flex flex-col gap-3 rounded-lg border border-nc-border bg-white p-4 shadow-sm">
                  {pinnedRows.map(({ pin, progress }) => (
                    <div key={pin.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        <span className="nc-numeric font-semibold text-nc-text">{progress.itemNumber}</span> <span className="text-nc-text-muted">{progress.description}</span>
                      </span>
                      <Button type="button" variant="secondary" disabled={unpinningId === pin.id} onClick={() => void handleUnpin(pin.id)}>
                        {unpinningId === pin.id ? 'Unpinning…' : 'Unpin'}
                      </Button>
                    </div>
                  ))}

                  {pinnableItems.length > 0 && (
                    <div className="flex flex-col gap-2 border-t border-nc-border pt-3">
                      <Select value={pinSelection} onChange={(e) => setPinSelection(e.target.value)} aria-label="Pin an Item">
                        <option value="">Choose an Item…</option>
                        {pinnableItems.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.itemNumber} — {i.description}
                          </option>
                        ))}
                      </Select>
                      <Button type="button" disabled={!pinSelection || pinning} onClick={() => void handlePin()}>
                        {pinning ? 'Pinning…' : 'Pin this Item'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* The GC 52.01/52.04 caveat still has to be on the screen, but it
              is not one of the things the owner opens this to read — so it
              sits at the bottom rather than between him and the figures. */}
          <p className="mt-8 px-4 text-label text-nc-text-subtle">
            Value of Work is recorded quantity × tendered Unit Price — the Contractor’s own measure, not a Ministry-approved progress estimate.
          </p>
        </>
      )}
    </div>
  )
}
