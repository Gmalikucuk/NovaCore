import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { errorMessage } from '../../lib/errorMessage'
import { signInWithPassword } from '../../lib/supabase/auth'
import { useSession } from '../../lib/useSession'
import { Button, Input, NotificationBanner } from '../../components/ui'

export function SignInScreen() {
  const session = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // This route sits outside AuthGate (see App.tsx), so it's the one place
  // responsible for leaving itself once a session exists — both for an
  // already-signed-in visitor landing here directly, and for the moment
  // sign-in succeeds below (onAuthStateChange updates `session`, which
  // re-renders this component into the redirect branch).
  if (session) return <Navigate to="/" replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signInWithPassword(email.trim(), password)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-nc-page p-6">
      {/* The one card in the app with rounded-xl + shadow-2xl — every other
          card uses Card's rounded-lg/shadow-sm; sign-in is the single
          unauthenticated screen and reads better with more presence. */}
      <form onSubmit={handleSubmit} className="w-full max-w-[360px] rounded-xl border border-nc-border bg-white p-8 shadow-2xl">
        <h1 className="text-center text-3xl font-bold text-nc-navy">NovaCore</h1>
        <p className="mb-4 text-center text-sm text-nc-text-muted">Sign in to continue</p>

        <label className="mb-1 mt-3 block text-sm font-semibold text-nc-text-muted" htmlFor="sign-in-email">
          Email
        </label>
        <Input id="sign-in-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />

        <label className="mb-1 mt-3 block text-sm font-semibold text-nc-text-muted" htmlFor="sign-in-password">
          Password
        </label>
        <Input id="sign-in-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />

        {error && (
          <NotificationBanner tone="danger" className="mt-3">
            {error}
          </NotificationBanner>
        )}

        <Button type="submit" disabled={submitting} className="mt-5 w-full">
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
