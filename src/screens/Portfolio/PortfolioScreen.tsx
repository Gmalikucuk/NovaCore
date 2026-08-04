import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconBuildingSkyscraper } from '@tabler/icons-react'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { fetchItemPrices } from '../../lib/supabase/prices'
import { weightedCompletion } from '../../lib/calculations/overview'
import { margin, sumOrNull } from '../../lib/calculations/margin'
import { errorMessage } from '../../lib/errorMessage'
import { money, percent } from '../../lib/format'
import { Button, EmptyState, NotificationBanner, PageHeader, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

interface ContractSummary {
  contract: MyContract
  percentComplete: number | null
  valueToDate: number | null
  marginToDate: number | null
}

/**
 * Quantity/rate data is per-contract, so this is one round trip per
 * contract, not one big query — same shape as every screen already fetching
 * per-contract progress. fetchItemPrices is skipped (not just filtered)
 * when the seat lacks view_rates on THIS contract, mirroring the existing
 * courtesy pattern (RLS is the real wall either way) — that leaves
 * priceByItem empty, which is what makes valueToDate/marginToDate come out
 * null (absent), not zero, for a contract the seat can't price. The exact
 * same code path also covers Hwy 5's real case: view_rates granted, but no
 * item_prices rows exist yet because nothing's been entered. Absent reads
 * identically either way, which is correct — the portfolio can't and
 * shouldn't distinguish "you can't see it" from "it isn't there yet."
 */
async function loadContractSummary(contract: MyContract): Promise<ContractSummary> {
  const [progressRate, prices] = await Promise.all([fetchItemProgressRate(contract.id), contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([])])
  const priceByItem = new Map(prices.map((p) => [p.itemId, p]))
  const percentComplete = weightedCompletion(progressRate)
  const valueToDate = sumOrNull(
    progressRate.map((r) => {
      const price = priceByItem.get(r.itemId)
      return price?.unitPrice != null ? r.quantityToDate * price.unitPrice : null
    }),
  )
  const marginToDate = sumOrNull(progressRate.map((r) => margin(r.quantityToDate, priceByItem.get(r.itemId)?.costPrice ?? null, priceByItem.get(r.itemId)?.unitPrice ?? null)))
  return { contract, percentComplete, valueToDate, marginToDate }
}

/**
 * Company level — the portfolio across every contract the signed-in user
 * is a member of. Finance's question ("how are we doing across the book"),
 * as distinct from a single contract's Overview (the PM's question, "how
 * is this one contract doing"). Clicking a row is how a contract is
 * entered now — see Sidebar's own comment for why the dropdown switcher
 * moved here instead.
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
  const portfolioValue = useMemo(() => sumOrNull(realSummaries.map((s) => s.valueToDate)), [realSummaries])
  const portfolioMargin = useMemo(() => sumOrNull(realSummaries.map((s) => s.marginToDate)), [realSummaries])

  function openContract(contractId: string) {
    setCurrentId(contractId)
    navigate('/overview')
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
              <StatCard label="Portfolio value to date" value={money(portfolioValue)} sub="Real contracts only — sandbox excluded" />
              <StatCard
                label="Portfolio margin to date"
                value={<span className={portfolioMargin !== null && portfolioMargin < 0 ? 'text-nc-danger-text' : ''}>{money(portfolioMargin)}</span>}
                sub="Real contracts only — sandbox excluded"
              />
            </div>

            <Table>
              <THead>
                <TR>
                  <TH>Contract</TH>
                  <TH align="right">Complete</TH>
                  <TH align="right">Value to date</TH>
                  <TH align="right">Margin to date</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {summaries.map((s) => (
                  <TR key={s.contract.id} className="cursor-pointer hover:bg-nc-secondary/60" onClick={() => openContract(s.contract.id)}>
                    <TD>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-nc-text">{s.contract.contractNo ? `${s.contract.contractNo} — ${s.contract.name}` : s.contract.name}</span>
                        {/* Row-level tag, not a banner — see loadContractSummary's own comment. */}
                        {s.contract.isSandbox && <span className="shrink-0 rounded-full bg-nc-danger-bg px-2 py-0.5 text-xs font-medium text-nc-danger-text">Sandbox</span>}
                      </div>
                    </TD>
                    <TD align="right" className="nc-numeric">
                      {percent(s.percentComplete)}
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
                          openContract(s.contract.id)
                        }}
                      >
                        Open
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </>
        ))}
    </div>
  )
}
