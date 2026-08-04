import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconClipboardList } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { createItem, fetchItems, updateItem, type Item, type ItemInput } from '../../lib/supabase/items'
import { UNITS } from '../../lib/itemUnits'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { errorMessage } from '../../lib/errorMessage'
import { quantity as fmtQuantity } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const BLANK_FORM: ItemInput = { itemNumber: '', description: '', unit: UNITS[0], approximateQuantity: 0 }

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
  }, [contract.id])

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
      })
      setItems((prev) => [...prev, created])
      // Keep the unit selection (a PM entering 48 items is usually entering
      // a run of the same activity) — reset everything else, and return
      // focus to Code so typing continues without reaching for the mouse.
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
    setEditForm({ itemNumber: item.itemNumber, description: item.description, unit: item.unit, approximateQuantity: item.approximateQuantity })
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
      })
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
      setEditingId(null)
    } catch (err) {
      setEditError(errorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  const subtitle = `${contract.name}${status === 'ready' ? ` · ${sorted.length} item${sorted.length === 1 ? '' : 's'}` : ''}`

  return (
    <div>
      <PageHeader title="Items" subtitle={subtitle} />

      <SandboxBanner contract={contract} />

      {!canWrite ? (
        <EmptyState title="Setting up items needs the create_items right on this contract." />
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
                    <TH align="right">Approximate Quantity</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {sorted.map((item) =>
                    editingId === item.id ? (
                      <TR key={item.id}>
                        <TD colSpan={5} dense>
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
                    ) : (
                      <TR key={item.id}>
                        <TD className="nc-numeric">{item.itemNumber}</TD>
                        <TD prose>{item.description}</TD>
                        <TD>{item.unit}</TD>
                        <TD align="right" className="nc-numeric">
                          {displayQuantity(item)}
                        </TD>
                        <TD align="right" dense>
                          <Button type="button" variant="secondary" onClick={() => startEdit(item)}>
                            Edit
                          </Button>
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
