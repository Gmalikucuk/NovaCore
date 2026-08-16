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
  IconFileText,
  IconFlask,
  IconGavel,
  IconHome,
  IconLayoutDashboard,
  IconListDetails,
  IconLogout,
  IconReceiptDollar,
  IconReportAnalytics,
  IconShoppingCart,
  IconTable,
  IconTruck,
  IconUsers,
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
 * One persistent sidebar for the whole office experience.
 *
 * The tree has two organizing axes, not three. STAGE — pre-award, then
 * this contract — and DIMENSION, the five groups inside a contract:
 * Production, Submissions, Revenue, Cost, Procurement. COMPANY sits
 * outside both, for work that isn't about any one contract or stage at
 * all (Portfolio, Overview, and now Admin nested inside it, since
 * creating a contract or seating a member is company-scope work, not a
 * third axis of its own the way it used to sit as a separate top-level
 * heading).
 *
 * An earlier version of this tree mixed three axes across four headings
 * — Company vs. the contract panel was scope, Production vs. Finance was
 * dimension, Tenders was stage — which is why no arrangement of them
 * read cleanly. Collapsing to two axes is what fixed it, and it also
 * fixed two real placement problems that fell out of the old mix:
 * Progress claims lived in Finance and inherited a rate-visibility gate
 * it never actually needed (its own screen has always gated on
 * prepare_claims, project-management work that happens to carry
 * dollars) — it's under Submissions now, gated on prepare_claims
 * directly. And cost never fit under Finance beside revenue, because it
 * runs the whole length of a contract rather than belonging to one
 * stage — Cost is its own dimension now, gated on set_cost alone rather
 * than the set_cost-and-view_rates combination it inherited only by
 * nesting under the old Finance/view_rates wrapper (no seeded seat on
 * either sandbox contract holds set_cost without view_rates today, so
 * this is a change in principle, not in any real seat's reachable
 * screens — reported, not silently assumed).
 *
 * PRODUCTION is everything that works without a Unit Price (Progress,
 * Tracker, Items, Daily Entry, Confirm) — always visible, no section
 * gate. SUBMISSIONS is what gets sent out: Progress claims (gated on
 * prepare_claims) and Daily reports, a placeholder visible to any seated
 * member (no daily-report right exists yet to gate it on — proposed
 * when it's built). REVENUE is the priced surfaces plus the
 * money-over-time list — Rates, Months, and Payments, a placeholder —
 * all gated on view_rates, same as Finance was. COST holds Cost build,
 * gated on set_cost. PROCUREMENT holds Purchase orders, a placeholder
 * proposed on the same set_cost gate as Cost, since procurement and cost
 * are the same "commits this contract's money" concern with no
 * dedicated right of its own yet.
 *
 * Each section's own visibility is computed inline as the OR of its
 * children's individual conditions — not a named helper meaning "this
 * seat is Finance" or "this seat is a PM." Rights stay atomic; any
 * combination of them stays valid, a section just shows or hides based
 * on whether anything inside it would actually render.
 *
 * The contract-scope panel (name + number, then the five dimension
 * headings) is its own visually distinct block — a left accent border
 * and a filled background — precisely so it reads as "everything in
 * here is about THIS contract," bracketed by COMPANY and PRE-AWARD
 * above at the sidebar's normal, unscoped indent. Reported as a
 * judgment call, not a spec'd pixel value — this is the treatment
 * chosen for 220px.
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

  // Production — Progress and Tracker carry no rights gate of their own,
  // so the section is always visible; the two conditional links are
  // computed here, once, rather than inline at each NavLink.
  const canReachDailyEntry = contract.enterQuantity || contract.correctQuantity || contract.confirmQuantity
  const canSeeItems = contract.createItems
  const canSeeConfirm = contract.confirmQuantity

  // Submissions — Daily reports has no right to gate on yet (proposed
  // when it's built); "visible to any seated member" means unconditional
  // here, which is also why the section itself never actually hides.
  const canSeeProgressClaims = contract.prepareClaims
  const canSeeDailyReports = true
  // Daily Work Reports — matches daily_work_reports' own SELECT policy
  // (record_force_account OR the company-wide rate-visibility rights); a
  // DWR carries rate figures, same finance-wall reasoning as the cost
  // registers themselves.
  const canSeeDwr = contract.recordForceAccount || companyRights.viewCostRegisterRates || companyRights.maintainCostRegisters

  // Revenue — Rates, Months, Payments all gate on the same right today
  // (view_rates), same as Finance's own single gate; written per-child
  // rather than collapsed to one boolean so a future child with its own
  // gate doesn't require restructuring this.
  const canSeeRates = contract.viewRates
  const canSeeMonths = contract.viewRates
  const canSeePayments = contract.viewRates
  const revenueVisible = canSeeRates || canSeeMonths || canSeePayments

  // Cost and Procurement — one child each, so the section's own
  // visibility is just that child's condition.
  const canSeeCostBuild = contract.setCost
  const canSeePurchaseOrders = contract.setCost

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
            </div>

            {/* Admin — company-wide rights (create_projects/manage_members),
                not per-contract, so it's scoped to nothing but the seat's
                own admin standing. Nested inside Company now rather than
                sitting as its own top-level heading — it's company-scope
                work, the same axis Portfolio/Overview are on, not a third
                organizing axis of its own. */}
            {(companyRights.createProjects || companyRights.manageMembers) && (
              <div className="mt-4">
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

            {/* Registers (0048) — company-wide reference data (equipment,
                labour, materials), same "COMPANY = not about any one
                contract or stage" reasoning as Admin just above, and the
                same reasoning Bids uses for staying ungated: identity
                fields are open-read to any seated user, so nothing here
                would ever hide the link — RLS walls the rate figures and
                every write regardless of what the nav shows. */}
            <div className="mt-4">
              <NavGroupHeading>Registers</NavGroupHeading>
              <div className="space-y-0.5">
                <NavLink to="/equipment" className={navLinkClass}>
                  <IconTruck size={18} stroke={1.75} />
                  Equipment
                </NavLink>
                <NavLink to="/labour" className={navLinkClass}>
                  <IconUsers size={18} stroke={1.75} />
                  Labour
                </NavLink>
                <NavLink to="/materials" className={navLinkClass}>
                  <IconFlask size={18} stroke={1.75} />
                  Materials
                </NavLink>
              </div>
            </div>
          </div>

          {/* Pre-award — a stage, not a contract. Ungated here on purpose:
              Bids is open-read to any seated user (0047 — company-wide,
              no membership boundary to scope by), so there is no right
              that would ever hide this link; RLS still walls the write
              surface and bid costs regardless of what the nav shows. */}
          <div>
            <NavGroupHeading>Pre-award</NavGroupHeading>
            <div className="space-y-0.5">
              <NavLink to="/bids" className={navLinkClass}>
                <IconGavel size={18} stroke={1.75} />
                Bids
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
                  {canSeeItems && (
                    <NavLink to="/line-items" className={navLinkClass}>
                      <IconListDetails size={18} stroke={1.75} />
                      Items
                    </NavLink>
                  )}
                  {canReachDailyEntry && (
                    <NavLink to="/daily-entry" className={navLinkClass}>
                      <IconCalendarPlus size={18} stroke={1.75} />
                      Daily Entry
                    </NavLink>
                  )}
                  {canSeeConfirm && (
                    <NavLink to="/confirm" className={navLinkClass}>
                      <IconClipboardCheck size={18} stroke={1.75} />
                      Confirm
                      {pendingCount > 0 && <span className="ml-auto rounded-full bg-nc-accent px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">{pendingCount}</span>}
                    </NavLink>
                  )}
                </div>
              </div>

              {/* Submissions — what gets sent out. Progress claims moved
                  here from Finance; same route, same screen, same
                  behaviour, only its section and its own gate changed —
                  prepare_claims directly, the right the screen itself has
                  always actually checked, rather than the view_rates gate
                  it inherited from sitting under Finance. */}
              <div>
                <NavGroupHeading>Submissions</NavGroupHeading>
                <div className="space-y-0.5">
                  {canSeeProgressClaims && (
                    <NavLink to="/progress-estimates" className={navLinkClass}>
                      <IconFileInvoice size={18} stroke={1.75} />
                      Progress claims
                    </NavLink>
                  )}
                  {canSeeDailyReports && (
                    <NavLink to="/daily-reports" className={navLinkClass}>
                      <IconReportAnalytics size={18} stroke={1.75} />
                      Daily reports
                    </NavLink>
                  )}
                  {canSeeDwr && (
                    <NavLink to="/daily-work-reports" className={navLinkClass}>
                      <IconFileText size={18} stroke={1.75} />
                      Force Account (DWR)
                    </NavLink>
                  )}
                </div>
              </div>

              {/* Revenue — the priced surfaces plus the money-over-time
                  list. The whole section disappears for a seat without
                  view_rates, same as Finance's own gate did. */}
              {revenueVisible && (
                <div>
                  <NavGroupHeading>Revenue</NavGroupHeading>
                  <div className="space-y-0.5">
                    {canSeeRates && (
                      <NavLink to="/rates" className={navLinkClass}>
                        <IconCurrencyDollar size={18} stroke={1.75} />
                        Rates
                      </NavLink>
                    )}
                    {canSeeMonths && (
                      <NavLink to="/finance" className={navLinkClass}>
                        <IconCalendarStats size={18} stroke={1.75} />
                        Months
                      </NavLink>
                    )}
                    {canSeePayments && (
                      <NavLink to="/payments" className={navLinkClass}>
                        <IconReceiptDollar size={18} stroke={1.75} />
                        Payments
                      </NavLink>
                    )}
                  </div>
                </div>
              )}

              {/* Cost — runs the whole length of a contract rather than
                  belonging to one stage, which is why it's its own
                  dimension now instead of nested under Revenue. Gated on
                  set_cost alone. */}
              {canSeeCostBuild && (
                <div>
                  <NavGroupHeading>Cost</NavGroupHeading>
                  <div className="space-y-0.5">
                    <NavLink to="/cost-build" className={navLinkClass}>
                      <IconCalculator size={18} stroke={1.75} />
                      Cost build
                    </NavLink>
                  </div>
                </div>
              )}

              {/* Procurement — new. Purchase orders proposed on the same
                  set_cost gate as Cost: both are "commits this contract's
                  money" concerns, and there's no dedicated procurement
                  right in the schema to gate on instead. */}
              {canSeePurchaseOrders && (
                <div>
                  <NavGroupHeading>Procurement</NavGroupHeading>
                  <div className="space-y-0.5">
                    <NavLink to="/purchase-orders" className={navLinkClass}>
                      <IconShoppingCart size={18} stroke={1.75} />
                      Purchase orders
                    </NavLink>
                  </div>
                </div>
              )}
            </div>
          </div>
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
