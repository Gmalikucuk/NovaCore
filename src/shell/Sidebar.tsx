import { useEffect, useState } from 'react'
import {
  IconActivity,
  IconCalculator,
  IconCalendarPlus,
  IconCalendarStats,
  IconClipboardCheck,
  IconCurrencyDollar,
  IconDeviceMobile,
  IconFileInvoice,
  IconFilePlus,
  IconGavel,
  IconHome,
  IconLayoutDashboard,
  IconListDetails,
  IconLogout,
  IconTable,
  IconUsersGroup,
} from '@tabler/icons-react'
import { NavLink, Outlet, useNavigate, useOutletContext } from 'react-router-dom'
import type { CurrentContractState } from '../lib/useCurrentContract'
import { useViewMode } from '../lib/useViewMode'
import { useSession } from '../lib/useSession'
import { signOut } from '../lib/supabase/auth'
import { fetchPendingQuantityRecordCount } from '../lib/supabase/quantityRecords'

function navLinkClass({ isActive }: { isActive: boolean }): string {
  const base = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors'
  return isActive ? `${base} bg-white/10 text-white` : `${base} text-white/70 hover:bg-white/5 hover:text-white`
}

function NavGroupHeading({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{children}</p>
}

/**
 * One persistent sidebar for the whole office experience — company-level
 * (Portfolio, Overview, Tenders) and contract-level (Production, Finance)
 * nav together, at all times, rather than the two-shell split this replaces
 * (CompanyShell for company routes, this component for contract routes).
 * That split read as two different apps when Overview/Tenders vanished
 * entirely the moment you opened a contract, and put Rates/Cost build in a
 * "Projects" group that had no other connection to money at all — neither
 * survives here.
 *
 * COMPANY is always visible, ungated — it's not about this contract.
 * PRODUCTION holds every surface that works without a Unit Price (Progress,
 * Tracker, Items, Daily Entry, Confirm) — Progress and Tracker have no
 * rights gate of their own, same as before. FINANCE is the two priced
 * surfaces plus the money-over-time list: Rates, Cost build, Months. The
 * section itself is gated on view_rates — the whole point is that a seat
 * without rate access sees no FINANCE header and no path to Rates/Cost
 * build/Months at all, not a section that's there but empty. Cost build
 * additionally needs set_cost (a write right) on top of that read gate.
 * ADMIN stays its own section — company-wide rights, not contract ones, so
 * it doesn't belong nested inside the contract-scope panel below any more
 * than COMPANY does.
 *
 * The contract-scope panel (name + number, then PRODUCTION and FINANCE) is
 * its own visually distinct block — a left accent border and a filled
 * background — precisely so it reads as "everything in here is about THIS
 * contract," bracketed by COMPANY above and ADMIN below at the sidebar's
 * normal, unscoped indent. Reported as a judgment call, not a spec'd pixel
 * value — this is the treatment chosen for 220px.
 *
 * No contract switcher here — Portfolio and Overview are both where
 * switching contracts happens now (click a row), same established
 * convention as before this restructure.
 */
export function Sidebar() {
  const contractState = useOutletContext<CurrentContractState>()
  const { current: contract, companyRights } = contractState
  const session = useSession()
  const navigate = useNavigate()
  const { mode, setOverride } = useViewMode()
  const [pendingCount, setPendingCount] = useState(0)

  // Fetched once per contract switch (not per render — Sidebar re-renders on
  // every navigation, and this number only changes a couple of times a day).
  useEffect(() => {
    if (!contract?.confirmQuantity) {
      setPendingCount(0)
      return
    }
    let cancelled = false
    fetchPendingQuantityRecordCount(contract.id)
      .then((count) => {
        if (!cancelled) setPendingCount(count)
      })
      .catch(() => {
        /* nav badge only — not worth surfacing as a page error */
      })
    return () => {
      cancelled = true
    }
  }, [contract?.id, contract?.confirmQuantity])

  if (!contract) return null

  function switchToFieldView() {
    setOverride('field')
    navigate('/')
  }

  const canUseFinance = contract.viewRates
  const canReachProduction = contract.enterQuantity || contract.correctQuantity || contract.confirmQuantity

  return (
    <div className="flex h-screen bg-nc-page">
      <aside className="flex w-[220px] shrink-0 flex-col bg-nc-navy text-white">
        <div className="px-5 pb-5 pt-6">
          <p className="text-2xl font-bold leading-none">NovaCore</p>
          <p className="mt-1 text-xs text-white/60">Contract Operations</p>
        </div>

        {/* min-h-0 is load-bearing: a flex child's default min-height is
            `auto`, which refuses to shrink below its content's natural
            height regardless of flex-1/overflow-y-auto — it just grows
            past the sidebar's own height instead of scrolling, pushing the
            footer (identity/view-toggle/sign-out/version) off the bottom
            as nav groups accumulate. min-h-0 is what actually lets this
            element stop at its flex-basis and scroll its overflow. */}
        <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3" aria-label="Office">
          <div>
            <NavGroupHeading>Company</NavGroupHeading>
            <div className="space-y-0.5">
              <NavLink to="/portfolio" className={navLinkClass}>
                <IconHome size={18} stroke={1.75} />
                Portfolio
              </NavLink>
              <NavLink to="/overview" className={navLinkClass}>
                <IconLayoutDashboard size={18} stroke={1.75} />
                Overview
              </NavLink>
              <NavLink to="/tenders" className={navLinkClass}>
                <IconGavel size={18} stroke={1.75} />
                Tenders
              </NavLink>
            </div>
          </div>

          {/* The contract-scope panel — everything in this bordered block
              is about the one contract named at its top, not the company as
              a whole. */}
          <div className="rounded-lg border-l-2 border-nc-accent bg-white/5 p-3">
            <div className="mb-3" title={contract.name}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-white/40">This contract</p>
              <p className="truncate text-sm font-medium text-white">{contract.name}</p>
              {contract.contractNo && <p className="text-xs text-white/50">{contract.contractNo}</p>}
            </div>

            <div className="space-y-4">
              <div>
                <NavGroupHeading>Production</NavGroupHeading>
                <div className="space-y-0.5">
                  <NavLink to="/progress" className={navLinkClass}>
                    <IconActivity size={18} stroke={1.75} />
                    Progress
                  </NavLink>
                  <NavLink to="/tracker" className={navLinkClass}>
                    <IconTable size={18} stroke={1.75} />
                    Tracker
                  </NavLink>
                  {contract.createItems && (
                    <NavLink to="/line-items" className={navLinkClass}>
                      <IconListDetails size={18} stroke={1.75} />
                      Items
                    </NavLink>
                  )}
                  {canReachProduction && (
                    <NavLink to="/daily-entry" className={navLinkClass}>
                      <IconCalendarPlus size={18} stroke={1.75} />
                      Daily Entry
                    </NavLink>
                  )}
                  {contract.confirmQuantity && (
                    <NavLink to="/confirm" className={navLinkClass}>
                      <IconClipboardCheck size={18} stroke={1.75} />
                      Confirm
                      {pendingCount > 0 && <span className="ml-auto rounded-full bg-nc-accent px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">{pendingCount}</span>}
                    </NavLink>
                  )}
                </div>
              </div>

              {/* The whole section disappears for a seat without
                  view_rates — not just the money inside Rates/Months, the
                  entire path to any of the three links. Cost build needs
                  set_cost on top, since it's the one write surface here. */}
              {canUseFinance && (
                <div>
                  <NavGroupHeading>Finance</NavGroupHeading>
                  <div className="space-y-0.5">
                    <NavLink to="/rates" className={navLinkClass}>
                      <IconCurrencyDollar size={18} stroke={1.75} />
                      Rates
                    </NavLink>
                    {contract.setCost && (
                      <NavLink to="/cost-build" className={navLinkClass}>
                        <IconCalculator size={18} stroke={1.75} />
                        Cost build
                      </NavLink>
                    )}
                    <NavLink to="/finance" className={navLinkClass}>
                      <IconCalendarStats size={18} stroke={1.75} />
                      Months
                    </NavLink>
                    <NavLink to="/progress-estimates" className={navLinkClass}>
                      <IconFileInvoice size={18} stroke={1.75} />
                      Progress claims
                    </NavLink>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Company-wide rights (profiles), not per-contract — same as
              the panel above being scoped to one contract, this one is
              scoped to nothing but the seat's own admin standing, so it
              sits outside that bordered block at the sidebar's normal
              indent, same as Company above. */}
          {(companyRights.createProjects || companyRights.manageMembers) && (
            <div>
              <NavGroupHeading>Admin</NavGroupHeading>
              <div className="space-y-0.5">
                {companyRights.createProjects && (
                  <NavLink to="/admin/contracts/new" className={navLinkClass}>
                    <IconFilePlus size={18} stroke={1.75} />
                    Create contract
                  </NavLink>
                )}
                {companyRights.manageMembers && (
                  <NavLink to="/admin/members" className={navLinkClass}>
                    <IconUsersGroup size={18} stroke={1.75} />
                    Seat members
                  </NavLink>
                )}
              </div>
            </div>
          )}
        </nav>

        <div className="space-y-2 border-t border-white/10 p-3">
          {mode === 'office' && (
            <button
              type="button"
              onClick={switchToFieldView}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-white/60 hover:bg-white/5 hover:text-white"
            >
              <IconDeviceMobile size={16} stroke={1.75} />
              Switch to field view
            </button>
          )}
          <p className="truncate px-2 text-xs text-white/50">{session?.user.email}</p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/70 hover:bg-white/5 hover:text-white"
          >
            <IconLogout size={16} stroke={1.75} />
            Sign out
          </button>
          <p className="px-2 text-[11px] text-white/30">v{__APP_VERSION__}</p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {/* The platform-wide width cap: every screen routed through here —
            table or card-list, Rates or Months — gets the same ceiling
            automatically, rather than each one remembering to cap itself.
            1400px matches the dense-table convention (roughly 1200-1400,
            beyond which a row's leftmost and rightmost figures stop being
            scannable in one glance) and is centered (mx-auto) so a wide
            monitor gets breathing room on both sides instead of the column
            hugging the sidebar. An EARLIER attempt at this (max-w-7xl,
            1280px) was abandoned because individual screens weren't yet
            disciplined about their own column widths — a wide table would
            overflow straight past the narrower centered column regardless.
            That's fixed per-screen now (table-layout: fixed, one source of
            truth per column); this cap assumes that discipline holds. A
            screen with genuinely more columns than this affords should be
            measured and reported, not silently exempted here. */}
        <div className="mx-auto max-w-[1400px] px-8 py-8">
          <Outlet context={contractState} />
        </div>
      </main>
    </div>
  )
}
