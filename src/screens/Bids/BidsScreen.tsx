import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconGavel } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import { createBid, createOwner, fetchAllBidItems, fetchBids, fetchOwners, type Bid, type BidItem, type BidType, type Owner, type OwnerType } from '../../lib/supabase/bids'
import { bidItemExtended, sumOrNull } from '../../lib/calculations/bidValue'
import { fetchViewPreferences, saveViewPreferences } from '../../lib/supabase/viewPreferences'
import { errorMessage } from '../../lib/errorMessage'
import { rate } from '../../lib/format'
import { BidStatusTag, Button, Card, EmptyState, Input, NotificationBanner, PageHeader, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const PREFS_SCOPE = 'bids_list'

type TypeFilter = 'all' | BidType
type StatusFilter = 'all' | 'open' | 'closed'

function sanitizeTypeFilter(raw: unknown): TypeFilter {
  return raw === 'tender' || raw === 'quote' ? raw : 'all'
}
function sanitizeStatusFilter(raw: unknown): StatusFilter {
  return raw === 'open' || raw === 'closed' ? raw : 'all'
}

/** open = still live (not_submitted/submitted); closed = decided (won/lost/no_award/withdrawn) — the one split worth filtering by at a glance, finer than that is what the status tag itself is for. */
function isOpenStatus(status: Bid['status']): boolean {
  return status === 'not_submitted' || status === 'submitted'
}

function bidValue(bid: Bid, itemsByBid: Map<string, BidItem[]>): number | null {
  const items = itemsByBid.get(bid.id) ?? []
  return sumOrNull(items.map((i) => bidItemExtended(i.quantity, i.sellPrice)))
}

/**
 * Name read, owner + type beneath it — same identity-line shape as Rates/
 * Tracker's ItemIdentity, applied to a bid instead of an Item. Reference
 * number rides along when present rather than getting its own column;
 * most bids (every quote) don't have one.
 */
function BidIdentity({ bid }: { bid: Bid }) {
  return (
    <div>
      <div className="max-w-[320px] truncate text-sm text-nc-text" title={bid.name}>
        {bid.name}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-nc-text-subtle">
        <span>{bid.ownerName}</span>
        <span className="inline-flex items-center rounded-full bg-nc-neutral-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-nc-neutral-text">
          {bid.bidType === 'tender' ? 'Tender' : 'Quote'}
        </span>
        {bid.referenceNo && <span className="truncate">· {bid.referenceNo}</span>}
      </div>
    </div>
  )
}

/**
 * New-bid entry, inline — same "grows in place, no modal" posture as
 * ContractStateCell's editing state. Owner is a picker over existing
 * owners with an inline "add new" fallback (owners accumulate — 0047 is
 * explicit there is no managed module for them), matching the item
 * library's own grow-on-demand shape.
 */
function NewBidForm({ owners, onCreated, onCancel, onOwnerCreated }: { owners: Owner[]; onCreated: (bid: Bid) => void; onCancel: () => void; onOwnerCreated: (owner: Owner) => void }) {
  const [bidType, setBidType] = useState<BidType>('tender')
  const [ownerId, setOwnerId] = useState<string>('')
  const [newOwnerName, setNewOwnerName] = useState('')
  const [newOwnerType, setNewOwnerType] = useState<OwnerType>('public')
  const [addingOwner, setAddingOwner] = useState(owners.length === 0)
  const [name, setName] = useState('')
  const [referenceNo, setReferenceNo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    if (!name.trim()) {
      setError('Give the bid a name.')
      return
    }
    setSaving(true)
    try {
      let resolvedOwnerId = ownerId
      if (addingOwner) {
        if (!newOwnerName.trim()) {
          setError('Give the owner a name.')
          setSaving(false)
          return
        }
        const owner = await createOwner({ name: newOwnerName.trim(), ownerType: newOwnerType })
        onOwnerCreated(owner)
        resolvedOwnerId = owner.id
      }
      if (!resolvedOwnerId) {
        setError('Choose an owner.')
        setSaving(false)
        return
      }
      const bid = await createBid({ bidType, ownerId: resolvedOwnerId, name: name.trim(), referenceNo: referenceNo.trim() || null })
      onCreated(bid)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-6 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-nc-text-muted">Type</label>
          <Select value={bidType} onChange={(e) => setBidType(e.target.value as BidType)}>
            <option value="tender">Tender</option>
            <option value="quote">Quote</option>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-nc-text-muted">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hwy 5 Snowshed Hill" />
        </div>

        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-nc-text-muted">Owner</label>
          {!addingOwner ? (
            <div className="flex items-center gap-2">
              <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Select an owner…</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
              <Button type="button" variant="ghost" onClick={() => setAddingOwner(true)}>
                New owner
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input value={newOwnerName} onChange={(e) => setNewOwnerName(e.target.value)} placeholder="Owner name" className="flex-1" />
              <Select value={newOwnerType} onChange={(e) => setNewOwnerType(e.target.value as OwnerType)} className="w-auto">
                <option value="public">Public</option>
                <option value="private">Private</option>
              </Select>
              {owners.length > 0 && (
                <Button type="button" variant="ghost" onClick={() => setAddingOwner(false)}>
                  Use existing
                </Button>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-nc-text-muted">Reference no. (optional)</label>
          <Input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="Owner's own tender/RFP number" />
        </div>
      </div>

      {error && (
        <NotificationBanner tone="danger" className="mt-3">
          {error}
        </NotificationBanner>
      )}

      <div className="mt-4 flex gap-2">
        <Button type="button" onClick={() => void submit()} disabled={saving}>
          {saving ? 'Creating…' : 'Create bid'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

/**
 * Company level, not contract-scoped — the pre-award half of the
 * lifecycle (0047). Reads useOutletContext directly, same as Portfolio/
 * Overview/Admin: there is no single resolved contract to bridge into,
 * because a bid isn't one yet.
 */
export function BidsScreen() {
  const { companyRights } = useOutletContext<CurrentContractState>()
  const navigate = useNavigate()

  const [bids, setBids] = useState<Bid[]>([])
  const [items, setItems] = useState<BidItem[]>([])
  const [owners, setOwners] = useState<Owner[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const prefsLoaded = useState({ current: false })[0]

  function load() {
    setStatus('loading')
    Promise.all([fetchBids(), fetchAllBidItems(), fetchOwners()])
      .then(([b, i, o]) => {
        setBids(b)
        setItems(i)
        setOwners(o)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }

  useEffect(() => {
    load()
    fetchViewPreferences(PREFS_SCOPE)
      .then((raw) => {
        setTypeFilter(sanitizeTypeFilter(raw?.typeFilter))
        setStatusFilter(sanitizeStatusFilter(raw?.statusFilter))
      })
      .catch(() => {})
      .finally(() => {
        prefsLoaded.current = true
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function changeTypeFilter(next: TypeFilter) {
    setTypeFilter(next)
    if (prefsLoaded.current) void saveViewPreferences(PREFS_SCOPE, { typeFilter: next, statusFilter })
  }
  function changeStatusFilter(next: StatusFilter) {
    setStatusFilter(next)
    if (prefsLoaded.current) void saveViewPreferences(PREFS_SCOPE, { typeFilter, statusFilter: next })
  }

  const itemsByBid = useMemo(() => {
    const m = new Map<string, BidItem[]>()
    for (const item of items) {
      const arr = m.get(item.bidId) ?? []
      arr.push(item)
      m.set(item.bidId, arr)
    }
    return m
  }, [items])

  const filteredBids = useMemo(
    () =>
      bids.filter((b) => {
        if (typeFilter !== 'all' && b.bidType !== typeFilter) return false
        if (statusFilter === 'open' && !isOpenStatus(b.status)) return false
        if (statusFilter === 'closed' && isOpenStatus(b.status)) return false
        return true
      }),
    [bids, typeFilter, statusFilter],
  )

  const openValue = useMemo(() => sumOrNull(bids.filter((b) => isOpenStatus(b.status)).map((b) => bidValue(b, itemsByBid))), [bids, itemsByBid])
  const wonValue = useMemo(() => sumOrNull(bids.filter((b) => b.status === 'won').map((b) => bidValue(b, itemsByBid))), [bids, itemsByBid])

  function handleCreated(bid: Bid) {
    setBids((prev) => [bid, ...prev])
    setCreating(false)
  }
  function handleOwnerCreated(owner: Owner) {
    setOwners((prev) => [...prev, owner].sort((a, b) => a.name.localeCompare(b.name)))
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Bids"
        subtitle="Pre-award"
        actions={
          companyRights.createBids && !creating ? (
            <Button type="button" onClick={() => setCreating(true)}>
              New bid
            </Button>
          ) : undefined
        }
      />

      {creating && <NewBidForm owners={owners} onCreated={handleCreated} onCancel={() => setCreating(false)} onOwnerCreated={handleOwnerCreated} />}

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' &&
        (bids.length === 0 ? (
          <EmptyState
            icon={<IconGavel size={32} stroke={1.5} />}
            title="No bids yet."
            description={companyRights.createBids ? 'Start with your first tender or quote.' : 'Nothing entered yet — nothing to do here without bid rights.'}
          />
        ) : (
          <>
            <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatCard label="Bids" value={String(bids.length)} sub={`${bids.filter((b) => isOpenStatus(b.status)).length} open`} />
              <StatCard label="Open value" value={rate(openValue)} sub="Not yet decided" />
              <StatCard label="Won value" value={rate(wonValue)} sub="Awarded to Keywest" />
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Select value={typeFilter} onChange={(e) => changeTypeFilter(e.target.value as TypeFilter)} className="w-auto">
                <option value="all">All types</option>
                <option value="tender">Tenders</option>
                <option value="quote">Quotes</option>
              </Select>
              <Select value={statusFilter} onChange={(e) => changeStatusFilter(e.target.value as StatusFilter)} className="w-auto">
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </Select>
            </div>

            {filteredBids.length === 0 ? (
              <p className="py-8 text-center text-sm text-nc-text-subtle">No bids match these filters.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Bid</TH>
                    <TH>Status</TH>
                    <TH align="right">Value</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {filteredBids.map((bid) => (
                    <TR key={bid.id} className="cursor-pointer hover:bg-nc-secondary/60" onClick={() => navigate(`/bids/${bid.id}`)}>
                      <TD>
                        <BidIdentity bid={bid} />
                      </TD>
                      <TD>
                        <BidStatusTag status={bid.status} />
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {rate(bidValue(bid, itemsByBid))}
                      </TD>
                      <TD align="right" dense>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/bids/${bid.id}`)
                          }}
                        >
                          Open
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </>
        ))}
    </div>
  )
}
