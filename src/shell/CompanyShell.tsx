import { IconDeviceMobile, IconHome, IconLogout } from '@tabler/icons-react'
import { NavLink, Outlet, useNavigate, useOutletContext } from 'react-router-dom'
import type { CurrentContractState } from '../lib/useCurrentContract'
import { useViewMode } from '../lib/useViewMode'
import { useSession } from '../lib/useSession'
import { signOut } from '../lib/supabase/auth'

function navLinkClass({ isActive }: { isActive: boolean }): string {
  const base = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors'
  return isActive ? `${base} bg-white/10 text-white` : `${base} text-white/70 hover:bg-white/5 hover:text-white`
}

function NavGroupHeading({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{children}</p>
}

/**
 * The company level's own shell — same 220px navy sidebar as the contract
 * level's (Sidebar.tsx), but a different nav: Portfolio (the one screen
 * today) plus a reserved Admin slot, rather than anything scoped to a
 * single contract. Deliberately a separate component rather than a mode
 * flag on Sidebar — the two levels' nav content doesn't overlap at all
 * (nothing here is gated on a contract's rights, everything in Sidebar is),
 * and this is exactly where Admin (contract creation, member seating — a
 * separate brief) hangs off later without touching contract-level nav.
 *
 * No contract switcher here — there's no "current contract" concept at
 * this level to switch. See Sidebar's own comment for where switching
 * moved instead.
 */
export function CompanyShell() {
  const contractState = useOutletContext<CurrentContractState>()
  const { companyRights } = contractState
  const session = useSession()
  const navigate = useNavigate()
  const { mode, setOverride } = useViewMode()

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

        <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3" aria-label="Company">
          <div>
            <NavGroupHeading>Company</NavGroupHeading>
            <div className="space-y-0.5">
              <NavLink to="/portfolio" className={navLinkClass}>
                <IconHome size={18} stroke={1.75} />
                Portfolio
              </NavLink>
            </div>
          </div>

          {/* Reserved, not built — contract creation and member management
              are a separate brief. Same gate Sidebar's own placeholder
              uses (company-wide rights, not a per-contract one), so this
              slot only shows for someone who could eventually use it. */}
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
        <div className="max-w-[1800px] px-8 py-8">
          <Outlet context={contractState} />
        </div>
      </main>
    </div>
  )
}
