import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconTruck } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import {
  createEquipment,
  fetchEquipment,
  fetchEquipmentRates,
  updateEquipment,
  upsertEquipmentRate,
  type Equipment,
  type EquipmentInput,
  type EquipmentRate,
} from '../../lib/supabase/costRegisters'
import { asOfYear, currentByYear } from '../../lib/calculations/rateHistory'
import { errorMessage } from '../../lib/errorMessage'
import { rate } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const BLANK_FORM: EquipmentInput = { equipmentType: '', year: null, make: null, model: null }
const BLANK_RATE_FORM = { bookYear: '', blueBookRate: '', internalRate: '' }

function parseYear(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

/** Type read, make/model beneath it — same identity-line shape used everywhere else in this app. */
function EquipmentIdentity({ item }: { item: Equipment }) {
  return (
    <div>
      <div className="text-sm text-nc-text">{item.equipmentType}</div>
      <div className="mt-0.5 text-xs text-nc-text-subtle">
        {item.year ? `${item.year} · ` : ''}
        {[item.make, item.model].filter(Boolean).join(' ') || '—'}
      </div>
    </div>
  )
}

/**
 * Inline rate history + add-new-rate for one machine — same "grows in
 * place, no modal" posture as every other inline editor in this app. asOf
 * is deliberately not offered here: this screen shows and edits the
 * CURRENT (today) picture only, per rateHistory.ts's own split — a bid or
 * DWR reading rates "as of" some other date is a different consumer, not
 * built in this brief.
 */
function EquipmentRatesEditor({ equipmentId, rates, canWrite, onSaved }: { equipmentId: string; rates: EquipmentRate[]; canWrite: boolean; onSaved: (rate: EquipmentRate) => void }) {
  const [form, setForm] = useState(BLANK_RATE_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sorted = useMemo(() => [...rates].sort((a, b) => b.bookYear - a.bookYear), [rates])

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const bookYear = parseYear(form.bookYear)
    if (bookYear === null) {
      setError('Enter a book year.')
      return
    }
    setSaving(true)
    try {
      const saved = await upsertEquipmentRate(equipmentId, {
        bookYear,
        blueBookRate: form.blueBookRate.trim() === '' ? null : Number(form.blueBookRate),
        internalRate: form.internalRate.trim() === '' ? null : Number(form.internalRate),
      })
      onSaved(saved)
      setForm(BLANK_RATE_FORM)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {sorted.length === 0 ? (
        <p className="text-sm text-nc-text-subtle">No rates entered yet.</p>
      ) : (
        <table className="text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-nc-text-muted">
              <th className="pr-4 text-left">Book year</th>
              <th className="pr-4 text-right">Blue Book rate</th>
              <th className="text-right">Internal rate</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td className="pr-4 nc-numeric">{r.bookYear}</td>
                <td className="pr-4 text-right nc-numeric">{rate(r.blueBookRate)}</td>
                <td className="text-right nc-numeric">{rate(r.internalRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite && (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2">
          <div className="w-24">
            <label className="mb-1 block text-xs text-nc-text-muted">Book year</label>
            <Input className="nc-numeric" value={form.bookYear} onChange={(e) => setForm({ ...form, bookYear: e.target.value })} placeholder="2026" />
          </div>
          <div className="w-32">
            <label className="mb-1 block text-xs text-nc-text-muted">Blue Book rate</label>
            <Input type="number" className="nc-numeric" value={form.blueBookRate} onChange={(e) => setForm({ ...form, blueBookRate: e.target.value })} placeholder="—" />
          </div>
          <div className="w-32">
            <label className="mb-1 block text-xs text-nc-text-muted">Internal rate</label>
            <Input type="number" className="nc-numeric" value={form.internalRate} onChange={(e) => setForm({ ...form, internalRate: e.target.value })} placeholder="—" />
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save rate'}
          </Button>
          {error && <span className="text-sm text-nc-danger-text">{error}</span>}
        </form>
      )}
    </div>
  )
}

/**
 * Company level (0048) — Keywest's own fleet. Reads useOutletContext
 * directly, same as Bids: no single contract to bridge into.
 */
export function EquipmentScreen() {
  const { companyRights } = useOutletContext<CurrentContractState>()
  const canWrite = companyRights.maintainCostRegisters
  const canSeeRates = companyRights.maintainCostRegisters || companyRights.viewCostRegisterRates

  const [equipment, setEquipment] = useState<Equipment[]>([])
  const [rates, setRates] = useState<EquipmentRate[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [form, setForm] = useState<EquipmentInput>(BLANK_FORM)
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EquipmentInput>(BLANK_FORM)
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const [ratesOpenId, setRatesOpenId] = useState<string | null>(null)

  function load() {
    setStatus('loading')
    Promise.all([fetchEquipment(), canSeeRates ? fetchEquipmentRates() : Promise.resolve<EquipmentRate[]>([])])
      .then(([eq, r]) => {
        setEquipment(eq)
        setRates(r)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  const ratesByEquipment = useMemo(() => {
    const m = new Map<string, EquipmentRate[]>()
    for (const r of rates) {
      const arr = m.get(r.equipmentId) ?? []
      arr.push(r)
      m.set(r.equipmentId, arr)
    }
    return m
  }, [rates])

  async function doAdd() {
    setAddError(null)
    if (!form.equipmentType.trim()) {
      setAddError('Enter an equipment type.')
      return
    }
    setAdding(true)
    try {
      const created = await createEquipment({ ...form, equipmentType: form.equipmentType.trim() })
      setEquipment((prev) => [...prev, created])
      setForm(BLANK_FORM)
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

  function startEdit(item: Equipment) {
    setEditingId(item.id)
    setEditForm({ equipmentType: item.equipmentType, year: item.year, make: item.make, model: item.model })
    setEditError(null)
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setEditError(null)
    if (!editForm.equipmentType.trim()) {
      setEditError('Equipment type is required.')
      return
    }
    setSavingEdit(true)
    try {
      const updated = await updateEquipment(editingId, { ...editForm, equipmentType: editForm.equipmentType.trim() })
      setEquipment((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
      setEditingId(null)
    } catch (err) {
      setEditError(errorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  function handleRateSaved(saved: EquipmentRate) {
    setRates((prev) => [...prev.filter((r) => !(r.equipmentId === saved.equipmentId && r.bookYear === saved.bookYear)), saved])
  }

  const currentYear = new Date().getUTCFullYear()

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Equipment" subtitle={`${equipment.length} machine${equipment.length === 1 ? '' : 's'}`} />

      {canWrite && (
        <>
          <form onSubmit={handleAdd} className="mb-6 rounded-lg border border-nc-border bg-nc-secondary p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Add equipment</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <label className="mb-1 block text-xs text-nc-text-muted">Type</label>
                <Input value={form.equipmentType} onChange={(e) => setForm({ ...form, equipmentType: e.target.value })} placeholder="Excavator" />
              </div>
              <div className="w-24">
                <label className="mb-1 block text-xs text-nc-text-muted">Year</label>
                <Input className="nc-numeric" value={form.year ?? ''} onChange={(e) => setForm({ ...form, year: parseYear(e.target.value) })} placeholder="2019" />
              </div>
              <div className="w-40">
                <label className="mb-1 block text-xs text-nc-text-muted">Make</label>
                <Input value={form.make ?? ''} onChange={(e) => setForm({ ...form, make: e.target.value || null })} placeholder="Komatsu" />
              </div>
              <div className="w-40">
                <label className="mb-1 block text-xs text-nc-text-muted">Model</label>
                <Input value={form.model ?? ''} onChange={(e) => setForm({ ...form, model: e.target.value || null })} placeholder="PC210" />
              </div>
              <Button type="submit" disabled={adding}>
                {adding ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </form>
          {addError && (
            <NotificationBanner tone="danger" className="mb-4">
              {addError}
            </NotificationBanner>
          )}
        </>
      )}

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' &&
        (equipment.length === 0 ? (
          <EmptyState icon={<IconTruck size={32} stroke={1.5} />} title="No equipment yet." description={canWrite ? 'Add the first machine above.' : undefined} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Equipment</TH>
                {canSeeRates && <TH align="right">Current rate</TH>}
                <TH />
              </TR>
            </THead>
            <TBody>
              {equipment.map((item) => {
                const itemRates = ratesByEquipment.get(item.id) ?? []
                const current = currentByYear(itemRates)
                const currentThisYear = asOfYear(itemRates, currentYear)

                if (editingId === item.id) {
                  return (
                    <TR key={item.id}>
                      <TD colSpan={canSeeRates ? 3 : 2} dense>
                        <form onSubmit={handleSaveEdit} className="flex flex-wrap items-center gap-2">
                          <Input className="min-w-[200px] flex-1" value={editForm.equipmentType} onChange={(e) => setEditForm({ ...editForm, equipmentType: e.target.value })} aria-label="Type" />
                          <Input className="nc-numeric w-24" value={editForm.year ?? ''} onChange={(e) => setEditForm({ ...editForm, year: parseYear(e.target.value) })} aria-label="Year" />
                          <Input className="w-40" value={editForm.make ?? ''} onChange={(e) => setEditForm({ ...editForm, make: e.target.value || null })} aria-label="Make" />
                          <Input className="w-40" value={editForm.model ?? ''} onChange={(e) => setEditForm({ ...editForm, model: e.target.value || null })} aria-label="Model" />
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
                  )
                }

                if (ratesOpenId === item.id) {
                  return (
                    <TR key={item.id}>
                      <TD colSpan={canSeeRates ? 3 : 2} dense>
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center justify-between">
                            <EquipmentIdentity item={item} />
                            <Button type="button" variant="ghost" onClick={() => setRatesOpenId(null)}>
                              Close
                            </Button>
                          </div>
                          <EquipmentRatesEditor equipmentId={item.id} rates={itemRates} canWrite={canWrite} onSaved={handleRateSaved} />
                        </div>
                      </TD>
                    </TR>
                  )
                }

                return (
                  <TR key={item.id}>
                    <TD>
                      <EquipmentIdentity item={item} />
                    </TD>
                    {canSeeRates && (
                      <TD align="right" className="nc-numeric">
                        {current === null ? (
                          '—'
                        ) : (
                          <div>
                            <div>{rate(current.blueBookRate)}</div>
                            <div className="text-xs text-nc-text-subtle">
                              {current.bookYear} book{currentThisYear === null && ' · not entered for this year'}
                            </div>
                          </div>
                        )}
                      </TD>
                    )}
                    <TD align="right" dense>
                      <div className="flex justify-end gap-2">
                        {canSeeRates && (
                          <Button type="button" variant="secondary" onClick={() => setRatesOpenId(item.id)}>
                            Rates
                          </Button>
                        )}
                        {canWrite && (
                          <Button type="button" variant="secondary" onClick={() => startEdit(item)}>
                            Edit
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        ))}
    </div>
  )
}
