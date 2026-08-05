import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconBuildingSkyscraper } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import { loadContractSummary, type ContractSummary } from '../../lib/supabase/contractSummary'
import { buildProblemList, type ProblemItem } from '../../lib/calculations/overview'
import { sumOrNull } from '../../lib/calculations/margin'
import type { ItemPrice } from '../../lib/supabase/prices'
import { errorMessage } from '../../lib/errorMessage'
import { money } from '../../lib/format'
import { Button, EmptyState, NotificationBanner, PageHeader, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'
import { ProblemRow } from '../../components/ProblemRow'

const ATTENTION_CAP = 5
const PROBLEM_KIND_ORDER: Record<ProblemItem['kind'], number> = { over_quantity: 0, behind_rate: 1, stalled: 2 }

interface TaggedProblem {
  problem: ProblemItem
  contractLabel: string
}

/**
 * Company level — every contract the signed-in user is a member of, rolled
 * up. This used to be a single-contract screen (a contract picker plus the
 * same Progress/Finance tab split the per-contract screens still have);
 * that content moved to ProgressScreen and MonthsScreen, each reached by
 * opening one contract from here or from Portfolio. What's left is the
 * thing neither of those can do: a cross-contract view.
 *
 * No single-contract mode and no picker — it always shows the whole book.
 * A row here is navigation, not a mode switch: clicking sets the active
 * contract and sends you into that contract's Finance (Months) if the seat
 * can price it, Production (Progress) otherwise — the same fork Overview
 * itself exists to make instead of you.
 *
 * Sandbox contracts are excluded from both aggregates below (the stat cards
 * and the needs-attention roll-up) — same rule as Portfolio's own totals,
 * applied consistently here. They still get their own row in the contract
 * list, tagged, same as Portfolio.
 */
export function OverviewScreen() {
  const { contracts, setCurrentId } = useOutletContext<CurrentContractState>()
  const navigate = useNavigate()

  const [summaries, setSummaries] = useState<ContractSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attentionExpanded, setAttentionExpanded] = useState(false)

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

  const realSummaries = useMemo(() => summaries.filter((s) => !s.contract.isSandbox), [summaries])

  const portfolioValue = useMemo(() => sumOrNull(realSummaries.map((s) => s.valueToDate)), [realSummaries])
  const portfolioMargin = useMemo(() => sumOrNull(realSummaries.map((s) => s.marginToDate)), [realSummaries])

  // Every real contract's own problem list, tagged with which contract it's
  // from, then re-sorted worst-consequence-first ACROSS the whole set —
  // buildProblemList already does this within one contract; here it's the
  // same three-bucket ordering (over quantity, behind rate, stalled) applied
  // globally, contracts kept in whatever order they were fetched within
  // each bucket (a stable sort, not a second ranking invented for this).
  const taggedProblems = useMemo(() => {
    const now = new Date()
    const tagged: TaggedProblem[] = realSummaries.flatMap((s) => {
      const label = s.contract.contractNo ? `${s.contract.contractNo} — ${s.contract.name}` : s.contract.name
      return buildProblemList(s.progressRate, now).map((problem) => ({ problem, contractLabel: label }))
    })
    return tagged.slice().sort((a, b) => PROBLEM_KIND_ORDER[a.problem.kind] - PROBLEM_KIND_ORDER[b.problem.kind])
  }, [realSummaries])
  const visibleProblems = attentionExpanded ? taggedProblems : taggedProblems.slice(0, ATTENTION_CAP)
  const hiddenProblemCount = taggedProblems.length - visibleProblems.length

  // itemId is a real UUID (globally unique) — merging every real contract's
  // own price rows into one map is safe, no cross-contract key collision.
  const priceByItem = useMemo(() => {
    const map = new Map<string, ItemPrice>()
    for (const s of realSummaries) for (const p of s.prices) map.set(p.itemId, p)
    return map
  }, [realSummaries])

  function openContract(contract: ContractSummary['contract']) {
    setCurrentId(contract.id)
    navigate(contract.viewRates ? '/finance' : '/progress')
  }

  return (
    <div>
      <PageHeader title="Overview" subtitle={`${contracts.length} contract${contracts.length === 1 ? '' : 's'}`} />

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
              <StatCard label="Value of Work to date" value={money(portfolioValue)} sub="Real contracts only — sandbox excluded" />
              <StatCard
                label="Est. margin to date"
                value={<span className={portfolioMargin !== null && portfolioMargin < 0 ? 'text-nc-danger-text' : ''}>{money(portfolioMargin)}</span>}
                sub="Real contracts only — sandbox excluded"
              />
            </div>

            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Needs attention</h2>
              {taggedProblems.length === 0 ? (
                <p className="text-sm text-nc-text">Every Unit Price Item, across every contract, is progressing normally — nothing over quantity, nothing behind the recent rate, nothing stalled.</p>
              ) : (
                <>
                  <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
                    {visibleProblems.map(({ problem, contractLabel }) => (
                      <ProblemRow key={`${contractLabel}-${problem.kind}-${problem.row.itemId}`} problem={problem} priceByItem={priceByItem} contractLabel={contractLabel} />
                    ))}
                  </div>
                  {hiddenProblemCount > 0 && (
                    <Button type="button" variant="ghost" className="mt-2" onClick={() => setAttentionExpanded(true)}>
                      and {hiddenProblemCount} more
                    </Button>
                  )}
                </>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Contracts</h2>
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
                  {summaries.map((s) => (
                    <TR key={s.contract.id} className="cursor-pointer hover:bg-nc-secondary/60" onClick={() => openContract(s.contract)}>
                      <TD>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-nc-text">{s.contract.contractNo ? `${s.contract.contractNo} — ${s.contract.name}` : s.contract.name}</span>
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
                            openContract(s.contract)
                          }}
                        >
                          Open {s.contract.viewRates ? 'Finance' : 'Progress'}
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </section>
          </>
        ))}
    </div>
  )
}
