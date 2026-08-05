import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import { createContract, type MyContract } from '../../lib/supabase/contracts'
import { bulkCreateItems, type BulkItemInput } from '../../lib/supabase/items'
import { parseItemsPaste, type ParsedItemRow } from '../../lib/admin/parseItemsPaste'
import { errorMessage } from '../../lib/errorMessage'
import { quantity as fmtQuantity } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, Table, TBody, TD, TH, THead, TR, Textarea } from '../../components/ui'

interface ContractDraft {
  contractNo: string
  name: string
  contractStart: string
  contractEnd: string
  plannedStart: string
  plannedEnd: string
  isSandbox: boolean
}

const BLANK_DRAFT: ContractDraft = { contractNo: '', name: '', contractStart: '', contractEnd: '', plannedStart: '', plannedEnd: '', isSandbox: false }

const KIND_LABEL: Record<string, string> = { unit_price: 'Unit Price', lump_sum: 'Lump Sum', provisional_sum: 'Provisional Sum' }

/**
 * Two stages, one screen: contract details, then its Items. Never invents
 * data — every field here is either what the person typed or left null;
 * a newly created contract has no Unit Prices and no cost (that's Rates'
 * job, later, behind the finance wall), and Approximate Quantity is the
 * only number Items carry at all.
 *
 * Item entry is paste-a-block (see parseItemsPaste's own comment for why:
 * one textarea, tab- or comma-delimited, auto-detected — a direct copy
 * from Excel/Sheets or literal CSV text both work without a file picker).
 * Submission is blocked until every pasted row parses clean; a bad Schedule
 * 7 transcription should be fixed before it's saved, not silently trimmed
 * down to whatever happened to parse.
 */
