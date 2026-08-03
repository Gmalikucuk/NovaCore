import { useEffect, useState } from 'react'
import { IconCalendarPlus, IconClipboardCheck, IconCurrencyDollar, IconDeviceMobile, IconLayoutDashboard, IconListDetails, IconLogout } from '@tabler/icons-react'
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
 * The single office shell — one fixed 220px navy sidebar, no top bar
 * anywhere, replacing the old AppShell (header only) + DesktopShell (nav
 * row beneath it) pair. The field-capture route (EntryScreen) does not use
 * this: a 220px fixed sidebar would eat more than half of a real phone's
 * width, so it keeps its own minimal FieldHeader instead — see App.tsx for
 * how the two are switched between.
 *
 * Each link is gated on the specific right that screen needs, per 0008 —
 * no bundled role check standing in for all three. Items needs
 * create_items (nothing useful there without it — the screen would be a
 * bare read-only catalog). Rates needs view_rates alone. Daily Entry needs
 * enter_quantity OR correct_quantity — either one reaches it, with the
 * unavailable half of the form disabled inside. Overview is never gated
 * here: it's reachable by every contract member, same as the Dashboard it
 * replaced — the finance-specific bands inside it hide themselves when the
 * seat lacks view_rates, the same pattern Dashboard used for its finance
 * columns.
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
  const { contracts, current: contract, setCurrentId, companyRights } = contractState
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
          {contracts.length > 1 ? (
            // The closed control can only show one line of text — a bare
            // name truncates mid-word once it's longer than ~180px
            // ("Hwy 97C Pennask Summ▾"), so the contract number leads
            // (short, unique, never truncates) and the browser's own
            // ellipsis lands in the descriptive tail instead. `title` gives
            // the full name on hover, same as the single-contract case
            // below gets from its own truncate.
            <select
              className="w-full rounded-md border border-white/20 bg-white/5 px-2 py-1.5 text-sm text-white"
              value={contract.id}
              title={contract.name}
              onChange={(e) => setCurrentId(e.target.value)}
            >
              {contracts.map((c) => (
                <option key={c.id} value={c.id} className="text-nc-text">
                  {c.contractNo ? `${c.contractNo} — ${c.name}` : c.name}
                </option>
              ))}
            </select>
          ) : (
            <div title={contract.name}>
              <p className="truncate text-sm font-medium text-white">{contract.name}</p>
              {contract.contractNo && <p className="text-xs text-white/50">{contract.contractNo}</p>}
            </div>
          )}
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3" aria-label="Office">
          <div>
            <NavGroupHeading>Contract</NavGroupHeading>
            <div className="space-y-0.5">
              <NavLink to="/overview" className={navLinkClass}>
                <IconLayoutDashboard size={18} stroke={1.75} />
                Overview
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

          {/* Reserved, not built — contract creation and member management
              have no screens yet (a separate task). Gated on the rights so
              the slot only appears for someone who could eventually use it,
              but there is nowhere to link to yet, so it shows a
              placeholder rather than a route that would 404. */}
          {(companyRights.createProjects || companyRights.manageMembers) && (
            <div>
              <NavGroupHeading>Admin</NavGroupHeading>
              <p className="px-3 py-2 text-sm text-white/40">Coming soon</p>
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
