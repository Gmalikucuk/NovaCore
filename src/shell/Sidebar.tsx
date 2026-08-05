import { useEffect, useState } from 'react'
import { IconCalculator, IconCalendarPlus, IconClipboardCheck, IconCurrencyDollar, IconDeviceMobile, IconFilePlus, IconHome, IconListDetails, IconLogout, IconTable, IconUsersGroup } from '@tabler/icons-react'
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
 * The CONTRACT level's shell — one contract at a time, the PM's view (see
 * CompanyShell for the portfolio/company level this sits below). One fixed
 * 220px navy sidebar, no top bar anywhere, replacing the old AppShell
 * (header only) + DesktopShell (nav row beneath it) pair. The field-capture
 * route (EntryScreen) does not use this: a 220px fixed sidebar would eat
 * more than half of a real phone's width, so it keeps its own minimal
 * FieldHeader instead — see App.tsx for how the two are switched between.
 *
 * No contract switcher here anymore — now that a company level exists,
 * switching contracts means going back to the Portfolio (the Home link
 * below) and entering a different one, not picking from a dropdown while
 * still inside a contract. The name shown here is always plain text, not a
 * control, regardless of how many contracts the seat holds.
 *
 * "Projects" is this group's nav label, not a schema term — 0009 removed
 * "project" from the schema vocabulary in favour of Contract, and that
 * stands everywhere the data itself is named (Items, Approximate Quantity,
 * everything a Ministry Representative reads). The workspace section label
 * is allowed to differ from that; nothing below renames the contract itself.
 *
 * Each link is gated on the specific right that screen needs, per 0008 —
 * no bundled role check standing in for all three. Items needs
 * create_items (nothing useful there without it — the screen would be a
 * bare read-only catalog). Rates and Cost build need view_rates alone (Cost
 * build is a placeholder today, but its whole subject — a cost buildup — is
 * finance information behind the same wall as Rates and item_prices'
 * cost_price everywhere else in this app, so it inherits that gate rather
 * than reserving a right that doesn't exist yet). Daily Entry needs
 * enter_quantity OR correct_quantity — either one reaches it, with the
 * unavailable half of the form disabled inside. Overview moved to the
 * company level (CompanyShell) — see that file's own nav instead; it is no
 * longer reachable from here.
 *
 * The ADMIN group renders nothing — no heading, no content — while both
 * company-wide rights (profiles.create_projects/manage_members, not
 * contract_members) are false, rather than showing a heading with
 * permanently nothing under it. The screens those rights would unlock
 * (contract creation, member management) aren't built — a separate task;
 * this only reserves the slot and fetches the rights to gate it on.
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

  return (
    <div className="flex h-screen bg-nc-page">
      <aside className="flex w-[220px] shrink-0 flex-col bg-nc-navy text-white">
        <div className="px-5 pb-5 pt-6">
          <p className="text-2xl font-bold leading-none">NovaCore</p>
          <p className="mt-1 text-xs text-white/60">Contract Operations</p>
        </div>

        <div className="px-5 pb-4">
          <NavLink
            to="/portfolio"
            className="mb-3 flex items-center gap-1.5 text-xs font-medium text-white/60 hover:text-white"
          >
            <IconHome size={14} stroke={1.75} />
            Portfolio
          </NavLink>
          <div title={contract.name}>
            <p className="truncate text-sm font-medium text-white">{contract.name}</p>
            {contract.contractNo && <p className="text-xs text-white/50">{contract.contractNo}</p>}
          </div>
        </div>

        {/* min-h-0 is load-bearing: a flex child's default min-height is
            `auto`, which refuses to shrink below its content's natural
            height regardless of flex-1/overflow-y-auto — it just grows
            past the sidebar's own height instead of scrolling, pushing the
            footer (identity/view-toggle/sign-out/version) off the bottom
            as nav groups accumulate. min-h-0 is what actually lets this
            element stop at its flex-basis and scroll its overflow. */}
        <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3" aria-label="Office">
          <div>
            <NavGroupHeading>Projects</NavGroupHeading>
            <div className="space-y-0.5">
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
              {contract.viewRates && (
                <NavLink to="/rates" className={navLinkClass}>
                  <IconCurrencyDollar size={18} stroke={1.75} />
                  Rates
                </NavLink>
              )}
              {contract.viewRates && (
                <NavLink to="/cost-build" className={navLinkClass}>
                  <IconCalculator size={18} stroke={1.75} />
                  Cost build
                </NavLink>
              )}
            </div>
          </div>

          {(contract.enterQuantity || contract.correctQuantity || contract.confirmQuantity) && (
            <div>
              <NavGroupHeading>Production</NavGroupHeading>
              <div className="space-y-0.5">
                <NavLink to="/daily-entry" className={navLinkClass}>
                  <IconCalendarPlus size={18} stroke={1.75} />
                  Daily Entry
                </NavLink>
                {contract.confirmQuantity && (
                  <NavLink to="/confirm" className={navLinkClass}>
                    <IconClipboardCheck size={18} stroke={1.75} />
                    Confirm
                    {pendingCount > 0 && <span className="ml-auto rounded-full bg-nc-accent px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">{pendingCount}</span>}
                  </NavLink>
                )}
              </div>
            </div>
          )}

          {/* Company-wide rights (profiles), not per-contract — reachable
              from inside a single contract's own nav too, since an admin
              deep in one contract's screens shouldn't have to leave to
              company level just to seat someone elsewhere. Each link
              gated on its own specific right, same as CompanyShell's copy
              of this group. */}
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
        {/* Not centered, not max-w-7xl — that assumed no sidebar competing
            for width (Freight's own layout), which here left ~350px of
            dead gutter on each side of a 1280px column while wide tables
            still overflowed anyway. A modest left offset from the sidebar
            (px-8) and a wide cap; screens with genuine prose or a form
            (not a data table) apply their own narrower max-w- locally. */}
        <div className="max-w-[1800px] px-8 py-8">
          <Outlet context={contract} />
        </div>
      </main>
    </div>
  )
}
