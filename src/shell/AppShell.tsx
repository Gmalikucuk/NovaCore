import { Navigate, Outlet } from 'react-router-dom'
import { useSession } from '../lib/useSession'
import { useCurrentContract } from '../lib/useCurrentContract'
import { signOut } from '../lib/supabase/auth'
import './AppShell.css'

/**
 * Gates every child route on a real Supabase Auth session — v1 has no
 * claimed-identity fallback (see client.ts), so an unauthenticated visitor
 * gets bounced to /sign-in rather than rendering anything that would just
 * fail its RLS checks. `undefined` session (still checking) renders nothing
 * rather than flashing the sign-in screen at someone who's actually
 * logged in.
 */
export function AppShell() {
  const session = useSession()
  const contractState = useCurrentContract()

  if (session === undefined) return null
  if (session === null) return <Navigate to="/sign-in" replace />

  return (
    <div className="app-shell">
      <header className="app-shell-header">
        <span className="app-shell-wordmark">NovaCore</span>
        {contractState.status === 'ready' && contractState.contracts.length > 1 ? (
          <select
            className="app-shell-contract-select"
            value={contractState.current?.id ?? ''}
            onChange={(e) => contractState.setCurrentId(e.target.value)}
          >
            {contractState.contracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : contractState.status === 'ready' && contractState.current ? (
          <span className="app-shell-contract-name">{contractState.current.name}</span>
        ) : null}
        <button className="app-shell-sign-out" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main className="app-shell-main">
        {contractState.status === 'loading' && <p className="app-shell-status">Loading your contracts…</p>}
        {contractState.status === 'none' && <p className="app-shell-status">You aren't assigned to any contract yet.</p>}
        {contractState.status === 'error' && <p className="app-shell-status app-shell-status-error">{contractState.message}</p>}
        {contractState.status === 'ready' && contractState.current && <Outlet context={contractState.current} />}
      </main>
    </div>
  )
}
