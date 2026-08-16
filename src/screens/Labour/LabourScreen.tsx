import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconUsers } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import {
  createLabourClass,
  fetchLabourClasses,
  fetchLabourClassRates,
  fetchPayrollAdditiveRates,
  fetchToolAllowanceRates,
  updateLabourClass,
  upsertLabourClassRate,
  upsertPayrollAdditiveRate,
  upsertToolAllowanceRate,
  type LabourClass,
  type LabourClassRate,
  type PercentRate,
} from '../../lib/supabase/costRegisters'
import { currentByDate } from '../../lib/calculations/rateHistory'
import { errorMessage } from '../../lib/errorMessage'
import { rate, percent } from '../../lib/format'
import { Button, Card, EmptyState, Input, NotificationBanner, PageHeader, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * One of the two company-wide percentages — current value, its history,
 * and (if allowed) a new effective-dated entry. Same "grows in place"
 * shape as everything else, applied to a single figure rather than a row
 * in a table.
 */
function PercentCard({
  label,
  hint,
  rates,
  canWrite,
  onSave,
}: {
  label: string
  hint: string
  rates: PercentRate[]
  canWrite: boolean
  onSave: (percentValue: number, effectiveDate: string) => Promise<PercentRate>
}) {
  const current = useMemo(() => currentByDate(rates), [rates])
  const sorted = useMemo(() => [...rates].sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1)), [rates])

  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(todayIso())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (value.trim() === '' || Number.isNaN(Number(value))) {
      setError('Enter a percentage.')
      return
    }
    setSaving(true)
    try {
      await onSave(Number(value), effectiveDate)
      setAdding(false)
      setValue('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-nc-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-nc-text">{current === null ? '—' : percent(current.percent / 100)}</div>
      <div className="mt-0.5 text-xs text-nc-text-subtle">{current === null ? hint : `Effective ${current.effectiveDate}`}</div>

      {sorted.length > 1 && (
        <ul className="mt-3 space-y-0.5 text-xs text-nc-text-subtle">
          {sorted.slice(1).map((r) => (
            <li key={r.id}>
              {percent(r.percent / 100)} from {r.effectiveDate}
            </li>
          ))}
        </ul>
      )}

      {canWrite &&
        (adding ? (
          <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
            <div className="w-24">
              <label className="mb-1 block text-xs text-nc-text-muted">Percent</label>
              <Input type="number" className="nc-numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="32" />
            </div>
            <div className="w-36">
              <label className="mb-1 block text-xs text-nc-text-muted">Effective date</label>
              <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)} disabled={saving}>
              Cancel
            </Button>
            {error && <span className="w-full text-sm text-nc-danger-text">{error}</span>}
          </form>
        ) : (
          <Button type="button" variant="secondary" className="mt-3" onClick={() => setAdding(true)}>
            New rate
          </Button>
        ))}
    </Card>
  )
}

function LabourClassIdentity({ item }: { item: LabourClass }) {
  return <div className="text-sm text-nc-text">{item.className}</div>
}

