import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { IconArrowLeft } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices } from '../../lib/supabase/prices'
import { fetchEffectiveProductionRecords } from '../../lib/supabase/dashboard'
import {
  addProgressEstimateItem,
  fetchProgressEstimate,
  fetchProgressEstimateItems,
  updateProgressEstimateItemCertified,
  updateProgressEstimateItemClaim,
  updateProgressEstimateItemDispute,
  updateProgressEstimateStatus,
  type ProgressEstimate,
  type ProgressEstimateItem,
  type ProgressEstimateStatus,
} from '../../lib/supabase/progressEstimates'
import { claimFieldForKind, proposeClaimedFromRecords, variance } from '../../lib/calculations/progressEstimates'
import { sumOrNull } from '../../lib/calculations/margin'
import { formatDayLabel } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { quantity as fmtQuantity, money as fmtMoney } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, Table, TBody, TD, TH, THead, TR, Textarea } from '../../components/ui'

const STATUS_OPTIONS: ProgressEstimateStatus[] = ['draft', 'submitted', 'received', 'reconciled']
const STATUS_LABEL: Record<ProgressEstimateStatus, string> = { draft: 'Draft', submitted: 'Submitted', received: 'Received', reconciled: 'Reconciled' }

function parseNum(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

function fieldLabel(field: 'quantity' | 'percent' | 'value'): string {
  return field === 'quantity' ? 'Quantity' : field === 'percent' ? '% complete' : 'Value'
}

function formatField(field: 'quantity' | 'percent' | 'value', value: number | null, unit: string): string {
  if (value === null) return '—'
  if (field === 'percent') return `${value.toFixed(1)}%`
  if (field === 'value') return fmtMoney(value)
  return fmtQuantity(value, unit)
}

/**
 * One line — claimed (frozen once the estimate leaves draft), certified
 * and paid (always writable — a correction to a received certificate is
 * the normal case, per updateProgressEstimateItemCertified's own doc
 * comment), disputed + note. Each field commits independently on blur/
 * change, same discipline as RatesScreen's inline edits: a person fixing
 * one number shouldn't have to also touch the others.
 */
function EstimateLineRow({
  line,
  isDraft,
  canWrite,
  onChanged,
}: {
  line: ProgressEstimateItem
  isDraft: boolean
  canWrite: boolean
  onChanged: () => void
}) {
  const field = claimFieldForKind(line.itemKind)
  const claimedValue = field === 'quantity' ? line.claimedQuantity : field === 'percent' ? line.claimedPercent : line.claimedValue
  const certifiedValue = field === 'quantity' ? line.certifiedQuantity : field === 'percent' ? line.certifiedPercent : line.certifiedValue

  const [claimedDraft, setClaimedDraft] = useState(claimedValue?.toString() ?? '')
  const [certifiedDraft, setCertifiedDraft] = useState(certifiedValue?.toString() ?? '')
  const [paidDraft, setPaidDraft] = useState(line.paidAmount?.toString() ?? '')
  const [noteDraft, setNoteDraft] = useState(line.varianceNote ?? '')
  const [saveError, setSaveError] = useState<string | null>(null)

  const fieldVariance = variance(claimedValue, certifiedValue)
  const valueVariance = variance(line.claimedValue, line.certifiedValue)

  async function commitClaimed() {
    const value = parseNum(claimedDraft)
    if (value === claimedValue) return
    try {
      await updateProgressEstimateItemClaim(line.id, { [field === 'quantity' ? 'claimedQuantity' : field === 'percent' ? 'claimedPercent' : 'claimedValue']: value })
      onChanged()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  async function commitCertified() {
    const value = parseNum(certifiedDraft)
    if (value === certifiedValue) return
    try {
      await updateProgressEstimateItemCertified(line.id, { [field === 'quantity' ? 'certifiedQuantity' : field === 'percent' ? 'certifiedPercent' : 'certifiedValue']: value })
      onChanged()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  async function commitPaid() {
    const value = parseNum(paidDraft)
    if (value === line.paidAmount) return
    try {
      await updateProgressEstimateItemCertified(line.id, { paidAmount: value })
      onChanged()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  async function toggleDisputed() {
    try {
      await updateProgressEstimateItemDispute(line.id, { disputed: !line.disputed, varianceNote: line.varianceNote })
      onChanged()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  async function commitNote() {
    if (noteDraft === (line.varianceNote ?? '')) return
    try {
      await updateProgressEstimateItemDispute(line.id, { disputed: line.disputed, varianceNote: noteDraft.trim() || null })
      onChanged()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  return (
    <TR>
      <TD className="nc-numeric align-top">{line.itemNumber}</TD>
      <TD prose className="align-top">
        <div className="max-w-[200px] truncate" title={line.description}>
          {line.description}
        </div>
        {saveError && <p className="mt-1 text-xs text-nc-danger-text">{saveError}</p>}
      </TD>
      <TD align="right" className="align-top">
        {canWrite && isDraft ? (
          <Input
            className="nc-numeric text-right"
            inputMode="decimal"
            style={{ width: 100 }}
            value={claimedDraft}
            aria-label={`${line.itemNumber} claimed ${fieldLabel(field)}`}
            onChange={(e) => setClaimedDraft(e.target.value)}
            onBlur={() => void commitClaimed()}
          />
        ) : (
          <span className="nc-numeric">{formatField(field, claimedValue, line.unit)}</span>
        )}
      </TD>
      <TD align="right" className="align-top">
        {canWrite ? (
          <Input
            className="nc-numeric text-right"
            inputMode="decimal"
            style={{ width: 100 }}
            value={certifiedDraft}
            aria-label={`${line.itemNumber} certified ${fieldLabel(field)}`}
            onChange={(e) => setCertifiedDraft(e.target.value)}
            onBlur={() => void commitCertified()}
          />
        ) : (
          <span className="nc-numeric">{formatField(field, certifiedValue, line.unit)}</span>
        )}
      </TD>
      <TD align="right" className="nc-numeric align-top">{fieldVariance === null ? '—' : formatField(field, fieldVariance, line.unit)}</TD>
      <TD align="right" className="nc-numeric align-top">{valueVariance === null ? '—' : fmtMoney(valueVariance)}</TD>
      <TD align="right" className="align-top">
        {canWrite ? (
          <Input
            className="nc-numeric text-right"
            inputMode="decimal"
            style={{ width: 100 }}
            value={paidDraft}
            aria-label={`${line.itemNumber} paid amount`}
            onChange={(e) => setPaidDraft(e.target.value)}
            onBlur={() => void commitPaid()}
          />
        ) : (
          <span className="nc-numeric">{fmtMoney(line.paidAmount)}</span>
        )}
      </TD>
      <TD className="align-top text-center">
        {canWrite ? (
          <input type="checkbox" checked={line.disputed} onChange={() => void toggleDisputed()} aria-label={`${line.itemNumber} disputed`} />
        ) : line.disputed ? (
          <span className="rounded-full bg-nc-warning-bg px-2 py-0.5 text-xs font-medium text-nc-warning-text">Disputed</span>
        ) : null}
      </TD>
      <TD className="align-top">
        {canWrite ? (
          <Textarea
            className="w-48 text-xs"
            rows={1}
            value={noteDraft}
            placeholder="Note (optional)"
            aria-label={`${line.itemNumber} variance note`}
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={() => void commitNote()}
          />
        ) : (
          <span className="text-xs text-nc-text-muted">{line.varianceNote ?? ''}</span>
        )}
      </TD>
    </TR>
  )
}

/**
 * One progress estimate's detail — the claimed/certified/paid cycle per
 * Item, status control, and totals. Claimed is proposed from records at
 * creation time (ProgressEstimatesScreen) and stays editable only while
 * the estimate is still draft (guard_progress_estimate_claim, 0041, is
 * the real wall — this screen's own disabling of the input is a courtesy,
 * not the enforcement). Certified/paid/disputed are always writable here;
 * the database doesn't restrict when the Ministry's own figures can be
 * corrected.
 */
export function ProgressEstimateScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  const [estimate, setEstimate] = useState<ProgressEstimate | null>(null)
  const [lines, setLines] = useState<ProgressEstimateItem[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [unitPriceByItem, setUnitPriceByItem] = useState<Map<string, number | null>>(new Map())
  const [productionRecords, setProductionRecords] = useState<{ itemId: string; workDate: string; quantity: number }[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [statusSaving, setStatusSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [addItemId, setAddItemId] = useState('')
  const [addItemValue, setAddItemValue] = useState('')
  const [addingItem, setAddingItem] = useState(false)

  const canWrite = contract.setCost && contract.setUnitPrice

  function reload() {
    if (!id) return
    return Promise.all([
      fetchProgressEstimate(id),
      fetchProgressEstimateItems(id),
      fetchItems(contract.id),
      fetchItemPrices(contract.id),
      fetchEffectiveProductionRecords(contract.id),
    ]).then(([estimateRow, lineRows, itemRows, priceRows, records]) => {
      setEstimate(estimateRow)
      setLines(lineRows)
      setItems(itemRows)
      setUnitPriceByItem(new Map(priceRows.map((p) => [p.itemId, p.unitPrice])))
      setProductionRecords(records)
    })
  }

  useEffect(() => {
    setStatus('loading')
    reload()
      ?.then(() => setStatus('ready'))
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, contract.id])

  const isDraft = estimate?.status === 'draft'

  const sortedLines = useMemo(() => [...lines].sort((a, b) => a.itemNumber.localeCompare(b.itemNumber, undefined, { numeric: true })), [lines])

  const totalValueVariance = useMemo(() => sumOrNull(lines.map((l) => variance(l.claimedValue, l.certifiedValue))), [lines])
  const totalPaid = useMemo(() => sumOrNull(lines.map((l) => l.paidAmount)), [lines])

  const itemsNotYetAdded = useMemo(() => {
    const lineItemIds = new Set(lines.map((l) => l.itemId))
    return items.filter((i) => !lineItemIds.has(i.id)).sort((a, b) => a.itemNumber.localeCompare(b.itemNumber, undefined, { numeric: true }))
  }, [items, lines])

  async function handleStatusChange(next: ProgressEstimateStatus) {
    if (!estimate) return
    setStatusSaving(true)
    setActionError(null)
    try {
      await updateProgressEstimateStatus(estimate.id, next)
      await reload()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setStatusSaving(false)
    }
  }

  async function handleRefreshFromRecords() {
    if (!estimate) return
    setRefreshing(true)
    setActionError(null)
    try {
      const unitPriceItemIds = new Set(items.filter((i) => i.itemKind === 'unit_price').map((i) => i.id))
      const claims = proposeClaimedFromRecords(
        productionRecords.filter((r) => unitPriceItemIds.has(r.itemId)),
        estimate.periodStart,
        estimate.periodEnd,
        unitPriceByItem,
      )
      const lineByItem = new Map(lines.map((l) => [l.itemId, l]))
      for (const claim of claims) {
        const existing = lineByItem.get(claim.itemId)
        if (existing) {
          await updateProgressEstimateItemClaim(existing.id, { claimedQuantity: claim.claimedQuantity, claimedValue: claim.claimedValue })
        } else {
          await addProgressEstimateItem({ progressEstimateId: estimate.id, itemId: claim.itemId, contractId: contract.id, claimedQuantity: claim.claimedQuantity, claimedValue: claim.claimedValue })
        }
      }
      await reload()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setRefreshing(false)
    }
  }

  async function handleAddItem() {
    if (!estimate || !addItemId) return
    const item = items.find((i) => i.id === addItemId)
    if (!item) return
    const field = claimFieldForKind(item.itemKind)
    const value = parseNum(addItemValue)
    setAddingItem(true)
    setActionError(null)
    try {
      await addProgressEstimateItem({
        progressEstimateId: estimate.id,
        itemId: item.id,
        contractId: contract.id,
        claimedQuantity: field === 'quantity' ? value : null,
        claimedPercent: field === 'percent' ? value : null,
        claimedValue: field === 'value' ? value : null,
      })
      setAddItemId('')
      setAddItemValue('')
      await reload()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setAddingItem(false)
    }
  }

  if (status === 'ready' && !contract.viewRates) {
    return (
      <div>
        <PageHeader title="Progress estimate" subtitle={contract.name} />
        <EmptyState title="You don't have permission to view progress estimates on this contract." />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Progress estimate"
        subtitle={estimate ? `${contract.name} · ${formatDayLabel(estimate.periodStart)} → ${formatDayLabel(estimate.periodEnd)}` : contract.name}
        actions={
          <Button type="button" variant="ghost" onClick={() => navigate('/progress-estimates')}>
            <IconArrowLeft size={16} stroke={2} className="mr-1 inline" />
            Back
          </Button>
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

      {status === 'ready' && estimate && (
        <>
          {actionError && (
            <NotificationBanner tone="danger" className="mb-4">
              {actionError}
            </NotificationBanner>
          )}

          <div className="mb-6 flex flex-wrap items-center gap-4 rounded-lg border border-nc-border bg-white p-4">
            <label className="text-xs text-nc-text-muted">
              Status
              <Select className="mt-1" value={estimate.status} disabled={!canWrite || statusSaving} onChange={(e) => void handleStatusChange(e.target.value as ProgressEstimateStatus)}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </label>
            {!isDraft && <p className="text-xs text-nc-text-muted">Claimed figures are frozen — this estimate is no longer a draft.</p>}
            {canWrite && isDraft && (
              <Button type="button" variant="secondary" disabled={refreshing} onClick={() => void handleRefreshFromRecords()}>
                {refreshing ? 'Refreshing…' : 'Refresh claimed from records'}
              </Button>
            )}
          </div>

          {sortedLines.length === 0 ? (
            <EmptyState title="No lines on this estimate yet." description="No unit_price Item had confirmed records in this period. Add a line by hand below." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Item #</TH>
                  <TH>Description</TH>
                  <TH align="right">Claimed</TH>
                  <TH align="right">Certified</TH>
                  <TH align="right">Variance</TH>
                  <TH align="right">Variance ($)</TH>
                  <TH align="right">Paid</TH>
                  <TH className="text-center">Disputed</TH>
                  <TH>Note</TH>
                </TR>
              </THead>
              <TBody>
                {sortedLines.map((line) => (
                  <EstimateLineRow key={line.id} line={line} isDraft={isDraft} canWrite={canWrite} onChanged={() => void reload()} />
                ))}
              </TBody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="text-data border-t border-nc-border bg-nc-secondary px-4 py-3 text-xs text-nc-text-muted">
                    Totals — only the $ columns are summed (mixed units/percent across Items).
                  </td>
                  <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{totalValueVariance === null ? '—' : fmtMoney(totalValueVariance)}</td>
                  <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{totalPaid === null ? '—' : fmtMoney(totalPaid)}</td>
                  <td className="text-data border-t border-nc-border bg-nc-secondary px-4 py-3" colSpan={2} />
                </tr>
              </tfoot>
            </Table>
          )}

          {canWrite && itemsNotYetAdded.length > 0 && (
            <div className="mt-6 rounded-lg border border-nc-border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-nc-text">Add a line by hand</h2>
              <p className="mb-3 text-xs text-nc-text-muted">For a Lump Sum or Provisional Sum Item, or a unit_price Item the automatic proposal missed.</p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-nc-text-muted">
                  Item
                  <Select className="mt-1" value={addItemId} onChange={(e) => setAddItemId(e.target.value)}>
                    <option value="">Select an Item…</option>
                    {itemsNotYetAdded.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.itemNumber} — {i.description}
                      </option>
                    ))}
                  </Select>
                </label>
                {addItemId && (
                  <label className="text-xs text-nc-text-muted">
                    {fieldLabel(claimFieldForKind(items.find((i) => i.id === addItemId)?.itemKind ?? 'unit_price'))}
                    <Input className="mt-1" inputMode="decimal" value={addItemValue} onChange={(e) => setAddItemValue(e.target.value)} />
                  </label>
                )}
                <Button type="button" variant="secondary" disabled={!addItemId || addingItem} onClick={() => void handleAddItem()}>
                  {addingItem ? 'Adding…' : 'Add line'}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
