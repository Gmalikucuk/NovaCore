import { useEffect, useState } from 'react'
import { getCurrentProfile, PROFILE_CHANGED_EVENT, type CurrentProfile } from './profile'

/** Reactive read of the current (unverified, self-asserted) profile — see profile.ts. */
export function useCurrentProfile(): CurrentProfile | null {
  const [profile, setProfile] = useState<CurrentProfile | null>(getCurrentProfile())

  useEffect(() => {
    const handler = () => setProfile(getCurrentProfile())
    window.addEventListener(PROFILE_CHANGED_EVENT, handler)
    window.addEventListener('storage', handler) // keep tabs in sync
    return () => {
      window.removeEventListener(PROFILE_CHANGED_EVENT, handler)
      window.removeEventListener('storage', handler)
    }
  }, [])

  return profile
}
