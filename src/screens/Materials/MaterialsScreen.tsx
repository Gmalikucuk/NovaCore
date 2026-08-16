import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconFlask } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import { createMaterial, fetchMaterials, fetchMaterialRates, updateMaterial, upsertMaterialRate, type Material, type MaterialRate } from '../../lib/supabase/costRegisters'
import { currentByDate } from '../../lib/calculations/rateHistory'
import { errorMessage } from '../../lib/errorMessage'
import { rate } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function MaterialIdentity({ item }: { item: Material }) {
  return (
    <div>
      <div className="text-sm text-nc-text">{item.description}</div>
      <div className="mt-0.5 text-xs text-nc-text-subtle">{item.unit}</div>
    </div>
  )
}

/** Inline rate history + add-new-rate for one material — same shape as LabourScreen's class-rate editor. */
function MaterialRatesEditor({ materialId, rates, canWrite, onSaved }: { materialId: string; rates: MaterialRate[]; canWrite: boolean; onSaved: (r: MaterialRate) => void }) {
  const [value, setValue] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(todayIso())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sorted = useMemo(() => [...rates].sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1)), [rates])

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (value.trim() === '' || Number.isNaN(Number(value))) {
      setError('Enter a rate.')
      return
    }
    setSaving(true)
    try {
      const saved = await upsertMaterialRate(materialId, Number(value), effectiveDate)
      onSaved(saved)
      setValue('')
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
              <th className="pr-4 text-left">Effective date</th>
              <th className="text-right">Rate</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td className="pr-4">{r.effectiveDate}</td>
                <td className="text-right nc-numeric">{rate(r.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite && (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2">
          <div className="w-32">
            <label className="mb-1 block text-xs text-nc-text-muted">Rate</label>
            <Input type="number" className="nc-numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="—" />
          </div>
          <div className="w-36">
            <label className="mb-1 block text-xs text-nc-text-muted">Effective date</label>
            <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
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
 * Company level (0048) — description and unit only. Whether a given use
 * is purchased fresh or drawn from stock is a fact about that specific
 * consumption, not about the material generally (argued and settled) —
 * not a field here, and belongs on whatever eventually consumes a
 * material line.
 */
export function MaterialsScreen() {
  const { companyRights } = useOutletContext<CurrentContractState>()
  const canWrite = companyRights.maintainCostRegisters
  const canSeeRates = companyRights.maintainCostRegisters || companyRights.viewCostRegisterRates

  const [materials, setMaterials] = useState<Material[]>([])
  const [rates, setRates] = useState<MaterialRate[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [descriptionForm, setDescriptionForm] = useState('')
  const [unitForm, setUnitForm] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDescription, setEditDescription] = useState('')
  const [editUnit, setEditUnit] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const [ratesOpenId, setRatesOpenId] = useState<string | null>(null)

  function load() {
    setStatus('loading')
    Promise.all([fetchMaterials(), canSeeRates ? fetchMaterialRates() : Promise.resolve<MaterialRate[]>([])])
      .then(([m, r]) => {
        setMaterials(m)
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

  const ratesByMaterial = useMemo(() => {
    const m = new Map<string, MaterialRate[]>()
    for (const r of rates) {
      const arr = m.get(r.materialId) ?? []
      arr.push(r)
      m.set(r.materialId, arr)
    }
    return m
  }, [rates])

  async function doAdd() {
    setAddError(null)
    if (!descriptionForm.trim()) {
      setAddError('Enter a description.')
      return
    }
    if (!unitForm.trim()) {
      setAddError('Enter a unit.')
      return
    }
    setAdding(true)
    try {
      const created = await createMaterial(descriptionForm.trim(), unitForm.trim())
      setMaterials((prev) => [...prev, created])
      setDescriptionForm('')
      setUnitForm('')
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

  function startEdit(item: Material) {
    setEditingId(item.id)
    setEditDescription(item.description)
    setEditUnit(item.unit)
    setEditError(null)
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setEditError(null)
    if (!editDescription.trim() || !editUnit.trim()) {
      setEditError('Description and unit are required.')
      return
    }
    setSavingEdit(true)
    try {
      const updated = await updateMaterial(editingId, editDescription.trim(), editUnit.trim())
      setMaterials((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
      setEditingId(null)
    } catch (err) {
      setEditError(errorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  function handleRateSaved(saved: MaterialRate) {
    setRates((prev) => [...prev.filter((r) => !(r.materialId === saved.materialId && r.effectiveDate === saved.effectiveDate)), saved])
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Materials" subtitle={`${materials.length} material${materials.length === 1 ? '' : 's'}`} />

      {canWrite && (
        <>
          <form onSubmit={handleAdd} className="mb-6 rounded-lg border border-nc-border bg-nc-secondary p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Add a material</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1">
                <label className="mb-1 block text-xs text-nc-text-muted">Description</label>
                <Input value={descriptionForm} onChange={(e) => setDescriptionForm(e.target.value)} placeholder="Asphalt mix" />
              </div>
              <div className="w-32">
                <label className="mb-1 block text-xs text-nc-text-muted">Unit</label>
                <Input value={unitForm} onChange={(e) => setUnitForm(e.target.value)} placeholder="Tonne" />
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
        (materials.length === 0 ? (
          <EmptyState icon={<IconFlask size={32} stroke={1.5} />} title="No materials yet." description={canWrite ? 'Add the first one above.' : undefined} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Material</TH>
                {canSeeRates && <TH align="right">Current rate</TH>}
                <TH />
              </TR>
            </THead>
            <TBody>
              {materials.map((item) => {
                const itemRates = ratesByMaterial.get(item.id) ?? []
                const current = currentByDate(itemRates)

                if (editingId === item.id) {
                  return (
                    <TR key={item.id}>
                      <TD colSpan={canSeeRates ? 3 : 2} dense>
                        <form onSubmit={handleSaveEdit} className="flex flex-wrap items-center gap-2">
                          <Input className="min-w-[240px] flex-1" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} aria-label="Description" />
                          <Input className="w-32" value={editUnit} onChange={(e) => setEditUnit(e.target.value)} aria-label="Unit" />
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
                            <MaterialIdentity item={item} />
                            <Button type="button" variant="ghost" onClick={() => setRatesOpenId(null)}>
                              Close
                            </Button>
                          </div>
                          <MaterialRatesEditor materialId={item.id} rates={itemRates} canWrite={canWrite} onSaved={handleRateSaved} />
                        </div>
                      </TD>
                    </TR>
                  )
                }

                return (
                  <TR key={item.id}>
                    <TD>
                      <MaterialIdentity item={item} />
                    </TD>
                    {canSeeRates && (
                      <TD align="right" className="nc-numeric">
                        {current === null ? '—' : rate(current.rate)}
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
