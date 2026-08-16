import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { IconArrowLeft } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchMyCompanyRights, type CompanyRights } from '../../lib/supabase/contracts'
import {
  certifyDailyWorkReport,
  createDwrLineItem,
  createDwrSubcontractor,
  deleteDwrLineItem,
  deleteDwrSubcontractor,
  fetchContractDwrLineItems,
  fetchContractForceAccountTerms,
  fetchDailyWorkReport,
  fetchDailyWorkReports,
  fetchDwrLineItems,
  fetchContractDwrSubcontractors,
  fetchDwrSubcontractors,
  recordMinistryAcceptance,
  reopenDailyWorkReport,
  updateDailyWorkReport,
  updateDwrLineItem,
  type ContractForceAccountTerms,
  type DailyWorkReport,
  type DailyWorkReportLineItem,
  type DwrLineItemInput,
  type DwrSubcontractor,
} from '../../lib/supabase/dailyWorkReports'
import { fetchPayrollAdditiveRates, fetchToolAllowanceRates, type PercentRate } from '../../lib/supabase/costRegisters'
import { asOfDate } from '../../lib/calculations/rateHistory'
import { computeAllBlocks, suggestReducedMarkups, summarizeSubcontractorCap, type DwrBlock, type SubFlag } from '../../lib/calculations/dwrCalculations'
import { formatDayLabel } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { rate as fmtRate } from '../../lib/format'
import { Button, Input, NotificationBanner, PageHeader, Select, Spinner, StatusBadge, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const BLOCKS: { key: DwrBlock; label: string }[] = [
  { key: 'A', label: 'A — Labour' },
  { key: 'B', label: 'B — Equipment' },
  { key: 'C', label: 'C — Materials' },
  { key: 'D', label: 'D — Preparatory work' },
  { key: 'E', label: 'E — Food and lodging' },
  { key: 'F', label: 'F — Invoiced work (negotiated)' },
]

const BLANK_LINE: DwrLineItemInput = {
  block: 'A',
  subFlag: 'n',
  subcontractorId: null,
  descriptor: '',
  secondaryDescriptor: '',
  quantity: 0,
  rate: 0,
  amount: 0,
  equipmentId: null,
  labourClassId: null,
  materialId: null,
}

/**
 * One DWR — header, subcontractors, six blocks of line items, and the
 * derived totals. Block subtotals/markups are computed here, never stored
 * (dwrCalculations.ts) — the reduced-markup suggestion is pre-filled from a
 * real cumulative-vs-Tender-Price check but never locks the checkbox, and
 * the subcontractor cap is shown with an explicit unattributed-dollars line
 * rather than a false complete-looking total. Line-item entry is plain text
 * fields (descriptor/rate/quantity/amount) — no equipment/labour/material
 * picker wired to the cost registers yet; equipment_id/labour_class_id/
 * material_id exist on the schema for that to be added later.
 */
export function DailyWorkReportScreen() {
  const contract = useOutletContext<MyContract>()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [companyRights, setCompanyRights] = useState<CompanyRights | null>(null)
  const [dwr, setDwr] = useState<DailyWorkReport | null>(null)
  const [subcontractors, setSubcontractors] = useState<DwrSubcontractor[]>([])
  const [allSubcontractors, setAllSubcontractors] = useState<DwrSubcontractor[]>([])
  const [lineItems, setLineItems] = useState<DailyWorkReportLineItem[]>([])
  const [terms, setTerms] = useState<ContractForceAccountTerms[]>([])
  const [payrollRates, setPayrollRates] = useState<PercentRate[]>([])
  const [toolRates, setToolRates] = useState<PercentRate[]>([])
  const [otherDwrs, setOtherDwrs] = useState<DailyWorkReport[]>([])
  const [otherLineItems, setOtherLineItems] = useState<DailyWorkReportLineItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [newSubName, setNewSubName] = useState('')
  const [newLine, setNewLine] = useState<Record<DwrBlock, DwrLineItemInput>>(() =>
    Object.fromEntries(BLOCKS.map((b) => [b.key, { ...BLANK_LINE, block: b.key }])) as Record<DwrBlock, DwrLineItemInput>,
  )

  function load() {
    if (!id) return
    setStatus('loading')
    Promise.all([
      fetchMyCompanyRights(),
      fetchDailyWorkReport(id),
      fetchDwrSubcontractors(id),
      fetchDwrLineItems(id),
      fetchContractForceAccountTerms(contract.id),
      fetchPayrollAdditiveRates(),
      fetchToolAllowanceRates(),
      fetchDailyWorkReports(contract.id),
      fetchContractDwrLineItems(contract.id),
      fetchContractDwrSubcontractors(contract.id),
    ])
      .then(([rights, dwrRow, subs, lines, allTerms, payroll, tool, allDwrs, allLines, everySub]) => {
        if (!dwrRow) {
          setLoadError('Not found.')
          setStatus('error')
          return
        }
        setCompanyRights(rights)
        setDwr(dwrRow)
        setSubcontractors(subs)
        setAllSubcontractors(everySub)
        setLineItems(lines)
        setTerms(allTerms)
        setPayrollRates(payroll)
        setToolRates(tool)
        setOtherDwrs(allDwrs.filter((d) => d.id !== dwrRow.id))
        setOtherLineItems(allLines.filter((li) => li.dwrId !== dwrRow.id))
        setStatus('ready')
      })
      .catch((err) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }

  useEffect(load, [id, contract.id])

  const currentTerms = useMemo(() => {
    if (!dwr) return null
    return asOfDate(terms, dwr.workDate)
  }, [terms, dwr])

  // payroll_additive_rates/tool_allowance_rates.percent is stored as the raw
  // percentage number (32 meaning 32%, matching the existing cost-register
  // convention — confirmed live: the PROBE fixture data is literally 32/1,
  // not 0.32/0.01) — divide by 100 to get the fraction dwrCalculations.ts
  // expects, same convention as every *_pct column on ForceAccountTerms.
  const payrollPct = useMemo(() => (dwr ? (asOfDate(payrollRates, dwr.workDate)?.percent ?? 0) / 100 : 0), [payrollRates, dwr])
  const toolPct = useMemo(() => (dwr ? (asOfDate(toolRates, dwr.workDate)?.percent ?? 0) / 100 : 0), [toolRates, dwr])

  const computed = useMemo(() => {
    if (!dwr || !currentTerms) return null
    return computeAllBlocks(lineItems, currentTerms, dwr.reducedMarkups, payrollPct, toolPct)
  }, [lineItems, currentTerms, dwr, payrollPct, toolPct])

  const reducedSuggestion = useMemo(() => {
    if (!dwr || !currentTerms || !computed) return null
    const otherByDwr = new Map<string, DailyWorkReportLineItem[]>()
    for (const li of otherLineItems) {
      const arr = otherByDwr.get(li.dwrId) ?? []
      arr.push(li)
      otherByDwr.set(li.dwrId, arr)
    }
    let otherCertifiedTotal = 0
    for (const other of otherDwrs) {
      if (!other.certifiedAt) continue
      const otherTerms = asOfDate(terms, other.workDate) ?? currentTerms
      const otherLines = otherByDwr.get(other.id) ?? []
      otherCertifiedTotal += computeAllBlocks(otherLines, otherTerms, other.reducedMarkups, 0, 0).totalPayable
    }
    return suggestReducedMarkups(otherCertifiedTotal + computed.totalPayable, contract.tenderPrice, currentTerms)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dwr, currentTerms, computed, otherDwrs, otherLineItems, terms, contract.tenderPrice])

  const subcontractorCap = useMemo(() => {
    if (!currentTerms) return null
    const allSubFlagged = [...lineItems, ...otherLineItems].filter((li) => li.subFlag === 'y')
    const withMarkup = allSubFlagged.map((li) => ({ subcontractorId: li.subcontractorId, markupAmount: li.amount * currentTerms.subcontractorMarkupPct }))
    return summarizeSubcontractorCap(withMarkup, currentTerms.subcontractorCapAmount)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineItems, otherLineItems, currentTerms])

  const canWriteHeader = contract.recordForceAccount
  const canWriteLines = contract.recordForceAccount && (companyRights?.viewCostRegisterRates || companyRights?.maintainCostRegisters)
  const locked = !!dwr?.certifiedAt

  async function saveHeaderField(patch: Partial<Parameters<typeof updateDailyWorkReport>[1]>) {
    if (!dwr) return
    setActionError(null)
    try {
      const updated = await updateDailyWorkReport(dwr.id, patch)
      setDwr(updated)
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  /** Not gated by certification — filled in after Keywest certifies, off a returned signed copy. */
  async function saveMinistryField(patch: Parameters<typeof recordMinistryAcceptance>[1]) {
    if (!dwr) return
    setActionError(null)
    try {
      const updated = await recordMinistryAcceptance(dwr.id, patch)
      setDwr(updated)
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  async function handleCertify() {
    if (!dwr) return
    setBusy(true)
    setActionError(null)
    try {
      const updated = await certifyDailyWorkReport(dwr.id)
      setDwr(updated)
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleReopen() {
    if (!dwr) return
    setBusy(true)
    setActionError(null)
    try {
      const updated = await reopenDailyWorkReport(dwr.id)
      setDwr(updated)
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleAddSub() {
    if (!dwr || !newSubName.trim()) return
    try {
      const sub = await createDwrSubcontractor(dwr.id, contract.id, newSubName.trim())
      setSubcontractors((prev) => [...prev, sub])
      setNewSubName('')
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  async function handleRemoveSub(subId: string) {
    try {
      await deleteDwrSubcontractor(subId)
      setSubcontractors((prev) => prev.filter((s) => s.id !== subId))
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  async function handleAddLine(block: DwrBlock) {
    if (!dwr) return
    const input = newLine[block]
    if (!input.descriptor.trim()) return
    try {
      const created = await createDwrLineItem(dwr.id, contract.id, input)
      setLineItems((prev) => [...prev, created])
      setNewLine((prev) => ({ ...prev, [block]: { ...BLANK_LINE, block } }))
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  async function handleUpdateLine(li: DailyWorkReportLineItem, patch: Partial<DwrLineItemInput>) {
    try {
      const input: DwrLineItemInput = {
        block: li.block,
        subFlag: li.subFlag,
        subcontractorId: li.subcontractorId,
        descriptor: li.descriptor,
        secondaryDescriptor: li.secondaryDescriptor,
        quantity: li.quantity,
        rate: li.rate,
        amount: li.amount,
        equipmentId: li.equipmentId,
        labourClassId: li.labourClassId,
        materialId: li.materialId,
        ...patch,
      }
      const updated = await updateDwrLineItem(li.id, input)
      setLineItems((prev) => prev.map((x) => (x.id === li.id ? updated : x)))
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  async function handleDeleteLine(id: string) {
    try {
      await deleteDwrLineItem(id)
      setLineItems((prev) => prev.filter((x) => x.id !== id))
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  if (status === 'loading') return <Spinner />
  if (status === 'error' || !dwr) return <NotificationBanner tone="danger">{loadError ?? 'Not found.'}</NotificationBanner>

  return (
    <div className="flex flex-col gap-4">
      <button className="flex items-center gap-1 text-sm text-nc-text-muted hover:text-nc-text" onClick={() => navigate('/daily-work-reports')}>
        <IconArrowLeft size={16} /> Daily Work Reports
      </button>

      <PageHeader
        title={`DWR ${dwr.dwrNumber}`}
        subtitle={dwr.descriptionOfWork}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={locked ? 'confirmed' : 'draft'}>{locked ? 'Certified' : 'Draft'}</StatusBadge>
            {canWriteHeader && !locked && (
              <Button onClick={handleCertify} disabled={busy}>
                {busy ? 'Certifying…' : 'Certify'}
              </Button>
            )}
            {canWriteHeader && locked && (
              <Button variant="secondary" onClick={handleReopen} disabled={busy}>
                {busy ? 'Reopening…' : 'Reopen'}
              </Button>
            )}
          </div>
        }
      />

      {actionError && <NotificationBanner tone="danger">{actionError}</NotificationBanner>}
      {locked && <NotificationBanner tone="info">Certified — the work date, description, GC version date, reduced-markup flag, and every line item are locked. Reopen to edit.</NotificationBanner>}

      {/* Header fields */}
      <div className="grid grid-cols-2 gap-3 rounded border border-nc-border-subtle bg-nc-surface p-4 sm:grid-cols-4">
        <Field label="Work date">
          <Input type="date" value={dwr.workDate} disabled={!canWriteHeader || locked} onChange={(e) => saveHeaderField({ workDate: e.target.value })} />
        </Field>
        <Field label="GC version date">
          <Input type="date" value={dwr.gcVersionDate} disabled={!canWriteHeader || locked} onChange={(e) => saveHeaderField({ gcVersionDate: e.target.value })} />
        </Field>
        <Field label="Force Account #">
          <Input value={dwr.forceAccountNumber ?? ''} disabled={!canWriteHeader} placeholder="Ministry-assigned" onChange={(e) => saveHeaderField({ forceAccountNumber: e.target.value || null })} />
        </Field>
        <Field label="PS Item #">
          <Input value={dwr.psItemNumber ?? ''} disabled={!canWriteHeader} onChange={(e) => saveHeaderField({ psItemNumber: e.target.value || null })} />
        </Field>
        <Field label="Description of work" className="col-span-2 sm:col-span-4">
          <Input value={dwr.descriptionOfWork} disabled={!canWriteHeader || locked} onChange={(e) => saveHeaderField({ descriptionOfWork: e.target.value })} />
        </Field>
      </div>

      {/* Reduced markups — pre-filled, editable, never locked or enforced */}
      <div className="rounded border border-nc-border-subtle bg-nc-surface p-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dwr.reducedMarkups}
            disabled={!canWriteHeader || locked}
            onChange={(e) => saveHeaderField({ reducedMarkups: e.target.checked })}
          />
          Reduced Force Account mark-ups apply
        </label>
        {reducedSuggestion && (
          <p className="mt-1 text-xs text-nc-text-muted">
            {contract.tenderPrice
              ? `NovaCore computed this: cumulative Force Account (including this DWR) is ${fmtRate(reducedSuggestion.cumulativeForceAccount)} of ${fmtRate(reducedSuggestion.tenderPrice)} Tender Price (${(reducedSuggestion.ratio * 100).toFixed(1)}%). ${reducedSuggestion.suggestReduced ? 'At or above the 25% threshold — suggested checked.' : 'Below the 25% threshold.'} Override if you disagree — this never blocks submission.`
              : 'Tender Price is not on file for this contract, so NovaCore cannot suggest a value — enter this by hand.'}
          </p>
        )}
      </div>

      {/* Subcontractors */}
      <div className="rounded border border-nc-border-subtle bg-nc-surface p-4">
        <h2 className="mb-2 text-sm font-semibold text-nc-text">Subcontractors</h2>
        <ul className="mb-2 flex flex-wrap gap-2">
          {subcontractors.map((s) => (
            <li key={s.id} className="flex items-center gap-1 rounded-full bg-nc-page px-3 py-1 text-sm">
              {s.name}
              {canWriteHeader && !locked && (
                <button className="text-nc-text-muted hover:text-nc-danger-text" onClick={() => handleRemoveSub(s.id)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {canWriteHeader && !locked && (
          <div className="flex gap-2">
            <Input value={newSubName} onChange={(e) => setNewSubName(e.target.value)} placeholder="Subcontractor name" className="w-64" />
            <Button variant="secondary" onClick={handleAddSub} disabled={!newSubName.trim()}>
              Add
            </Button>
          </div>
        )}
      </div>

      {/* Six blocks */}
      {BLOCKS.map(({ key, label }) => {
        const blockLines = lineItems.filter((li) => li.block === key)
        const result = computed?.blocks.find((b) => b.block === key)
        return (
          <div key={key} className="rounded border border-nc-border-subtle bg-nc-surface p-4">
            <h2 className="mb-2 text-sm font-semibold text-nc-text">{label}</h2>
            <Table>
              <THead>
                <TR>
                  <TH>Description</TH>
                  <TH>Detail</TH>
                  <TH>Sub?</TH>
                  <TH align="right">Qty</TH>
                  <TH align="right">Rate</TH>
                  <TH align="right">Amount</TH>
                  {canWriteLines && !locked && <TH />}
                </TR>
              </THead>
              <TBody>
                {blockLines.map((li) => (
                  <TR key={li.id}>
                    <TD>{li.descriptor}</TD>
                    <TD>{li.secondaryDescriptor ?? '—'}</TD>
                    <TD>
                      {canWriteLines && !locked ? (
                        <div className="flex flex-col gap-1">
                          <Select value={li.subFlag} onChange={(e) => handleUpdateLine(li, { subFlag: e.target.value as SubFlag })} className="w-16">
                            <option value="n">n</option>
                            <option value="y">y</option>
                            <option value="a">a</option>
                          </Select>
                          {li.subFlag === 'y' && (
                            <Select
                              value={li.subcontractorId ?? ''}
                              onChange={(e) => handleUpdateLine(li, { subcontractorId: e.target.value || null })}
                              className="w-32 text-xs"
                            >
                              <option value="">Unattributed</option>
                              {subcontractors.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </Select>
                          )}
                        </div>
                      ) : (
                        <>
                          {li.subFlag}
                          {li.subFlag === 'y' && <span className="block text-xs text-nc-text-muted">{subcontractors.find((s) => s.id === li.subcontractorId)?.name ?? 'Unattributed'}</span>}
                        </>
                      )}
                    </TD>
                    <TD align="right" className="nc-numeric">
                      {li.quantity}
                    </TD>
                    <TD align="right" className="nc-numeric">
                      {fmtRate(li.rate)}
                    </TD>
                    <TD align="right" className="nc-numeric">
                      {fmtRate(li.amount)}
                    </TD>
                    {canWriteLines && !locked && (
                      <TD align="right">
                        <button className="text-xs text-nc-text-muted hover:text-nc-danger-text" onClick={() => handleDeleteLine(li.id)}>
                          Remove
                        </button>
                      </TD>
                    )}
                  </TR>
                ))}
                {canWriteLines && !locked && (
                  <TR>
                    <TD>
                      <Input value={newLine[key].descriptor} onChange={(e) => setNewLine((p) => ({ ...p, [key]: { ...p[key], descriptor: e.target.value } }))} placeholder="Name / type / description" />
                    </TD>
                    <TD>
                      <Input
                        value={newLine[key].secondaryDescriptor ?? ''}
                        onChange={(e) => setNewLine((p) => ({ ...p, [key]: { ...p[key], secondaryDescriptor: e.target.value || null } }))}
                        placeholder="Class / year-model"
                      />
                    </TD>
                    <TD>
                      <Select value={newLine[key].subFlag} onChange={(e) => setNewLine((p) => ({ ...p, [key]: { ...p[key], subFlag: e.target.value as SubFlag } }))}>
                        <option value="n">n</option>
                        <option value="y">y</option>
                        <option value="a">a</option>
                      </Select>
                    </TD>
                    <TD align="right">
                      <Input
                        type="number"
                        className="nc-numeric w-20"
                        value={newLine[key].quantity}
                        onChange={(e) => setNewLine((p) => ({ ...p, [key]: { ...p[key], quantity: Number(e.target.value) } }))}
                      />
                    </TD>
                    <TD align="right">
                      <Input
                        type="number"
                        className="nc-numeric w-24"
                        value={newLine[key].rate}
                        onChange={(e) => setNewLine((p) => ({ ...p, [key]: { ...p[key], rate: Number(e.target.value) } }))}
                      />
                    </TD>
                    <TD align="right">
                      <Input
                        type="number"
                        className="nc-numeric w-24"
                        value={newLine[key].amount}
                        onChange={(e) => setNewLine((p) => ({ ...p, [key]: { ...p[key], amount: Number(e.target.value) } }))}
                      />
                    </TD>
                    <TD align="right">
                      <Button variant="secondary" onClick={() => handleAddLine(key)} disabled={!newLine[key].descriptor.trim()}>
                        Add
                      </Button>
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
            {result && (
              <div className="mt-2 flex flex-wrap justify-end gap-4 text-xs text-nc-text-muted">
                <span>Subtotal {fmtRate(result.rawSubtotal)}</span>
                {result.payrollAdditiveAmount !== 0 && <span>Payroll additive {fmtRate(result.payrollAdditiveAmount)}</span>}
                {result.toolAllowanceAmount !== 0 && <span>Tool allowance {fmtRate(result.toolAllowanceAmount)}</span>}
                <span>Basic markup {fmtRate(result.basicMarkupAmount)}</span>
                <span>Sub markup {fmtRate(result.additionalMarkupAmount)}</span>
                <span className="font-semibold text-nc-text">Block total {fmtRate(result.total)}</span>
              </div>
            )}
          </div>
        )
      })}

      {/* Grand total */}
      {computed && (
        <div className="rounded border border-nc-border-subtle bg-nc-surface p-4 text-right">
          <p className="text-lg font-semibold text-nc-text">TOTAL PAYABLE Prime + Sub: {fmtRate(computed.totalPayable)}</p>
        </div>
      )}

      {/* Subcontractor cap */}
      {subcontractorCap && (subcontractorCap.bySubcontractor.length > 0 || subcontractorCap.unattributedMarkup > 0) && (
        <div className="rounded border border-nc-border-subtle bg-nc-surface p-4">
          <h2 className="mb-2 text-sm font-semibold text-nc-text">Subcontractor markup cap (GC 49.03(f)(iii), across every DWR on this contract)</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {subcontractorCap.bySubcontractor.map((s) => {
              const name = allSubcontractors.find((sub) => sub.id === s.subcontractorId)?.name ?? s.subcontractorId
              return (
                <li key={s.subcontractorId} className={s.overCap ? 'text-nc-danger-text' : ''}>
                  {name}: {fmtRate(s.markupToDate)} of {fmtRate(s.capAmount)} cap{s.overCap ? ' — over cap' : ''}
                </li>
              )
            })}
          </ul>
          {subcontractorCap.unattributedMarkup > 0 && (
            <p className="mt-2 text-xs text-nc-warning-text">
              {fmtRate(subcontractorCap.unattributedMarkup)} in subcontractor markup is not attributed to a named subcontractor (no subcontractor_id set on those lines) — this total is INCOMPLETE. Attribute
              every subcontractor-flagged line to see the real figure.
            </p>
          )}
        </div>
      )}

      {/* Ministry acceptance — record-keeping only, not a workflow gate. Not gated by certification. */}
      <div className="grid grid-cols-2 gap-3 rounded border border-nc-border-subtle bg-nc-surface p-4">
        <Field label={dwr.ministryTrackingAcceptedAt ? `Ministry accepted for tracking — ${formatDayLabel(dwr.ministryTrackingAcceptedAt)}` : 'Ministry accepted for tracking (name)'}>
          <Input
            value={dwr.ministryTrackingAcceptedBy ?? ''}
            disabled={!canWriteHeader}
            placeholder="Recorded after the fact"
            onChange={(e) => {
              const name = e.target.value || null
              saveMinistryField({
                ministryTrackingAcceptedBy: name,
                ministryTrackingAcceptedAt: name ? (dwr.ministryTrackingAcceptedAt ?? new Date().toISOString()) : null,
              })
            }}
          />
        </Field>
        <Field label={dwr.ministryPaymentAcceptedAt ? `Ministry accepted for payment — ${formatDayLabel(dwr.ministryPaymentAcceptedAt)}` : 'Ministry accepted for payment (name)'}>
          <Input
            value={dwr.ministryPaymentAcceptedBy ?? ''}
            disabled={!canWriteHeader}
            placeholder="Recorded after the fact"
            onChange={(e) => {
              const name = e.target.value || null
              saveMinistryField({
                ministryPaymentAcceptedBy: name,
                ministryPaymentAcceptedAt: name ? (dwr.ministryPaymentAcceptedAt ?? new Date().toISOString()) : null,
              })
            }}
          />
        </Field>
      </div>
    </div>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs text-nc-text-muted">{label}</label>
      {children}
    </div>
  )
}
