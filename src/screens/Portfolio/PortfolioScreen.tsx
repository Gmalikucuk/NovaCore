import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconBuildingSkyscraper } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import { loadContractSummary, type ContractSummary } from '../../lib/supabase/contractSummary'
import { updateContractState } from '../../lib/supabase/contracts'
import type { ContractState } from '../../lib/supabase/contracts'
import {
  CONTRACT_STATE_LABEL,
  CONTRACT_STATE_OPTIONS,
  contractCountsToward,
  contractStateFigureChanges,
  contractStateStalledChange,
  coverageNote,
  figureCoverage,
  OVERVIEW_FIGURE_LABEL,
  pipelineFigures,
} from '../../lib/calculations/overview'
import { sumOrNull } from '../../lib/calculations/margin'
import { errorMessage } from '../../lib/errorMessage'
import { money, rate } from '../../lib/format'
import { Button, ContractStateTag, EmptyState, NotificationBanner, PageHeader, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

function contractLabel(contract: ContractSummary['contract']): string {
  return contract.contractNo ? `${contract.contractNo} — ${contract.name}` : contract.name
}

/**
 * The state control itself. Read-only (just the tag) for a seat without
 * manage_members — "sees the tag and no control," per the brief, with
 * nothing in this component's own markup naming the right. canSetState is
 * the caller's job to compute; this component trusts it, same posture as
 * every other rights-gated control in this app (RLS is the real wall
 * either way).
 *
 * No modal — nothing in this codebase has one. The Select and its
 * confirmation grow inside this cell in place; the row's other cells
 * simply sit beside whatever height that takes, same as a table cell
 * wrapping normally.
 */
function ContractStateCell({ summary, canSetState, onChanged }: { summary: ContractSummary; canSetState: boolean; onChanged: (contractId: string, newState: ContractState) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ContractState>(summary.contract.contractState)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canSetState) {
    return <ContractStateTag state={summary.contract.contractState} />
  }

  const current = summary.contract.contractState

  if (!editing) {
    return (
      <button
        type="button"
        className="flex items-center gap-1.5 rounded hover:bg-nc-secondary"
        onClick={(e) => {
          e.stopPropagation()
          setDraft(current)
          setError(null)
          setEditing(true)
        }}
      >
        <ContractStateTag state={current} />
        <span className="text-xs text-nc-text-subtle underline">Change</span>
      </button>
    )
  }

  const backlog = pipelineFigures(summary.contract.tenderPrice, summary.valueToDate).backlog
  const figureChanges = contractStateFigureChanges(current, draft, { contractValue: summary.contract.tenderPrice, earned: summary.valueToDate, backlog })
  const stalledChange = contractStateStalledChange(current, draft)
  const hasRealChange = draft !== current

  function cancel() {
    setEditing(false)
    setError(null)
  }

  async function confirm() {
    setSaving(true)
    setError(null)
    try {
      await updateContractState(summary.contract.id, draft)
      onChanged(summary.contract.id, draft)
      setEditing(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2">
        <Select value={draft} onChange={(e) => setDraft(e.target.value as ContractState)} disabled={saving} className="w-auto">
          {CONTRACT_STATE_OPTIONS.map((state) => (
            <option key={state} value={state}>
              {CONTRACT_STATE_LABEL[state]}
            </option>
          ))}
        </Select>
        {!hasRealChange && (
          <Button type="button" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        )}
      </div>

      {hasRealChange && (
        <NotificationBanner tone="info" className="max-w-sm">
          <p className="mb-2">
            Moving {contractLabel(summary.contract)} from {CONTRACT_STATE_LABEL[current]} to {CONTRACT_STATE_LABEL[draft]}:
          </p>
          <ul className="mb-2 list-disc space-y-0.5 pl-4">
            {figureChanges.map((c) => (
              <li key={c.figure}>
                {c.gains ? 'Joins' : 'Leaves'} {OVERVIEW_FIGURE_LABEL[c.figure]} ({rate(c.amount)})
              </li>
            ))}
            {stalledChange !== 'unchanged' && <li>Stalled detection turns {stalledChange === 'turns_on' ? 'on' : 'off'} for its Items.</li>}
            {figureChanges.length === 0 && stalledChange === 'unchanged' && <li>No change to any company-wide figure or stalled detection.</li>}
          </ul>
          {error && <p className="mb-2 text-nc-danger-text">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" onClick={() => void confirm()} disabled={saving}>
              {saving ? 'Saving…' : 'Confirm'}
            </Button>
            <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </NotificationBanner>
      )}
    </div>
  )
}

/** Shared row shape for every section below — module-level so it isn't recreated (and every row's identity lost) on each PortfolioScreen render. */
function ContractTable({
  rows,
  canSetState,
  onOpen,
  onStateChanged,
}: {
  rows: ContractSummary[]
  canSetState: boolean
  onOpen: (contractId: string) => void
  onStateChanged: (contractId: string, newState: ContractState) => void
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Contract</TH>
          <TH>State</TH>
          <TH align="right">Value to date</TH>
          <TH align="right">Est. margin to date</TH>
          <TH />
        </TR>
      </THead>
      <TBody>
        {rows.map((s) => (
          <TR key={s.contract.id} className="cursor-pointer hover:bg-nc-secondary/60" onClick={() => onOpen(s.contract.id)}>
            <TD>
              <div className="flex items-center gap-2">
                <span className="font-medium text-nc-text">{contractLabel(s.contract)}</span>
                {/* Row-level tag, not a banner — see loadContractSummary's own comment. */}
                {s.contract.isSandbox && <span className="shrink-0 rounded-full bg-nc-danger-bg px-2 py-0.5 text-xs font-medium text-nc-danger-text">Sandbox</span>}
              </div>
            </TD>
            <TD>
              <ContractStateCell summary={s} canSetState={canSetState} onChanged={onStateChanged} />
            </TD>
            <TD align="right" className="nc-numeric">
              {money(s.valueToDate)}
            </TD>
            <TD align="right" className={`nc-numeric ${s.marginToDate !== null && s.marginToDate < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
              {money(s.marginToDate)}
            </TD>
            <TD align="right" dense>
              <Button
                type="button"
                variant="secondary"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(s.contract.id)
                }}
              >
                Open
              </Button>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}

/**
 * Company level — the portfolio across every contract the signed-in user
 * is a member of. Finance's question ("how are we doing across the book"),
 * as distinct from a single contract's Overview (the PM's question, "how
 * is this one contract doing"). Clicking a row is how a contract is
 * entered now — see Sidebar's own comment for why the dropdown switcher
 * moved here instead.
 *
 * Four sections, one per contract_state group: Pipeline, Active, Warranty
 * Period & Closed Out (merged — see that section's own comment for why
 * closed_out doesn't get a fifth), Archived. Every contract lands in
 * exactly one, including archived ones — Portfolio is the one place an
 * archived contract stays browsable at all; "archived: excluded from
 * every figure and every list" is an Overview rule, not a Portfolio one.
 * Sandbox contracts keep their own row (tagged) within whichever section
 * their state puts them in, same courtesy the pre-state version already
 * extended to the one section that existed.
 */
export function PortfolioScreen() {
  const { contracts, setCurrentId, companyRights } = useOutletContext<CurrentContractState>()
  const navigate = useNavigate()
  // Gated on the same right the column itself is gated on (manage_members,
  // contracts_state_update_right) — RLS is the real wall; this only decides
  // whether the control renders at all. Every contract on this screen came
  // from fetchMyContracts(), so is_member(id) — the RLS policy's other half
  // — already holds for every row here; nothing else to check per-row.
  const canSetState = companyRights.manageMembers

  const [summaries, setSummaries] = useState<ContractSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    setStatus('loading')
    Promise.all(contracts.map(loadContractSummary))
      .then((rows) => {
        setSummaries(rows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contracts])

  // is_sandbox contracts keep their own row (with its own real numbers,
  // clearly tagged) but never contribute to a cross-contract total — a
  // banner is the right unmissable-marker shape for a screen ABOUT one
  // contract, but wrong for a row in a list of many; the tag here is that
  // row's own answer to the same requirement.
  const realSummaries = useMemo(() => summaries.filter((s) => !s.contract.isSandbox), [summaries])
  // Portfolio value/margin are an "earned to date" figure, same rule
  // Overview's own Earned to date uses (contractCountsToward('earned', ...)):
  // a pipeline contract hasn't started, so it has nothing to contribute
  // yet, and an archived one is out of every figure by its own definition.
  const earningSummaries = useMemo(() => realSummaries.filter((s) => contractCountsToward('earned', s.contract.contractState)), [realSummaries])
  const portfolioValue = useMemo(() => sumOrNull(earningSummaries.map((s) => s.valueToDate)), [earningSummaries])
  const portfolioMargin = useMemo(() => sumOrNull(earningSummaries.map((s) => s.marginToDate)), [earningSummaries])
  const portfolioValueCoverage = useMemo(
    () => figureCoverage('earned', realSummaries.map((s) => ({ state: s.contract.contractState, hasData: s.valueToDate !== null }))),
    [realSummaries],
  )
  const portfolioMarginCoverage = useMemo(
    () => figureCoverage('earned', realSummaries.map((s) => ({ state: s.contract.contractState, hasData: s.marginToDate !== null }))),
    [realSummaries],
  )
  const portfolioValueNote = coverageNote(portfolioValueCoverage, 'have no value recorded yet')
  const portfolioMarginNote = coverageNote(portfolioMarginCoverage, 'have no cost recorded yet')

  // Four groups, one per section below — every contract (sandbox included)
  // lands in exactly one.
  const pipelineSummaries = useMemo(() => summaries.filter((s) => s.contract.contractState === 'pipeline'), [summaries])
  const activeSummaries = useMemo(() => summaries.filter((s) => s.contract.contractState === 'active'), [summaries])
  const windingDownSummaries = useMemo(
    () => summaries.filter((s) => s.contract.contractState === 'warranty_period' || s.contract.contractState === 'closed_out'),
    [summaries],
  )
  const archivedSummaries = useMemo(() => summaries.filter((s) => s.contract.contractState === 'archived'), [summaries])

  function openContract(contractId: string) {
    setCurrentId(contractId)
    // Lands at project level, not company-level Overview — "opening a
    // project" per the nav-restructure brief means entering the project's
    // own workspace (Tracker, Items, Rates, ...); Overview lives one level
    // up now and is reached from there directly, not through a contract.
    navigate('/tracker')
  }

  // Local merge, not a refetch — the row already knows its own new value
  // (it just sent it), and a refetch would re-run every valueToDate/
  // marginToDate calculation across every contract for a change that only
  // ever touches one column. The memoized section groups above recompute
  // from this automatically, so the row moves to its new section right
  // away — the same "see it happen" immediacy the confirmation step exists
  // to set up, not a page reload later.
  function handleStateChanged(contractId: string, newState: ContractState) {
    setSummaries((prev) => prev.map((s) => (s.contract.id === contractId ? { ...s, contract: { ...s.contract, contractState: newState } } : s)))
  }

  return (
    <div>
      <PageHeader title="Portfolio" subtitle={`${contracts.length} contract${contracts.length === 1 ? '' : 's'}`} />

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' &&
        (summaries.length === 0 ? (
          <EmptyState icon={<IconBuildingSkyscraper size={32} stroke={1.5} />} title="No contracts yet." description="You aren't seated on a contract yet." />
        ) : (
          <>
            <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <StatCard label="Portfolio value to date" value={money(portfolioValue)} sub={portfolioValueNote ?? 'Real contracts only — sandbox excluded'} />
              <StatCard
                label="Est. portfolio margin to date"
                value={<span className={portfolioMargin !== null && portfolioMargin < 0 ? 'text-nc-danger-text' : ''}>{money(portfolioMargin)}</span>}
                sub={portfolioMarginNote ?? 'Real contracts only — sandbox excluded'}
              />
            </div>

            <section className="mb-8">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Pipeline</h2>
              {pipelineSummaries.length === 0 ? (
                <p className="text-sm text-nc-text-subtle">No contracts in the pipeline.</p>
              ) : (
                <ContractTable rows={pipelineSummaries} canSetState={canSetState} onOpen={openContract} onStateChanged={handleStateChanged} />
              )}
            </section>

            <section className="mb-8">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Active</h2>
              {activeSummaries.length === 0 ? (
                <p className="text-sm text-nc-text-subtle">No active contracts.</p>
              ) : (
                <ContractTable rows={activeSummaries} canSetState={canSetState} onOpen={openContract} onStateChanged={handleStateChanged} />
              )}
            </section>

            {/* Merged, not a fifth section — closed_out has nowhere else
                that fits. It isn't archived (still browsable everywhere
                else, including Overview's money-makers ranking — see that
                screen's own brief), and it isn't active production either.
                Both states share the "not being actively worked, not yet
                removed from view" shape Warranty Period already occupied,
                so it joins that section rather than inventing a new one —
                the per-row tag is what actually tells the two apart, since
                the heading alone can't. */}
            <section className="mb-8">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Warranty Period &amp; Closed Out</h2>
              {windingDownSummaries.length === 0 ? (
                <p className="text-sm text-nc-text-subtle">No contracts in warranty period or closed out.</p>
              ) : (
                <ContractTable rows={windingDownSummaries} canSetState={canSetState} onOpen={openContract} onStateChanged={handleStateChanged} />
              )}
            </section>

            {/* Unlike Overview, which drops an archived contract entirely
                ("removed from view" is Overview's own rule for that state),
                Portfolio is the one place it stays browsable — Finance's
                full-book view is exactly where a closed, historical
                contract should still be findable. */}
            <section className="mb-8">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Archived</h2>
              {archivedSummaries.length === 0 ? (
                <p className="text-sm text-nc-text-subtle">No archived contracts.</p>
              ) : (
                <ContractTable rows={archivedSummaries} canSetState={canSetState} onOpen={openContract} onStateChanged={handleStateChanged} />
              )}
            </section>
          </>
        ))}
    </div>
  )
}
