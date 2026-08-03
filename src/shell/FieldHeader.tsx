import { IconDeviceDesktop } from '@tabler/icons-react'
import { Navigate, Outlet, useNavigate, useOutletContext } from 'react-router-dom'
import type { CurrentContractState } from '../lib/useCurrentContract'
import { useViewMode, type ViewMode } from '../lib/useViewMode'
import { signOut } from '../lib/supabase/auth'

/**
 * Chrome for the field-capture route only ("/", index) — deliberately not
 * the 220px Sidebar. That sidebar would consume more than half the width of
 * an actual phone screen, which is exactly the kind of "the app doesn't fit
 * this device" outcome this whole capability-detection effort exists to
 * avoid. This keeps the old AppShell header's shape (wordmark, contract,
 * sign out) at field-appropriate size, and adds the one thing the old
 * header didn't need: a way back to office view — without it, a
 * field-detected or field-overridden user would have no in-app way to reach
 * the office screens, since the sidebar's own toggle isn't reachable from
 * here.
 *
 * Also owns the "office viewport should never land on the field screen"
 * redirect that used to live in App.tsx's IndexRoute — this is the only
 * route that renders at "/", so the decision belongs here, re-evaluated on
 * every render (reactive to the view-mode override, same as the old
 * viewport-width version was reactive to resize).
 *
 * useViewMode() is called exactly ONCE, here, and setOverride is passed
 * down to FieldHeaderBar as a prop rather than each component calling the
 * hook independently — useViewMode's override state is local to each call
 * site, not shared, so two independent calls would silently desync (the
 * bar's setOverride would update localStorage but never re-render this
 * component, which reads its own separate, now-stale `mode`).
 */
export function FieldHeader() {
  const contractState = useOutletContext<CurrentContractState>()
  const { current: contract } = contractState
  const { mode, setOverride } = useViewMode()

  if (mode === 'office') return <Navigate to="/dashboard" replace />
  if (!contract) return null

  return (
    <div className="flex min-h-screen flex-col bg-nc-page">
      <FieldHeaderBar contractState={contractState} setOverride={setOverride} />
      <main className="flex-1">
        <Outlet context={contract} />
      </main>
    </div>
  )
}

function FieldHeaderBar({ contractState, setOverride }: { contractState: CurrentContractState; setOverride: (mode: ViewMode | null) => void }) {
  const { contracts, current: contract, setCurrentId } = contractState
  const navigate = useNavigate()

  if (!contract) return null

  function switchToOfficeView() {
    setOverride('office')
    navigate('/')
  }

  return (
    <header className="flex items-center gap-2 bg-nc-navy px-4 py-3 text-white">
      <span className="shrink-0 text-base font-bold leading-none">NovaCore</span>
      {contracts.length > 1 ? (
        <select
          className="ml-auto min-w-0 max-w-[45%] truncate rounded-md border border-white/20 bg-white/5 px-2 py-1 text-sm text-white"
          value={contract.id}
          onChange={(e) => setCurrentId(e.target.value)}
        >
          {contracts.map((c) => (
            <option key={c.id} value={c.id} className="text-nc-text">
              {c.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="ml-auto min-w-0 max-w-[45%] truncate text-sm text-white/70">{contract.name}</span>
      )}
      <button type="button" onClick={switchToOfficeView} aria-label="Switch to office view" className="shrink-0 rounded-md p-2 text-white/70 hover:bg-white/10 hover:text-white">
        <IconDeviceDesktop size={18} stroke={1.75} />
      </button>
      <button type="button" onClick={() => void signOut()} className="shrink-0 rounded-md border border-white/20 px-3 py-1.5 text-sm text-white">
        Sign out
      </button>
    </header>
  )
}
