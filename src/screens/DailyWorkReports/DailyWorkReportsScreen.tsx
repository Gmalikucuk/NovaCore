import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconFileText } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchMyCompanyRights, type CompanyRights } from '../../lib/supabase/contracts'
import { createDailyWorkReport, fetchDailyWorkReports, type DailyWorkReport } from '../../lib/supabase/dailyWorkReports'
import { formatDayLabel } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Spinner, StatusBadge, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

/**
 * Daily Work Reports (Force Account claims, GC 49.00) for this contract.
 * Viewing needs recordForceAccount OR the company-wide viewCostRegisterRates/
 * maintainCostRegisters (a DWR carries rate figures, same finance-wall
 * posture as the cost registers) — matching daily_work_reports' own SELECT
 * policy exactly. Creating needs recordForceAccount specifically, matching
 * the INSERT policy — company-wide rate visibility alone is not enough to
 * start a new claim.
 */
export function DailyWorkReportsScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()

  const [companyRights, setCompanyRights] = useState<CompanyRights | null>(null)
  const [dwrs, setDwrs] = useState<DailyWorkReport[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [showNewForm, setShowNewForm] = useState(false)
  const [workDate, setWorkDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [description, setDescription] = useState('')
  const [gcVersionDate, setGcVersionDate] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    Promise.all([fetchMyCompanyRights(), fetchDailyWorkReports(contract.id)])
      .then(([rights, rows]) => {
        if (cancelled) return
        setCompanyRights(rights)
        setDwrs(rows)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(errorMessage(err))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [contract.id])

  const canView = contract.recordForceAccount || companyRights?.viewCostRegisterRates || companyRights?.maintainCostRegisters
  const canCreate = contract.recordForceAccount

  async function handleCreate() {
    if (!description.trim() || !gcVersionDate) return
    setCreating(true)
    setCreateError(null)
    try {
      const dwr = await createDailyWorkReport(contract.id, {
        itemId: null,
        forceAccountNumber: null,
        psItemNumber: null,
        workDate,
        descriptionOfWork: description.trim(),
        gcVersionDate,
        reducedMarkups: false,
      })
      navigate(`/daily-work-reports/${dwr.id}`)
    } catch (err) {
      setCreateError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  if (status === 'loading') return <Spinner />

  if (status === 'error') return <NotificationBanner tone="danger">{loadError}</NotificationBanner>

  if (!canView) {
    return (
      <EmptyState
        title="Needs cost-register visibility"
        description="Daily Work Reports carry rate figures. Needs recordForceAccount, or the company-wide viewCostRegisterRates/maintainCostRegisters, on this contract."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {contract.isSandbox && <SandboxBanner contract={contract} />}
      <PageHeader
        title="Daily Work Reports"
        subtitle="Force Account claims, GC 49.00"
        actions={canCreate ? <Button onClick={() => setShowNewForm((v) => !v)}>{showNewForm ? 'Cancel' : 'New DWR'}</Button> : undefined}
      />

      {showNewForm && (
        <div className="flex flex-wrap items-end gap-2 rounded border border-nc-border-subtle bg-nc-surface p-3">
          <div>
            <label className="mb-1 block text-xs text-nc-text-muted">Work date</label>
            <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          </div>
          <div className="w-64">
            <label className="mb-1 block text-xs text-nc-text-muted">Description of work</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Spillway repairs" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-nc-text-muted">GC version date</label>
            <Input type="date" value={gcVersionDate} onChange={(e) => setGcVersionDate(e.target.value)} />
          </div>
          <Button onClick={handleCreate} disabled={creating || !description.trim() || !gcVersionDate}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
          {createError && <span className="text-sm text-nc-danger-text">{createError}</span>}
        </div>
      )}

      {dwrs.length === 0 ? (
        <EmptyState icon={<IconFileText size={32} stroke={1.5} />} title="No Daily Work Reports yet" description="Create one to start a Force Account claim." />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>DWR #</TH>
              <TH>Date</TH>
              <TH>Description</TH>
              <TH>Force Account #</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {dwrs.map((d) => (
              <TR key={d.id} className="cursor-pointer" onClick={() => navigate(`/daily-work-reports/${d.id}`)}>
                <TD className="nc-numeric">{d.dwrNumber}</TD>
                <TD>{formatDayLabel(d.workDate)}</TD>
                <TD prose>{d.descriptionOfWork}</TD>
                <TD>{d.forceAccountNumber ?? '—'}</TD>
                <TD>
                  <StatusBadge status={d.certifiedAt ? 'confirmed' : 'draft'}>{d.certifiedAt ? 'Certified' : 'Draft'}</StatusBadge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  )
}
