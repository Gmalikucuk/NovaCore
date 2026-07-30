import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase/client'

/**
 * Reactive wrapper around the real Supabase Auth session — there is no
 * claimed-identity fallback in the v1 schema the way the archived build had
 * one (see fallback_identity.sql, gone with the reset schema); every write
 * needs a genuine auth.uid(), so every screen that writes needs this.
 *
 * `undefined` means "still checking" (the initial getSession() round-trip
 * hasn't resolved yet) — deliberately distinct from `null` ("checked, no
 * session"), so a screen can show nothing rather than flash a sign-in
 * prompt for people who are actually already logged in.
 */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  return session
}
