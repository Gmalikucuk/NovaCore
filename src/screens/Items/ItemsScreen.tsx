import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconClipboardList } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { createItem, fetchItems, updateItem, type AreaBasis, type Item, type ItemInput } from '../../lib/supabase/items'
import {
  deleteApplicationRateTarget,
  deleteDerivationRule,
  fetchApplicationRateTargets,
  fetchDerivationRules,
  upsertApplicationRateTarget,
  upsertDerivationRule,
  type ApplicationRateTarget,
  type DerivationBasis,
  type DerivationRule,
} from '../../lib/supabase/derivationRules'
import { UNITS } from '../../lib/itemUnits'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { errorMessage } from '../../lib/errorMessage'
import { quantity as fmtQuantity } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const BLANK_FORM: ItemInput = { itemNumber: '', description: '', unit: UNITS[0], approximateQuantity: 0, areaBasis: null }

/**
 * Whether quantity is itself an area, or area is a separate measured fact,
 * or area has no meaning for this Item — set from the contract documents,
 * never inferred (items.ts's isAreaUnit/isApplicationRateItem). The empty
 * string is this Select's own "Unclassified" option, mapped to null on
 * save — never a fourth real area_basis value, never a default.
 */
const AREA_BASIS_OPTIONS: { value: AreaBasis | ''; label: string }[] = [
  { value: '', label: 'Unclassified' },
  { value: 'quantity_is_area', label: 'Quantity is area' },
  { value: 'separately_measured', label: 'Separately measured' },
  { value: 'not_applicable', label: 'Not applicable' },
]

const AREA_BASIS_LABEL: Record<AreaBasis, string> = {
  quantity_is_area: 'Quantity is area',
  separately_measured: 'Separately measured',
  not_applicable: 'Not applicable',
}

function areaBasisSelectValue(areaBasis: AreaBasis | null): AreaBasis | '' {
  return areaBasis ?? ''
}

function parseAreaBasisSelectValue(raw: string): AreaBasis | null {
  return raw === '' ? null : (raw as AreaBasis)
}

const DERIVATION_BASIS_OPTIONS: { value: DerivationBasis; label: string }[] = [
  { value: 'area', label: 'Area (m²)' },
  { value: 'length', label: 'Length (m)' },
]

interface RuleForm {
  coefficient: string
  basis: DerivationBasis
  sourceItemIds: Set<string>
}

const BLANK_RULE_FORM: RuleForm = { coefficient: '', basis: 'area', sourceItemIds: new Set() }

interface TargetForm {
  targetRate: string
  bandLowPercent: string
  bandHighPercent: string
}

const BLANK_TARGET_FORM: TargetForm = { targetRate: '', bandLowPercent: '', bandHighPercent: '' }

/** "—" for no rule, never a blank cell — absence must read as absent. */
function ruleSummary(rule: DerivationRule | undefined): string {
  if (!rule) return '—'
  const basisLabel = rule.basis === 'area' ? 'area' : 'length'
  return `${rule.coefficient} × ${basisLabel} (${rule.sourceItemIds.length} source${rule.sourceItemIds.length === 1 ? '' : 's'})`
}

function targetSummary(target: ApplicationRateTarget | undefined): string {
  if (!target) return '—'
  if (target.bandLowPercent !== null && target.bandHighPercent !== null) {
    return `${target.targetRate} (${target.bandLowPercent}–${target.bandHighPercent}%)`
  }
  return `${target.targetRate}`
}

function parseQuantity(raw: string): number {
  const n = Number(raw)
  return raw.trim() === '' || Number.isNaN(n) ? 0 : n
}

/** Approximate Quantity is always 1 on a Lump Sum / Provisional Sum item — noise, not information (GC 52.03(b)/(c)). */
function displayQuantity(item: Item): string {
  return item.itemKind === 'unit_price' ? fmtQuantity(item.approximateQuantity) : '—'
}

