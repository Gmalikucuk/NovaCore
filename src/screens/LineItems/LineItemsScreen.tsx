import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyProject } from '../../lib/supabase/projects'
import { createLineItem, fetchLineItems, updateLineItem, type LineItem, type LineItemInput } from '../../lib/supabase/lineItems'
import { UNITS } from '../../lib/lineItemUnits'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { errorMessage } from '../../lib/errorMessage'
import './LineItemsScreen.css'

const BLANK_FORM: LineItemInput = { itemNo: '', description: '', unit: UNITS[0], bidQuantity: 0 }

function parseQuantity(raw: string): number {
  const n = Number(raw)
  return raw.trim() === '' || Number.isNaN(n) ? 0 : n
}

export function LineItemsScreen() {
  const project = useOutletContext<MyProject>()
  const isPm = project.role === 'project_manager'

  const [items, setItems] = useState<LineItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [form, setForm] = useState<LineItemInput>(BLANK_FORM)
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const codeInputRef = useRef<HTMLInputElement>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<LineItemInput>(BLANK_FORM)
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  useEffect(() => {
    setStatus('loading')
    fetchLineItems(project.id)
      .then((rows) => {
        setItems(rows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [project.id])

  const sorted = useMemo(() => [...items].sort((a, b) => compareItemCodes(a.itemNo, b.itemNo)), [items])

  // Split from the form's onSubmit so onKeyDown can call it directly.
  // Implicit submit-on-Enter is a browser heuristic gated on trusted native
  // key events — it doesn't fire reliably for every input combination (and
  // not at all for synthetic events), and this screen's whole point is
  // "type 48 rows without touching the mouse," so Enter is wired explicitly
  // below rather than left to that heuristic.
  async function doAdd() {
    setAddError(null)
    if (!form.itemNo.trim()) {
      setAddError('Enter an item code.')
      return
    }
    if (!form.description.trim()) {
      setAddError('Enter a description.')
      return
    }
    setAdding(true)
    try {
      const created = await createLineItem(project.id, {
        itemNo: form.itemNo.trim(),
        description: form.description.trim(),
        unit: form.unit,
        bidQuantity: form.bidQuantity,
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

  function startEdit(item: LineItem) {
    setEditingId(item.id)
    setEditForm({ itemNo: item.itemNo, description: item.description, unit: item.unit, bidQuantity: item.bidQuantity })
    setEditError(null)
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setEditError(null)
    if (!editForm.itemNo.trim() || !editForm.description.trim()) {
      setEditError('Code and description are required.')
      return
    }
    setSavingEdit(true)
    try {
      const updated = await updateLineItem(editingId, {
        itemNo: editForm.itemNo.trim(),
        description: editForm.description.trim(),
        unit: editForm.unit,
        bidQuantity: editForm.bidQuantity,
      })
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
      setEditingId(null)
    } catch (err) {
      setEditError(errorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  if (!isPm) {
    return (
      <div className="line-items-screen">
        <p className="line-items-denied">Line items are set up by the project manager. Nothing to do here for your role.</p>
      </div>
    )
  }

  return (
    <div className="line-items-screen">
      <h1 className="line-items-title">Line items — {project.name}</h1>

      <form className="line-items-add-form" onSubmit={handleAdd}>
        <div className="line-items-add-field">
          <label htmlFor="li-add-code">Code</label>
          <input
            id="li-add-code"
            ref={codeInputRef}
            className="line-items-input line-items-input-mono"
            value={form.itemNo}
            onChange={(e) => setForm({ ...form, itemNo: e.target.value })}
            onKeyDown={handleAddKeyDown}
            placeholder="05.03.03"
          />
        </div>
        <div className="line-items-add-field line-items-add-field-description">
          <label htmlFor="li-add-description">Description</label>
          <input
            id="li-add-description"
            className="line-items-input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            onKeyDown={handleAddKeyDown}
            placeholder="Asphalt paving, top lift"
          />
        </div>
        <div className="line-items-add-field">
          <label htmlFor="li-add-unit">Unit</label>
          <select
            id="li-add-unit"
            className="line-items-input"
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
        <div className="line-items-add-field">
          <label htmlFor="li-add-quantity">Contract quantity</label>
          <input
            id="li-add-quantity"
            className="line-items-input line-items-input-mono"
            type="number"
            inputMode="decimal"
            step="any"
            value={form.bidQuantity || ''}
            onChange={(e) => setForm({ ...form, bidQuantity: parseQuantity(e.target.value) })}
            onKeyDown={handleAddKeyDown}
          />
        </div>
        <button className="line-items-add-submit" type="submit" disabled={adding}>
          {adding ? 'Adding…' : 'Add — Enter'}
        </button>
      </form>
      {addError && <p className="line-items-error">{addError}</p>}

      {status === 'loading' && <p className="line-items-status">Loading…</p>}
      {status === 'error' && <p className="line-items-error">{loadError}</p>}

      {status === 'ready' && (
        <table className="line-items-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Description</th>
              <th>Unit</th>
              <th className="line-items-col-right">Contract qty</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td className="line-items-empty" colSpan={5}>
                  No line items yet — add the first one above.
                </td>
              </tr>
            )}
            {sorted.map((item) =>
              editingId === item.id ? (
                <tr key={item.id}>
                  <td colSpan={5}>
                    <form className="line-items-edit-form" onSubmit={handleSaveEdit}>
                      <input
                        className="line-items-input line-items-input-mono"
                        value={editForm.itemNo}
                        onChange={(e) => setEditForm({ ...editForm, itemNo: e.target.value })}
                        aria-label="Code"
                      />
                      <input
                        className="line-items-input line-items-edit-description"
                        value={editForm.description}
                        onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                        aria-label="Description"
                      />
                      <select
                        className="line-items-input"
                        value={editForm.unit}
                        onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })}
                        aria-label="Unit"
                      >
                        {UNITS.map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                      </select>
                      <input
                        className="line-items-input line-items-input-mono"
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={editForm.bidQuantity}
                        onChange={(e) => setEditForm({ ...editForm, bidQuantity: parseQuantity(e.target.value) })}
                        aria-label="Contract quantity"
                      />
                      <button type="submit" className="line-items-row-btn" disabled={savingEdit}>
                        {savingEdit ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="line-items-row-btn" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                      {editError && <span className="line-items-error line-items-edit-error">{editError}</span>}
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={item.id}>
                  <td className="line-items-input-mono">{item.itemNo}</td>
                  <td>{item.description}</td>
                  <td>{item.unit}</td>
                  <td className="line-items-col-right line-items-input-mono">{item.bidQuantity}</td>
                  <td className="line-items-col-right">
                    <button type="button" className="line-items-row-btn" onClick={() => startEdit(item)}>
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
