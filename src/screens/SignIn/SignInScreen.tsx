import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { errorMessage } from '../../lib/errorMessage'
import { signInWithPassword } from '../../lib/supabase/auth'
import { useSession } from '../../lib/useSession'
import './SignInScreen.css'

export function SignInScreen() {
  const session = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // This route sits outside AppShell (see App.tsx), so it's the one place
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
    <div className="sign-in-screen">
      <form className="sign-in-form" onSubmit={handleSubmit}>
        <h1 className="sign-in-wordmark">NovaCore</h1>
        <p className="sign-in-subtitle">Sign in to continue</p>

        <label className="sign-in-label" htmlFor="sign-in-email">
          Email
        </label>
        <input
          id="sign-in-email"
          className="sign-in-input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label className="sign-in-label" htmlFor="sign-in-password">
          Password
        </label>
        <input
          id="sign-in-password"
          className="sign-in-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <p className="sign-in-error">{error}</p>}

        <button className="sign-in-submit" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
