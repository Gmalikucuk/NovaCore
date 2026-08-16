import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import {
  createBidItem,
  createStandardItem,
  deleteBidItem,
  fetchBid,
  fetchBidItemCosts,
  fetchBidItems,
  fetchOwners,
  fetchStandardItems,
  updateBid,
  updateBidItem,
  updateBidStatus,
  upsertBidItemCost,
  type Bid,
  type BidItem,
  type BidItemCost,
  type BidStatus,
  type BidType,
  type CostSource,
  type Owner,
  type StandardItem,
} from '../../lib/supabase/bids'
import { bidItemCost as calcCost, bidItemExtended, bidItemMargin, BID_STATUS_LABEL, COST_SOURCE_LABEL, costCoverage, sumOrNull } from '../../lib/calculations/bidValue'
import { errorMessage } from '../../lib/errorMessage'
import { rate } from '../../lib/format'
import { BidStatusTag, Button, Card, Input, NotificationBanner, PageHeader, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const BID_STATUS_OPTIONS: BidStatus[] = ['not_submitted', 'submitted', 'won', 'lost', 'no_award', 'withdrawn']

/**
 * Name/type/owner/reference — plain fields when there's nothing to edit
 * (no createBids), inputs in place when there is. No separate edit mode:
 * a bid pre-award is a working draft, not a record to guard against
 * accidental change the way a confirmed quantity_record is (0047's own
 * reasoning for skipping an append-only guard here).
 */
function BidHeaderCard({ bid, owners, canEdit, onSaved }: { bid: Bid; owners: Owner[]; canEdit: boolean; onSaved: (bid: Bid) => void }) {
  const [name, setName] = useState(bid.name)
  const [bidType, setBidType] = useState<BidType>(bid.bidType)
  const [ownerId, setOwnerId] = useState(bid.ownerId)
  const [referenceNo, setReferenceNo] = useState(bid.referenceNo ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateBid(bid.id, { bidType, ownerId, name: name.trim(), referenceNo: referenceNo.trim() || null })
      onSaved(updated)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const dirty = name !== bid.name || bidType !== bid.bidType || ownerId !== bid.ownerId || referenceNo !== (bid.referenceNo ?? '')

  if (!canEdit) {
    return (
      <Card className="mb-6 p-4">
        <div className="text-lg font-medium text-nc-text">{bid.name}</div>
        <div className="mt-1 text-sm text-nc-text-subtle">
          {bid.ownerName} · {bid.bidType === 'tender' ? 'Tender' : 'Quote'}
          {bid.referenceNo && ` · ${bid.referenceNo}`}
        </div>
      </Card>
    )
  }

  return (
    <Card className="mb-6 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-nc-text-muted">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-nc-text-muted">Type</label>
          <Select value={bidType} onChange={(e) => setBidType(e.target.value as BidType)}>
            <option value="tender">Tender</option>
            <option value="quote">Quote</option>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-nc-text-muted">Owner</label>
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-nc-text-muted">Reference no. (optional)</label>
          <Input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
        </div>
      </div>
      {error && (
        <NotificationBanner tone="danger" className="mt-3">
          {error}
        </NotificationBanner>
      )}
      {dirty && (
        <div className="mt-3">
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </Card>
  )
}

/**
 * Status, and winning price only when it can mean anything — status =
 * 'lost' (bids_winning_price_only_when_lost, 0047). Switching status away
 * from 'lost' clears winningPrice in the same call, matching the database
 * constraint rather than letting a stale figure bounce off it.
 */
function StatusCard({ bid, canEdit, onSaved }: { bid: Bid; canEdit: boolean; onSaved: (bid: Bid) => void }) {
  const [status, setStatus] = useState<BidStatus>(bid.status)
  const [winningPrice, setWinningPrice] = useState<string>(bid.winningPrice === null ? '' : String(bid.winningPrice))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canEdit) {
    return (
      <Card className="p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-nc-text-muted">Status</div>
        <div className="mt-2">
          <BidStatusTag status={bid.status} />
        </div>
        {bid.status === 'lost' && bid.winningPrice !== null && <div className="mt-2 text-sm text-nc-text-subtle">Awarded at {rate(bid.winningPrice)}</div>}
      </Card>
    )
  }

  const dirty = status !== bid.status || winningPrice !== (bid.winningPrice === null ? '' : String(bid.winningPrice))

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const price = status === 'lost' && winningPrice.trim() !== '' ? Number(winningPrice) : null
      const updated = await updateBidStatus(bid.id, { status, winningPrice: price })
      onSaved(updated)
      setWinningPrice(updated.winningPrice === null ? '' : String(updated.winningPrice))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-nc-text-muted">Status</div>
      <div className="mt-2 flex flex-col gap-2">
        <Select
          value={status}
          onChange={(e) => {
            const next = e.target.value as BidStatus
            setStatus(next)
            if (next !== 'lost') setWinningPrice('')
          }}
        >
          {BID_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {BID_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        {status === 'lost' && (
          <div>
            <label className="mb-1 block text-xs font-medium text-nc-text-muted">Winning price (published award, if known)</label>
            <Input type="number" value={winningPrice} onChange={(e) => setWinningPrice(e.target.value)} placeholder="—" />
          </div>
        )}
      </div>
      {error && (
        <NotificationBanner tone="danger" className="mt-3">
          {error}
        </NotificationBanner>
      )}
      {dirty && (
        <div className="mt-3">
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </Card>
  )
}

/** One item line, editable in place when createBids/setBidCost allow it — a spreadsheet-like row, not a per-row edit-mode toggle: this is a working draft, per 0047's own reasoning for skipping an append-only guard. */
function BidItemRow({
  bid,
  item,
  cost,
  standardItems,
  canEditItem,
  canSetCost,
  canViewCosts,
  onItemSaved,
  onCostSaved,
  onDeleted,
  onStandardItemCreated,
}: {
  bid: Bid
  item: BidItem
  cost: BidItemCost | undefined
  standardItems: StandardItem[]
  canEditItem: boolean
  canSetCost: boolean
  canViewCosts: boolean
  onItemSaved: (item: BidItem) => void
  onCostSaved: (cost: BidItemCost) => void
  onDeleted: (id: string) => void
  onStandardItemCreated: (item: StandardItem) => void
}) {
  const [itemNumber, setItemNumber] = useState(item.itemNumber ?? '')
  const [description, setDescription] = useState(item.description)
  const [unit, setUnit] = useState(item.unit)
  const [quantity, setQuantity] = useState(String(item.quantity))
  const [sellPrice, setSellPrice] = useState(item.sellPrice === null ? '' : String(item.sellPrice))
  const [standardItemId, setStandardItemId] = useState(item.standardItemId ?? '')
  const [addingStandard, setAddingStandard] = useState(false)
  const [newStandardDescription, setNewStandardDescription] = useState('')
  const [newStandardUnit, setNewStandardUnit] = useState('')

  const [costPrice, setCostPrice] = useState(cost?.costPrice === null || cost?.costPrice === undefined ? '' : String(cost.costPrice))
  const [costSource, setCostSource] = useState<CostSource>(cost?.costSource ?? 'judgement')
  const [costSaved, setCostSaved] = useState(false)

  async function saveItem() {
    const parsedQuantity = Number(quantity)
    if (Number.isNaN(parsedQuantity)) return
    const updated = await updateBidItem(item.id, {
      itemNumber: bid.bidType === 'tender' ? itemNumber.trim() || null : null,
      description,
      unit,
      quantity: parsedQuantity,
      sellPrice: sellPrice.trim() === '' ? null : Number(sellPrice),
      standardItemId: bid.bidType === 'quote' ? standardItemId || null : null,
      sortOrder: item.sortOrder,
    })
    onItemSaved(updated)
  }

  async function addNewStandardItem() {
    if (!newStandardDescription.trim() || !newStandardUnit.trim()) return
    const created = await createStandardItem({ description: newStandardDescription.trim(), unit: newStandardUnit.trim() })
    onStandardItemCreated(created)
    setStandardItemId(created.id)
    setAddingStandard(false)
    setNewStandardDescription('')
    setNewStandardUnit('')
  }

  async function saveCost() {
    await upsertBidItemCost({
      bidItemId: item.id,
      bidId: bid.id,
      costPrice: costPrice.trim() === '' ? null : Number(costPrice),
      costSource: costPrice.trim() === '' ? null : costSource,
    })
    // No representation to read back for a set_bid_cost-only seat (see
    // upsertBidItemCost's own comment) — echo what was just typed locally
    // rather than pretending a re-fetch could confirm it for every seat.
    onCostSaved({ bidItemId: item.id, costPrice: costPrice.trim() === '' ? null : Number(costPrice), costSource: costPrice.trim() === '' ? null : costSource })
    setCostSaved(true)
    setTimeout(() => setCostSaved(false), 1500)
  }

  const extended = bidItemExtended(item.quantity, item.sellPrice)
  const margin = bidItemMargin(item.quantity, item.sellPrice, cost?.costPrice ?? null)

  return (
    <TR>
      {bid.bidType === 'tender' && (
        <TD>
          {canEditItem ? <Input value={itemNumber} onChange={(e) => setItemNumber(e.target.value)} onBlur={() => void saveItem()} className="w-28" /> : (item.itemNumber ?? '—')}
        </TD>
      )}
      <TD prose>
        {canEditItem ? (
          <div className="flex flex-col gap-1">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => void saveItem()} className="min-w-[220px]" />
            {bid.bidType === 'quote' &&
              (!addingStandard ? (
                <div className="flex items-center gap-1.5 text-xs">
                  <Select
                    value={standardItemId}
                    onChange={(e) => {
                      setStandardItemId(e.target.value)
                      void saveItem()
                    }}
                    className="w-auto text-xs"
                  >
                    <option value="">No library match</option>
                    {standardItems.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.description}
                      </option>
                    ))}
                  </Select>
                  <button type="button" className="text-nc-info-text underline decoration-dotted hover:decoration-solid" onClick={() => setAddingStandard(true)}>
                    New work type
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Input value={newStandardDescription} onChange={(e) => setNewStandardDescription(e.target.value)} placeholder="Work type" className="w-40 text-xs" />
                  <Input value={newStandardUnit} onChange={(e) => setNewStandardUnit(e.target.value)} placeholder="Unit" className="w-20 text-xs" />
                  <Button type="button" variant="secondary" onClick={() => void addNewStandardItem()}>
                    Add
                  </Button>
                </div>
              ))}
          </div>
        ) : (
          <div>
            <div>{item.description}</div>
            {item.standardItemId && <div className="text-xs text-nc-text-subtle">{standardItems.find((s) => s.id === item.standardItemId)?.description}</div>}
          </div>
        )}
      </TD>
      <TD>{canEditItem ? <Input value={unit} onChange={(e) => setUnit(e.target.value)} onBlur={() => void saveItem()} className="w-20" /> : item.unit}</TD>
      <TD align="right" className="nc-numeric">
        {canEditItem ? (
          <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} onBlur={() => void saveItem()} className="w-24 text-right" />
        ) : (
          item.quantity
        )}
      </TD>
      <TD align="right" className="nc-numeric">
        {canEditItem ? (
          <Input type="number" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} onBlur={() => void saveItem()} className="w-28 text-right" />
        ) : (
          rate(item.sellPrice)
        )}
      </TD>
      <TD align="right" className="nc-numeric">
        {rate(extended)}
      </TD>
      {canViewCosts && (
        <>
          <TD align="right" className="nc-numeric">
            {canSetCost ? (
              <div className="flex flex-col items-end gap-1">
                <Input type="number" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} onBlur={() => void saveCost()} className="w-24 text-right" />
                {costPrice.trim() !== '' && (
                  <Select value={costSource} onChange={(e) => setCostSource(e.target.value as CostSource)} onBlur={() => void saveCost()} className="w-auto text-xs">
                    {(Object.keys(COST_SOURCE_LABEL) as CostSource[]).map((s) => (
                      <option key={s} value={s}>
                        {COST_SOURCE_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                )}
                {costSaved && <span className="text-xs text-nc-success-text">Saved</span>}
              </div>
            ) : (
              <div>
                <div>{rate(cost?.costPrice ?? null)}</div>
                {cost?.costSource && <div className="text-xs text-nc-text-subtle">{COST_SOURCE_LABEL[cost.costSource]}</div>}
              </div>
            )}
          </TD>
          <TD align="right" className={`nc-numeric ${margin !== null && margin < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
            {rate(margin)}
          </TD>
        </>
      )}
      {canEditItem && (
        <TD align="right" dense>
          <Button type="button" variant="ghost" onClick={() => void deleteBidItem(item.id).then(() => onDeleted(item.id))}>
            Remove
          </Button>
        </TD>
      )}
    </TR>
  )
}

export function BidDetailScreen() {
  const { bidId } = useParams<{ bidId: string }>()
  const { companyRights } = useOutletContext<CurrentContractState>()
  const navigate = useNavigate()

  const [bid, setBid] = useState<Bid | null>(null)
  const [items, setItems] = useState<BidItem[]>([])
  const [costs, setCosts] = useState<BidItemCost[]>([])
  const [owners, setOwners] = useState<Owner[]>([])
  const [standardItems, setStandardItems] = useState<StandardItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!bidId) return
    setStatus('loading')
    Promise.all([fetchBid(bidId), fetchBidItems(bidId), fetchBidItemCosts(bidId), fetchOwners(), fetchStandardItems()])
      .then(([b, i, c, o, s]) => {
        setBid(b)
        setItems(i)
        setCosts(c)
        setOwners(o)
        setStandardItems(s)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [bidId])

  const costsByItem = useMemo(() => new Map(costs.map((c) => [c.bidItemId, c])), [costs])

  const totalValue = useMemo(() => sumOrNull(items.map((i) => bidItemExtended(i.quantity, i.sellPrice))), [items])
  const totalCost = useMemo(() => sumOrNull(items.map((i) => calcCost(i.quantity, costsByItem.get(i.id)?.costPrice ?? null))), [items, costsByItem])
  const totalMargin = useMemo(
    () => sumOrNull(items.map((i) => bidItemMargin(i.quantity, i.sellPrice, costsByItem.get(i.id)?.costPrice ?? null))),
    [items, costsByItem],
  )
  const coverage = useMemo(() => costCoverage(items.map((i) => ({ costSource: costsByItem.get(i.id)?.costSource ?? null }))), [items, costsByItem])

  function addLine() {
    if (!bid) return
    void createBidItem(bid.id, {
      itemNumber: null,
      description: '',
      unit: '',
      quantity: 0,
      sellPrice: null,
      standardItemId: null,
      sortOrder: items.length,
    }).then((created) => setItems((prev) => [...prev, created]))
  }

  if (status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-8 text-nc-text-muted">
        <Spinner />
        <span className="text-sm">Loading…</span>
      </div>
    )
  }
  if (status === 'error' || !bid) {
    return <NotificationBanner tone="danger">{loadError ?? 'Could not load this bid.'}</NotificationBanner>
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title={bid.name} subtitle="Bid" actions={<Button variant="ghost" onClick={() => navigate('/bids')}>{'← Back to Bids'}</Button>} />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <BidHeaderCard bid={bid} owners={owners} canEdit={companyRights.createBids} onSaved={setBid} />
        <StatusCard bid={bid} canEdit={companyRights.createBids} onSaved={setBid} />
      </div>

      <div className={`mb-6 grid grid-cols-1 gap-4 ${companyRights.viewBidCosts ? 'sm:grid-cols-3' : 'sm:grid-cols-1'}`}>
        <StatCard label="Bid value" value={rate(totalValue)} sub={`${items.length} line${items.length === 1 ? '' : 's'}`} />
        {companyRights.viewBidCosts && (
          <>
            <StatCard label="Est. cost" value={rate(totalCost)} sub={`${coverage.uncosted} line${coverage.uncosted === 1 ? '' : 's'} uncosted`} />
            <StatCard
              label="Est. margin"
              value={<span className={totalMargin !== null && totalMargin < 0 ? 'text-nc-danger-text' : ''}>{rate(totalMargin)}</span>}
              sub={`${coverage.vendorQuote} quoted · ${coverage.judgement} judged · ${coverage.calculatedBuild} calculated`}
            />
          </>
        )}
      </div>

      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-nc-text-subtle">No lines yet.</p>
      ) : (
        <Table>
          <THead>
            <TR>
              {bid.bidType === 'tender' && <TH>Item #</TH>}
              <TH>Description</TH>
              <TH>Unit</TH>
              <TH align="right">Quantity</TH>
              <TH align="right">Sell price</TH>
              <TH align="right">Value</TH>
              {companyRights.viewBidCosts && (
                <>
                  <TH align="right">Cost</TH>
                  <TH align="right">Margin</TH>
                </>
              )}
              {companyRights.createBids && <TH />}
            </TR>
          </THead>
          <TBody>
            {items.map((item) => (
              <BidItemRow
                key={item.id}
                bid={bid}
                item={item}
                cost={costsByItem.get(item.id)}
                standardItems={standardItems}
                canEditItem={companyRights.createBids}
                canSetCost={companyRights.setBidCost}
                canViewCosts={companyRights.viewBidCosts}
                onItemSaved={(updated) => setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))}
                onCostSaved={(updated) => setCosts((prev) => [...prev.filter((c) => c.bidItemId !== updated.bidItemId), updated])}
                onDeleted={(id) => setItems((prev) => prev.filter((i) => i.id !== id))}
                onStandardItemCreated={(created) => setStandardItems((prev) => [...prev, created].sort((a, b) => a.description.localeCompare(b.description)))}
              />
            ))}
          </TBody>
        </Table>
      )}

      {companyRights.createBids && (
        <div className="mt-4">
          <Button type="button" variant="secondary" onClick={addLine}>
            Add line
          </Button>
        </div>
      )}

      {companyRights.setBidCost && !companyRights.viewBidCosts && (
        <NotificationBanner tone="info" className="mt-6">
          You can enter costs on this bid, but not see the costs already entered — ask someone who holds cost visibility if you need to check a figure.
        </NotificationBanner>
      )}
    </div>
  )
}