/** Inline rate history + add-new-rate for one class — see EquipmentScreen's own copy of this same shape for why "as of" isn't offered here. */
function LabourClassRatesEditor({
  labourClassId,
  rates,
  canWrite,
  onSaved,
}: {
  labourClassId: string
  rates: LabourClassRate[]
  canWrite: boolean
  onSaved: (r: LabourClassRate) => void
}) {
  const [hourlyRate, setHourlyRate] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(todayIso())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sorted = useMemo(() => [...rates].sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1)), [rates])

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (hourlyRate.trim() === '' || Number.isNaN(Number(hourlyRate))) {
      setError('Enter an hourly rate.')
      return
    }
    setSaving(true)
    try {
      const saved = await upsertLabourClassRate(labourClassId, Number(hourlyRate), effectiveDate)
      onSaved(saved)
      setHourlyRate('')
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
              <th className="text-right">Hourly rate</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td className="pr-4">{r.effectiveDate}</td>
                <td className="text-right nc-numeric">{rate(r.hourlyRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite && (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2">
          <div className="w-32">
            <label className="mb-1 block text-xs text-nc-text-muted">Hourly rate</label>
            <Input type="number" className="nc-numeric" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} placeholder="—" />
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
 * Company level (0048) — classes, not named people (argued and settled: a
 * DWR types a name per report; a standing roster is HR-adjacent and
 * separable later). The two payroll percentages sit above the class table
 * because the Ministry's own DWR form states them separately from any one
 * class's rate.
 */
export function LabourScreen() {
  const { companyRights } = useOutletContext<CurrentContractState>()
  const canWrite = companyRights.maintainCostRegisters
  const canSeeRates = companyRights.maintainCostRegisters || companyRights.viewCostRegisterRates

  const [classes, setClasses] = useState<LabourClass[]>([])
  const [classRates, setClassRates] = useState<LabourClassRate[]>([])
  const [payrollAdditive, setPayrollAdditive] = useState<PercentRate[]>([])
  const [toolAllowance, setToolAllowance] = useState<PercentRate[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [form, setForm] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const [ratesOpenId, setRatesOpenId] = useState<string | null>(null)

  function load() {
    setStatus('loading')
    Promise.all([
      fetchLabourClasses(),
      canSeeRates ? fetchLabourClassRates() : Promise.resolve<LabourClassRate[]>([]),
      canSeeRates ? fetchPayrollAdditiveRates() : Promise.resolve<PercentRate[]>([]),
      canSeeRates ? fetchToolAllowanceRates() : Promise.resolve<PercentRate[]>([]),
    ])
      .then(([c, cr, pa, ta]) => {
        setClasses(c)
        setClassRates(cr)
        setPayrollAdditive(pa)
        setToolAllowance(ta)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  const ratesByClass = useMemo(() => {
    const m = new Map<string, LabourClassRate[]>()
    for (const r of classRates) {
      const arr = m.get(r.labourClassId) ?? []
      arr.push(r)
      m.set(r.labourClassId, arr)
    }
    return m
  }, [classRates])

  async function doAdd() {
    setAddError(null)
    if (!form.trim()) {
      setAddError('Enter a class name.')
      return
    }
    setAdding(true)
    try {
      const created = await createLabourClass(form.trim())
      setClasses((prev) => [...prev, created])
      setForm('')
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

  function startEdit(item: LabourClass) {
    setEditingId(item.id)
    setEditValue(item.className)
    setEditError(null)
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setEditError(null)
    if (!editValue.trim()) {
      setEditError('Class name is required.')
      return
    }
    setSavingEdit(true)
    try {
      const updated = await updateLabourClass(editingId, editValue.trim())
      setClasses((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
      setEditingId(null)
    } catch (err) {
      setEditError(errorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  function handleClassRateSaved(saved: LabourClassRate) {
    setClassRates((prev) => [...prev.filter((r) => !(r.labourClassId === saved.labourClassId && r.effectiveDate === saved.effectiveDate)), saved])
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Labour" subtitle={`${classes.length} class${classes.length === 1 ? '' : 'es'}`} />

      {canSeeRates && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PercentCard
            label="Payroll additive"
            hint="Not entered yet"
            rates={payrollAdditive}
            canWrite={canWrite}
            onSave={async (v, d) => {
              const saved = await upsertPayrollAdditiveRate(v, d)
              setPayrollAdditive((prev) => [...prev.filter((r) => r.effectiveDate !== d), saved])
              return saved
            }}
          />
          <PercentCard
            label="Tool allowance"
            hint="The DWR uses 1%"
            rates={toolAllowance}
            canWrite={canWrite}
            onSave={async (v, d) => {
              const saved = await upsertToolAllowanceRate(v, d)
              setToolAllowance((prev) => [...prev.filter((r) => r.effectiveDate !== d), saved])
              return saved
            }}
          />
        </div>
      )}

      {canWrite && (
        <>
          <form onSubmit={handleAdd} className="mb-6 rounded-lg border border-nc-border bg-nc-secondary p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Add a class</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <label className="mb-1 block text-xs text-nc-text-muted">Class name</label>
                <Input value={form} onChange={(e) => setForm(e.target.value)} placeholder="Operator" />
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
        (classes.length === 0 ? (
          <EmptyState icon={<IconUsers size={32} stroke={1.5} />} title="No labour classes yet." description={canWrite ? 'Add the first one above.' : undefined} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Class</TH>
                {canSeeRates && <TH align="right">Current rate</TH>}
                <TH />
              </TR>
            </THead>
            <TBody>
              {classes.map((item) => {
                const itemRates = ratesByClass.get(item.id) ?? []
                const current = currentByDate(itemRates)

                if (editingId === item.id) {
                  return (
                    <TR key={item.id}>
                      <TD colSpan={canSeeRates ? 3 : 2} dense>
                        <form onSubmit={handleSaveEdit} className="flex flex-wrap items-center gap-2">
                          <Input className="min-w-[200px] flex-1" value={editValue} onChange={(e) => setEditValue(e.target.value)} aria-label="Class name" />
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
                            <LabourClassIdentity item={item} />
                            <Button type="button" variant="ghost" onClick={() => setRatesOpenId(null)}>
                              Close
                            </Button>
                          </div>
                          <LabourClassRatesEditor labourClassId={item.id} rates={itemRates} canWrite={canWrite} onSaved={handleClassRateSaved} />
                        </div>
                      </TD>
                    </TR>
                  )
                }

                return (
                  <TR key={item.id}>
                    <TD>
                      <LabourClassIdentity item={item} />
                    </TD>
                    {canSeeRates && (
                      <TD align="right" className="nc-numeric">
                        {current === null ? '—' : rate(current.hourlyRate)}
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
