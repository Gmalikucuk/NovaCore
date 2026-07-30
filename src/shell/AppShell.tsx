import { Navigate, Outlet } from 'react-router-dom'
import { useSession } from '../lib/useSession'
import { useCurrentProject } from '../lib/useCurrentProject'
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
  const projectState = useCurrentProject()

  if (session === undefined) return null
  if (session === null) return <Navigate to="/sign-in" replace />

  return (
    <div className="app-shell">
      <header className="app-shell-header">
        <span className="app-shell-wordmark">NovaCore</span>
        {projectState.status === 'ready' && projectState.projects.length > 1 ? (
          <select
            className="app-shell-project-select"
            value={projectState.current?.id ?? ''}
            onChange={(e) => projectState.setCurrentId(e.target.value)}
          >
            {projectState.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : projectState.status === 'ready' && projectState.current ? (
          <span className="app-shell-project-name">{projectState.current.name}</span>
        ) : null}
        <button className="app-shell-sign-out" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main className="app-shell-main">
        {projectState.status === 'loading' && <p className="app-shell-status">Loading your projects…</p>}
        {projectState.status === 'none' && <p className="app-shell-status">You aren't assigned to any project yet.</p>}
        {projectState.status === 'error' && <p className="app-shell-status app-shell-status-error">{projectState.message}</p>}
        {projectState.status === 'ready' && projectState.current && <Outlet context={projectState.current} />}
      </main>
    </div>
  )
}