export function ItemsScreen() {
  const contract = useOutletContext<MyContract>()
  const canWrite = contract.createItems

  const [items, setItems] = useState<Item[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [form, setForm] = useState<ItemInput>(BLANK_FORM)
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const codeInputRef = useRef<HTMLInputElement>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<ItemInput>(BLANK_FORM)
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const [rules, setRules] = useState<DerivationRule[]>([])
  const [targets, setTargets] = useState<ApplicationRateTarget[]>([])
  const [ruleEditingId, setRuleEditingId] = useState<string | null>(null)
  const [ruleForm, setRuleForm] = useState<RuleForm>(BLANK_RULE_FORM)
  const [targetForm, setTargetForm] = useState<TargetForm>(BLANK_TARGET_FORM)
  const [ruleError, setRuleError] = useState<string | null>(null)
  const [savingRule, setSavingRule] = useState(false)

  useEffect(() => {
    setStatus('loading')
    fetchItems(contract.id)
      .then((rows) => {
        setItems(rows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
    fetchDerivationRules(contract.id)
      .then(setRules)
      .catch((err: unknown) => console.warn('fetchDerivationRules failed:', err))
    fetchApplicationRateTargets(contract.id)
      .then(setTargets)
      .catch((err: unknown) => console.warn('fetchApplicationRateTargets failed:', err))
  }, [contract.id])

  const ruleByItemId = useMemo(() => new Map(rules.map((r) => [r.itemId, r])), [rules])
  const targetByItemId = useMemo(() => new Map(targets.map((t) => [t.itemId, t])), [targets])

  const sorted = useMemo(() => [...items].sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber)), [items])

  // Split from the form's onSubmit so onKeyDown can call it directly.
  // Implicit submit-on-Enter is a browser heuristic gated on trusted native
  // key events — it doesn't fire reliably for every input combination (and
  // not at all for synthetic events), and this screen's whole point is
  // "type 48 rows without touching the mouse," so Enter is wired explicitly
  // below rather than left to that heuristic.
  async function doAdd() {
    setAddError(null)
    if (!form.itemNumber.trim()) {
      setAddError('Enter an item code.')
      return
    }
    if (!form.description.trim()) {
      setAddError('Enter a description.')
      return
    }
    setAdding(true)
    try {
      const created = await createItem(contract.id, {
        itemNumber: form.itemNumber.trim(),
        description: form.description.trim(),
        unit: form.unit,
        approximateQuantity: form.approximateQuantity,
        areaBasis: form.areaBasis,
      })
      setItems((prev) => [...prev, created])
      // Keep the unit selection (a PM entering 48 items is usually entering
      // a run of the same activity) — reset everything else, and return
      // focus to Code so typing continues without reaching for the mouse.
      // area_basis is NOT carried forward with it: it's a documents-driven
      // classification specific to each Item, never a default to reuse.
      setForm({ ...BLANK_FORM, unit: form.unit })
      codeInputRef.current?.focus()
    } catch (err) {
      setAddError(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  function handleAdd(e: FormEvent) {
    e.preventDefault()
    void doAdd()
  }

  function handleAddKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void doAdd()
  }

  function startEdit(item: Item) {
    setEditingId(item.id)
    setEditForm({ itemNumber: item.itemNumber, description: item.description, unit: item.unit, approximateQuantity: item.approximateQuantity, areaBasis: item.areaBasis })
    setEditError(null)
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setEditError(null)
    if (!editForm.itemNumber.trim() || !editForm.description.trim()) {
      setEditError('Code and description are required.')
      return
    }
    setSavingEdit(true)
    try {
      const updated = await updateItem(editingId, {
        itemNumber: editForm.itemNumber.trim(),
        description: editForm.description.trim(),
        unit: editForm.unit,
        approximateQuantity: editForm.approximateQuantity,
        areaBasis: editForm.areaBasis,
      })
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
      setEditingId(null)
    } catch (err) {
      setEditError(errorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  function startEditRule(item: Item) {
    const rule = ruleByItemId.get(item.id)
    const target = targetByItemId.get(item.id)
    setRuleEditingId(item.id)
    setRuleForm(rule ? { coefficient: String(rule.coefficient), basis: rule.basis, sourceItemIds: new Set(rule.sourceItemIds) } : BLANK_RULE_FORM)
    setTargetForm(
      target
        ? { targetRate: String(target.targetRate), bandLowPercent: target.bandLowPercent === null ? '' : String(target.bandLowPercent), bandHighPercent: target.bandHighPercent === null ? '' : String(target.bandHighPercent) }
        : BLANK_TARGET_FORM,
    )
    setRuleError(null)
  }

  function toggleSourceItem(itemId: string) {
    setRuleForm((prev) => {
      const next = new Set(prev.sourceItemIds)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return { ...prev, sourceItemIds: next }
    })
  }

  // Rule and target save independently, so entering only one of the two
  // (the common case — most Items with a rate target carry no derivation
  // rule, and vice versa) never requires touching the other's fields.
  async function handleSaveRuleAndTarget(e: FormEvent) {
    e.preventDefault()
    if (!ruleEditingId) return
    setRuleError(null)

    const coefficientTrim = ruleForm.coefficient.trim()
    const targetRateTrim = targetForm.targetRate.trim()

    if (coefficientTrim !== '' && (Number.isNaN(Number(coefficientTrim)) || Number(coefficientTrim) <= 0)) {
      setRuleError('Coefficient must be a positive number.')
      return
    }
    if (coefficientTrim !== '' && ruleForm.sourceItemIds.size === 0) {
      setRuleError('A rule needs at least one source Item.')
      return
    }
    if (targetRateTrim !== '' && (Number.isNaN(Number(targetRateTrim)) || Number(targetRateTrim) <= 0)) {
      setRuleError('Target rate must be a positive number.')
      return
    }

    setSavingRule(true)
    try {
      if (coefficientTrim === '') {
        if (ruleByItemId.has(ruleEditingId)) await deleteDerivationRule(ruleEditingId)
      } else {
        await upsertDerivationRule(ruleEditingId, contract.id, {
          coefficient: Number(coefficientTrim),
          basis: ruleForm.basis,
          sourceItemIds: [...ruleForm.sourceItemIds],
        })
      }

      if (targetRateTrim === '') {
        if (targetByItemId.has(ruleEditingId)) await deleteApplicationRateTarget(ruleEditingId)
      } else {
        await upsertApplicationRateTarget(ruleEditingId, contract.id, {
          targetRate: Number(targetRateTrim),
          bandLowPercent: targetForm.bandLowPercent.trim() === '' ? null : Number(targetForm.bandLowPercent.trim()),
          bandHighPercent: targetForm.bandHighPercent.trim() === '' ? null : Number(targetForm.bandHighPercent.trim()),
        })
      }

      const [freshRules, freshTargets] = await Promise.all([fetchDerivationRules(contract.id), fetchApplicationRateTargets(contract.id)])
      setRules(freshRules)
      setTargets(freshTargets)
      setRuleEditingId(null)
    } catch (err) {
      setRuleError(errorMessage(err))
    } finally {
      setSavingRule(false)
    }
  }

  const subtitle = `${contract.name}${status === 'ready' ? ` · ${sorted.length} item${sorted.length === 1 ? '' : 's'}` : ''}`

  return (
    <div>
      <PageHeader title="Items" subtitle={subtitle} />

      <SandboxBanner contract={contract} />

      {!canWrite ? (
        <EmptyState title="You don't have permission to add or edit Items on this contract." />
      ) : (
        <>
          {/* A distinct card, not a Table — a form styled like the data
              table below it (same TH row) read as the table's own first
              row. flex-wrap also means six fields plus the submit button
              never has to fit one rigid table row; it wraps instead of
              running the button off-screen. */}
          <form onSubmit={handleAdd} className="mb-6 rounded-lg border border-nc-border bg-nc-secondary p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Add an item</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-add-code">
                  Item #
                </label>
                <Input
                  id="li-add-code"
                  ref={codeInputRef}
                  className="nc-numeric"
                  value={form.itemNumber}
                  onChange={(e) => setForm({ ...form, itemNumber: e.target.value })}
                  onKeyDown={handleAddKeyDown}
                  placeholder="05.03.03"
                />
              </div>
              <div className="min-w-[240px] flex-1">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-add-description">
                  Description
                </label>
                <Input
                  id="li-add-description"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  onKeyDown={handleAddKeyDown}
                  placeholder="Asphalt paving, top lift"
                />
              </div>
              <div className="w-40">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-add-unit">
                  Unit of Measure
                </label>
                <Select id="li-add-unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} onKeyDown={handleAddKeyDown}>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-44">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-add-area-basis">
                  Area basis
                </label>
                <Select
                  id="li-add-area-basis"
                  value={areaBasisSelectValue(form.areaBasis ?? null)}
                  onChange={(e) => setForm({ ...form, areaBasis: parseAreaBasisSelectValue(e.target.value) })}
                  onKeyDown={handleAddKeyDown}
                >
                  {AREA_BASIS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-36">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-add-quantity">
                  Approximate Quantity
                </label>
                <Input
                  id="li-add-quantity"
                  className="nc-numeric"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={form.approximateQuantity || ''}
                  onChange={(e) => setForm({ ...form, approximateQuantity: parseQuantity(e.target.value) })}
                  onKeyDown={handleAddKeyDown}
                />
              </div>
              <Button type="submit" disabled={adding}>
                {adding ? 'Adding…' : 'Add — Enter'}
              </Button>
            </div>
          </form>
          {addError && (
            <NotificationBanner tone="danger" className="mb-4">
              {addError}
            </NotificationBanner>
          )}

          {status === 'loading' && (
            <div className="flex items-center gap-2 py-8 text-nc-text-muted">
              <Spinner />
              <span className="text-sm">Loading…</span>
            </div>
          )}
          {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

          {status === 'ready' &&
            (sorted.length === 0 ? (
              <EmptyState icon={<IconClipboardList size={32} stroke={1.5} />} title="No items yet." description="Add the first one above to get started." />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Item #</TH>
                    <TH>Description</TH>
                    <TH>Unit of Measure</TH>
                    <TH>Area basis</TH>
                    <TH align="right">Approximate Quantity</TH>
                    <TH>Derivation</TH>
                    <TH>App. rate target</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {sorted.map((item) =>
                    editingId === item.id ? (
                      <TR key={item.id}>
                        <TD colSpan={8} dense>
                          <form onSubmit={handleSaveEdit} className="flex flex-wrap items-center gap-2">
                            <Input
                              className="nc-numeric w-32"
                              value={editForm.itemNumber}
                              onChange={(e) => setEditForm({ ...editForm, itemNumber: e.target.value })}
                              aria-label="Item #"
                            />
                            <Input
                              className="min-w-[16rem] flex-1"
                              value={editForm.description}
                              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                              aria-label="Description"
                            />
                            <Select className="w-auto" value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })} aria-label="Unit of Measure">
                              {UNITS.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </Select>
                            <Select
                              className="w-auto"
                              value={areaBasisSelectValue(editForm.areaBasis ?? null)}
                              onChange={(e) => setEditForm({ ...editForm, areaBasis: parseAreaBasisSelectValue(e.target.value) })}
                              aria-label="Area basis"
                            >
                              {AREA_BASIS_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </Select>
                            <Input
                              className="nc-numeric w-32"
                              type="number"
                              inputMode="decimal"
                              step="any"
                              value={editForm.approximateQuantity}
                              onChange={(e) => setEditForm({ ...editForm, approximateQuantity: parseQuantity(e.target.value) })}
                              aria-label="Approximate quantity"
                            />
                            <Button type="submit" disabled={savingEdit}>
                              {savingEdit ? 'Saving…' : 'Save'}
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
                              Cancel
                            </Button>
                            {editError && <span className="text-sm text-nc-danger-text">{editError}</span>}
                          </form>
                        </TD>
                      </TR>
                    ) : ruleEditingId === item.id ? (
                      <TR key={item.id}>
                        <TD colSpan={8} dense>
                          <form onSubmit={handleSaveRuleAndTarget} className="flex flex-col gap-4">
                            <div>
                              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Derivation rule — leave Coefficient blank for no rule</p>
                              <div className="flex flex-wrap items-end gap-3">
                                <div className="w-32">
                                  <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-rule-coefficient">
                                    Coefficient
                                  </label>
                                  <Input
                                    id="li-rule-coefficient"
                                    className="nc-numeric"
                                    type="number"
                                    inputMode="decimal"
                                    step="any"
                                    value={ruleForm.coefficient}
                                    onChange={(e) => setRuleForm({ ...ruleForm, coefficient: e.target.value })}
                                    placeholder="0.26"
                                  />
                                </div>
                                <div className="w-40">
                                  <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-rule-basis">
                                    Basis
                                  </label>
                                  <Select id="li-rule-basis" value={ruleForm.basis} onChange={(e) => setRuleForm({ ...ruleForm, basis: e.target.value as DerivationBasis })}>
                                    {DERIVATION_BASIS_OPTIONS.map((o) => (
                                      <option key={o.value} value={o.value}>
                                        {o.label}
                                      </option>
                                    ))}
                                  </Select>
                                </div>
                                <div className="min-w-[16rem] flex-1">
                                  <p className="mb-1 block text-xs text-nc-text-muted">Sources — which Items' same-date records this rule sums</p>
                                  <div className="max-h-40 overflow-y-auto rounded border border-nc-border bg-white p-2">
                                    {sorted
                                      .filter((i) => i.id !== item.id)
                                      .map((i) => (
                                        <label key={i.id} className="flex items-center gap-2 py-0.5 text-sm">
                                          <input type="checkbox" checked={ruleForm.sourceItemIds.has(i.id)} onChange={() => toggleSourceItem(i.id)} />
                                          <span className="nc-numeric text-nc-text-muted">{i.itemNumber}</span>
                                          <span>{i.description}</span>
                                        </label>
                                      ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div>
                              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Application rate target — leave Target rate blank for none</p>
                              <div className="flex flex-wrap items-end gap-3">
                                <div className="w-36">
                                  <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-target-rate">
                                    Target rate
                                  </label>
                                  <Input
                                    id="li-target-rate"
                                    className="nc-numeric"
                                    type="number"
                                    inputMode="decimal"
                                    step="any"
                                    value={targetForm.targetRate}
                                    onChange={(e) => setTargetForm({ ...targetForm, targetRate: e.target.value })}
                                    placeholder="124.35"
                                  />
                                </div>
                                <div className="w-32">
                                  <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-target-band-low">
                                    Band low %
                                  </label>
                                  <Input
                                    id="li-target-band-low"
                                    className="nc-numeric"
                                    type="number"
                                    inputMode="decimal"
                                    step="any"
                                    value={targetForm.bandLowPercent}
                                    onChange={(e) => setTargetForm({ ...targetForm, bandLowPercent: e.target.value })}
                                    placeholder="96"
                                  />
                                </div>
                                <div className="w-32">
                                  <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="li-target-band-high">
                                    Band high %
                                  </label>
                                  <Input
                                    id="li-target-band-high"
                                    className="nc-numeric"
                                    type="number"
                                    inputMode="decimal"
                                    step="any"
                                    value={targetForm.bandHighPercent}
                                    onChange={(e) => setTargetForm({ ...targetForm, bandHighPercent: e.target.value })}
                                    placeholder="104"
                                  />
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button type="submit" disabled={savingRule}>
                                {savingRule ? 'Saving…' : 'Save'}
                              </Button>
                              <Button type="button" variant="ghost" onClick={() => setRuleEditingId(null)}>
                                Cancel
                              </Button>
                              {ruleError && <span className="text-sm text-nc-danger-text">{ruleError}</span>}
                            </div>
                          </form>
                        </TD>
                      </TR>
                    ) : (
                      <TR key={item.id}>
                        <TD className="nc-numeric">{item.itemNumber}</TD>
                        <TD prose>{item.description}</TD>
                        <TD>{item.unit}</TD>
                        <TD>
                          {item.areaBasis === null ? (
                            <span className="italic text-nc-text-subtle">Unclassified</span>
                          ) : (
                            AREA_BASIS_LABEL[item.areaBasis]
                          )}
                        </TD>
                        <TD align="right" className="nc-numeric">
                          {displayQuantity(item)}
                        </TD>
                        <TD className="nc-numeric">{ruleSummary(ruleByItemId.get(item.id))}</TD>
                        <TD className="nc-numeric">{targetSummary(targetByItemId.get(item.id))}</TD>
                        <TD align="right" dense>
                          <div className="flex justify-end gap-2">
                            <Button type="button" variant="secondary" onClick={() => startEdit(item)}>
                              Edit
                            </Button>
                            <Button type="button" variant="secondary" onClick={() => startEditRule(item)}>
                              Rules
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    ),
                  )}
                </TBody>
              </Table>
            ))}
        </>
      )}
    </div>
  )
}
