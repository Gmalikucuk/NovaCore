import { Navigate, Outlet } from 'react-router-dom'
import { useSession } from '../lib/useSession'
import { useCurrentContract } from '../lib/useCurrentContract'
import { NotificationBanner, Spinner } from '../components/ui'

/**
 * Gates every child route on a real Supabase Auth session — v1 has no
 * claimed-identity fallback (see client.ts), so an unauthenticated visitor
 * gets bounced to /sign-in rather than rendering anything that would just
 * fail its RLS checks. `undefined` session (still checking) renders nothing
 * rather than flashing the sign-in screen at someone who's actually
 * logged in.
 *
 * Deliberately has no header/nav of its own — the old AppShell bundled
 * this auth/contract-loading check together with its header UI, but office
 * (Sidebar) and field (FieldHeader) views now need different chrome around
 * the same underlying gate, so the gate itself renders only the loading/
 * none/error states and an Outlet, nothing structural.
 */
export function AuthGate() {
  const session = useSession()
  const contractState = useCurrentContract()

  if (session === undefined) return null
  if (session === null) return <Navigate to="/sign-in" replace />

  if (contractState.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-nc-text-muted">
        <Spinner />
        <span className="text-sm">Loading your contracts…</span>
      </div>
    )
  }
  if (contractState.status === 'none') {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <NotificationBanner tone="info">You aren't assigned to any contract yet.</NotificationBanner>
      </div>
    )
  }
  if (contractState.status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <NotificationBanner tone="danger">{contractState.message}</NotificationBanner>
      </div>
    )
  }

  if (!contractState.current) return null
  return <Outlet context={contractState} />
}
