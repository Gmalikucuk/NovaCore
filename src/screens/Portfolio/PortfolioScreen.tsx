import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconBuildingSkyscraper } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import { loadContractSummary, type ContractSummary } from '../../lib/supabase/contractSummary'
import { contractCountsToward, coverageNote, figureCoverage } from '../../lib/calculations/overview'
import { sumOrNull } from '../../lib/calculations/margin'
import { errorMessage } from '../../lib/errorMessage'
import { money } from '../../lib/format'
import { Button, ContractStateTag, EmptyState, NotificationBanner, PageHeader, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

/** Shared row shape for every section below — module-level so it isn't recreated (and every row's identity lost) on each PortfolioScreen render. */
function ContractTable({ rows, showStateBadge, onOpen }: { rows: ContractSummary[]; showStateBadge: boolean; onOpen: (contractId: string) => void }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Contract</TH>
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
                <span className="font-medium text-nc-text">{s.contract.contractNo ? `${s.contract.contractNo} — ${s.contract.name}` : s.contract.name}</span>
                {showStateBadge && <ContractStateTag state={s.contract.contractState} />}
                {/* Row-level tag, not a banner — see loadContractSummary's own comment. */}
                {s.contract.isSandbox && <span className="shrink-0 rounded-full bg-nc-danger-bg px-2 py-0.5 text-xs font-medium text-nc-danger-text">Sandbox</span>}
              </div>
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
  const { contracts, setCurrentId } = useOutletContext<CurrentContractState>()
  const navigate = useNavigate()

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
                <ContractTable rows={pipelineSummaries} showStateBadge={false} onOpen={openContract} />
              )}
            </section>

            <section className="mb-8">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Active</h2>
              {activeSummaries.length === 0 ? (
                <p className="text-sm text-nc-text-subtle">No active contracts.</p>
              ) : (
                <ContractTable rows={activeSummaries} showStateBadge={false} onOpen={openContract} />
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
                <ContractTable rows={windingDownSummaries} showStateBadge={true} onOpen={openContract} />
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
                <ContractTable rows={archivedSummaries} showStateBadge={false} onOpen={openContract} />
              )}
            </section>
          </>
        ))}
    </div>
  )
}
