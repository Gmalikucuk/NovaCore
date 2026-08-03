import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyContract } from '../../lib/supabase/contracts'
import { createItem, fetchItems, updateItem, type Item, type ItemInput } from '../../lib/supabase/items'
import { UNITS } from '../../lib/itemUnits'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { errorMessage } from '../../lib/errorMessage'
import './ItemsScreen.css'

const BLANK_FORM: ItemInput = { itemNumber: '', description: '', unit: UNITS[0], approximateQuantity: 0 }

function parseQuantity(raw: string): number {
  const n = Number(raw)
  return raw.trim() === '' || Number.isNaN(n) ? 0 : n
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

  if (!canWrite) {
    return (
      <div className="items-screen">
        <p className="items-denied">Setting up items needs the create_items right on this contract.</p>
      </div>
    )
  }

  return (
    <div className="items-screen">
      <h1 className="items-title">Items — {contract.name}</h1>

      <form className="items-add-form" onSubmit={handleAdd}>
        <div className="items-add-field">
          <label htmlFor="li-add-code">Item #</label>
          <input
            id="li-add-code"
            ref={codeInputRef}
            className="items-input items-input-mono"
            value={form.itemNumber}
            onChange={(e) => setForm({ ...form, itemNumber: e.target.value })}
            onKeyDown={handleAddKeyDown}
            placeholder="05.03.03"
          />
        </div>
        <div className="items-add-field items-add-field-description">
          <label htmlFor="li-add-description">Description</label>
          <input
            id="li-add-description"
            className="items-input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            onKeyDown={handleAddKeyDown}
            placeholder="Asphalt paving, top lift"
          />
        </div>
        <div className="items-add-field">
          <label htmlFor="li-add-unit">Unit of Measure</label>
          <select
            id="li-add-unit"
            className="items-input"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
            onKeyDown={handleAddKeyDown}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div className="items-add-field">
          <label htmlFor="li-add-quantity">Approximate quantity</label>
          <input
            id="li-add-quantity"
            className="items-input items-input-mono"
            type="number"
            inputMode="decimal"
            step="any"
            value={form.approximateQuantity || ''}
            onChange={(e) => setForm({ ...form, approximateQuantity: parseQuantity(e.target.value) })}
            onKeyDown={handleAddKeyDown}
          />
        </div>
        <button className="items-add-submit" type="submit" disabled={adding}>
          {adding ? 'Adding…' : 'Add — Enter'}
        </button>
      </form>
      {addError && <p className="items-error">{addError}</p>}

      {status === 'loading' && <p className="items-status">Loading…</p>}
      {status === 'error' && <p className="items-error">{loadError}</p>}

      {status === 'ready' && (
        <table className="items-table">
          <thead>
            <tr>
              <th>Item #</th>
              <th>Description</th>
              <th>Unit of Measure</th>
              <th className="items-col-right">Approximate Quantity</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td className="items-empty" colSpan={5}>
                  No items yet — add the first one above.
                </td>
              </tr>
            )}
            {sorted.map((item) =>
              editingId === item.id ? (
                <tr key={item.id}>
                  <td colSpan={5}>
                    <form className="items-edit-form" onSubmit={handleSaveEdit}>
                      <input
                        className="items-input items-input-mono"
                        value={editForm.itemNumber}
                        onChange={(e) => setEditForm({ ...editForm, itemNumber: e.target.value })}
                        aria-label="Item #"
                      />
                      <input
                        className="items-input items-edit-description"
                        value={editForm.description}
                        onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                        aria-label="Description"
                      />
                      <select
                        className="items-input"
                        value={editForm.unit}
                        onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })}
                        aria-label="Unit of Measure"
                      >
                        {UNITS.map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                      </select>
                      <input
                        className="items-input items-input-mono"
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={editForm.approximateQuantity}
                        onChange={(e) => setEditForm({ ...editForm, approximateQuantity: parseQuantity(e.target.value) })}
                        aria-label="Approximate quantity"
                      />
                      <button type="submit" className="items-row-btn" disabled={savingEdit}>
                        {savingEdit ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="items-row-btn" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                      {editError && <span className="items-error items-edit-error">{editError}</span>}
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={item.id}>
                  <td className="items-input-mono">{item.itemNumber}</td>
                  <td>{item.description}</td>
                  <td>{item.unit}</td>
                  <td className="items-col-right items-input-mono">{item.approximateQuantity}</td>
                  <td className="items-col-right">
                    <button type="button" className="items-row-btn" onClick={() => startEdit(item)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
