// TEMPORARY UNAUTHENTICATED FALLBACK — see
// supabase/migrations/20260707110000_fallback_identity.sql for the full
// rationale. This is a locally-stored, self-asserted "who am I" claim, not
// a real login: no password, no verification, trivially changeable by
// anyone with access to the device. It exists so the app is usable before
// real auth (Google OAuth) ships, and should be retired once it does.

const STORAGE_KEY = 'novacore:current-profile'
const PROFILE_CHANGED_EVENT = 'novacore:profile-changed'

export interface CurrentProfile {
  id: string
  name: string
  role: string
}

export function getCurrentProfile(): CurrentProfile | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CurrentProfile
  } catch {
    return null
  }
}

export function getCurrentProfileId(): string | null {
  return getCurrentProfile()?.id ?? null
}

export function setCurrentProfile(profile: CurrentProfile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
  window.dispatchEvent(new Event(PROFILE_CHANGED_EVENT))
}

export function clearCurrentProfile(): void {
  localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new Event(PROFILE_CHANGED_EVENT))
}

export { PROFILE_CHANGED_EVENT }