export function CreateContractScreen() {
  const { companyRights } = useOutletContext<CurrentContractState>()
  const canCreate = companyRights.createProjects

  const [stage, setStage] = useState<'details' | 'items' | 'done'>('details')
  const [draft, setDraft] = useState<ContractDraft>(BLANK_DRAFT)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [contract, setContract] = useState<MyContract | null>(null)

  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<ParsedItemRow[] | null>(null)
  const [skippedHeaderLine, setSkippedHeaderLine] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedCount, setSavedCount] = useState(0)

  function updateDraft<K extends keyof ContractDraft>(key: K, value: ContractDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function validateDatePair(startLabel: string, start: string, end: string): string | null {
    if ((start === '') !== (end === '')) return `Enter both ${startLabel} dates, or neither.`
    if (start !== '' && end !== '' && start > end) return `${startLabel} start must be on or before its end.`
    return null
  }

  async function handleCreate() {
    setCreateError(null)
    if (!draft.name.trim()) {
      setCreateError('Enter a contract name.')
      return
    }
    const ministryError = validateDatePair('Ministry period', draft.contractStart, draft.contractEnd)
    if (ministryError) {
      setCreateError(ministryError)
      return
    }
    const plannedError = validateDatePair('Planned', draft.plannedStart, draft.plannedEnd)
    if (plannedError) {
      setCreateError(plannedError)
      return
    }

    setCreating(true)
    try {
      const created = await createContract({
        contractNo: draft.contractNo.trim() || null,
        name: draft.name.trim(),
        contractStart: draft.contractStart || null,
        contractEnd: draft.contractEnd || null,
        plannedStart: draft.plannedStart || null,
        plannedEnd: draft.plannedEnd || null,
        isSandbox: draft.isSandbox,
      })
      setContract(created)
      setStage('items')
    } catch (err) {
      setCreateError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  function handleParse() {
    const result = parseItemsPaste(pasteText)
    setParsed(result.rows)
    setSkippedHeaderLine(result.skippedHeaderLine)
    setSaveError(null)
  }

  const errorRowCount = parsed?.filter((r) => r.errors.length > 0).length ?? 0
  const canSaveItems = parsed !== null && parsed.length > 0 && errorRowCount === 0

  async function handleSaveItems() {
    if (!contract || !parsed) return
    setSaveError(null)
    setSaving(true)
    try {
      const inputs: BulkItemInput[] = parsed.map((r) => ({
        itemNumber: r.itemNumber,
        description: r.description,
        unit: r.unit,
        itemKind: r.itemKind!,
        approximateQuantity: r.approximateQuantity!,
      }))
      const saved = await bulkCreateItems(contract.id, inputs)
      setSavedCount(saved.length)
      setStage('done')
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  if (!canCreate) {
    return (
      <div>
        <PageHeader title="Create contract" />
        <EmptyState title="You don't have permission to create contracts." />
      </div>
    )
  }

  if (stage === 'done') {
    return (
      <div>
        <PageHeader title="Create contract" />
        <EmptyState
          title={`${contract?.name} created.`}
          description={savedCount > 0 ? `${savedCount} Item${savedCount === 1 ? '' : 's'} added. Reload to see it in your contract list.` : 'No Items added yet — add them anytime from Items.'}
          action={
            <Button type="button" onClick={() => (window.location.href = '/portfolio')}>
              Go to Portfolio
            </Button>
          }
        />
      </div>
    )
  }

  if (stage === 'items' && contract) {
    return (
      <div>
        <PageHeader title="Create contract" subtitle={`${contract.name} · now add its Items`} />

        <NotificationBanner tone="info" className="mb-4">
          Paste Schedule 7 straight from a spreadsheet — one Item per line, columns in order: Item #, Description, Unit, Kind (Unit Price / Lump Sum / Provisional Sum), Approximate Quantity. Tab
          or comma separated, either works.
        </NotificationBanner>

        <Textarea
          rows={8}
          placeholder={'03.01.01\tAsphalt Medium Mix Aggregate\ttonne\tUnit Price\t18000\n02.01\tMobilization\tLump Sum\tLump Sum\t'}
          value={pasteText}
          onChange={(e) => {
            setPasteText(e.target.value)
            setParsed(null)
          }}
          className="nc-numeric mb-3 font-mono text-xs"
        />

        <div className="mb-4 flex items-center gap-3">
          <Button type="button" variant="secondary" onClick={handleParse} disabled={pasteText.trim() === ''}>
            Preview
          </Button>
          {parsed && <span className="text-sm text-nc-text-muted">{parsed.length} row{parsed.length === 1 ? '' : 's'} parsed{errorRowCount > 0 ? ` — ${errorRowCount} need${errorRowCount === 1 ? 's' : ''} fixing` : ''}</span>}
        </div>

        {skippedHeaderLine !== null && (
          <NotificationBanner tone="info" className="mb-4">
            Line {skippedHeaderLine} looked like a header row and was skipped.
          </NotificationBanner>
        )}

        {parsed && parsed.length > 0 && (
          <Table className="mb-4">
            <THead>
              <TR>
                <TH>Item #</TH>
                <TH>Description</TH>
                <TH>Unit</TH>
                <TH>Kind</TH>
                <TH align="right">Approx. Qty</TH>
                <TH>Problem</TH>
              </TR>
            </THead>
            <TBody>
              {parsed.map((row) => (
                <TR key={row.line} className={row.errors.length > 0 ? 'bg-nc-danger-bg/40' : undefined}>
                  <TD className="nc-numeric">{row.itemNumber || '—'}</TD>
                  <TD prose>{row.description || '—'}</TD>
                  <TD>{row.unit || '—'}</TD>
                  <TD>{row.itemKind ? KIND_LABEL[row.itemKind] : '—'}</TD>
                  <TD align="right" className="nc-numeric">
                    {row.approximateQuantity === null ? '—' : fmtQuantity(row.approximateQuantity)}
                  </TD>
                  <TD className="text-nc-danger-text">{row.errors.join(' ')}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {parsed && parsed.length === 0 && <NotificationBanner tone="warning" className="mb-4">Nothing parsed — check the pasted text.</NotificationBanner>}

        {saveError && (
          <NotificationBanner tone="danger" className="mb-4">
            {saveError}
          </NotificationBanner>
        )}

        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void handleSaveItems()} disabled={!canSaveItems || saving}>
            {saving ? 'Adding…' : parsed ? `Add ${parsed.length} item${parsed.length === 1 ? '' : 's'}` : 'Add items'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setStage('done')}>
            Skip — I'll add Items later
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Create contract" />

      <div className="max-w-xl space-y-4">
        <div>
          <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="cc-contract-no">
            Contract number
          </label>
          <Input id="cc-contract-no" value={draft.contractNo} onChange={(e) => updateDraft('contractNo', e.target.value)} placeholder="26607-0000" />
        </div>

        <div>
          <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="cc-name">
            Contract name
          </label>
          <Input id="cc-name" value={draft.name} onChange={(e) => updateDraft('name', e.target.value)} placeholder="Hwy 5 Snowshed Hill" />
        </div>

        <div>
          <p className="mb-1 text-sm font-semibold text-nc-text-muted">Ministry period</p>
          <div className="flex gap-3">
            <Input type="date" aria-label="Ministry period start" value={draft.contractStart} onChange={(e) => updateDraft('contractStart', e.target.value)} />
            <Input type="date" aria-label="Ministry period end" value={draft.contractEnd} onChange={(e) => updateDraft('contractEnd', e.target.value)} />
          </div>
        </div>

        <div>
          <p className="mb-1 text-sm font-semibold text-nc-text-muted">Keywest's own planned schedule</p>
          <div className="flex gap-3">
            <Input type="date" aria-label="Planned start" value={draft.plannedStart} onChange={(e) => updateDraft('plannedStart', e.target.value)} />
            <Input type="date" aria-label="Planned end" value={draft.plannedEnd} onChange={(e) => updateDraft('plannedEnd', e.target.value)} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-nc-text">
          <input type="checkbox" checked={draft.isSandbox} onChange={(e) => updateDraft('isSandbox', e.target.checked)} className="h-4 w-4" />
          Sandbox — fictional, for exercising screen states, not a real contract
        </label>

        {createError && <NotificationBanner tone="danger">{createError}</NotificationBanner>}

        <Button type="button" onClick={() => void handleCreate()} disabled={creating}>
          {creating ? 'Creating…' : 'Create contract'}
        </Button>
      </div>
    </div>
  )
}
