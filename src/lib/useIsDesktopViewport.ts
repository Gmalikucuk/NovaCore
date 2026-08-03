import { useEffect, useState } from 'react'

const DESKTOP_QUERY = '(min-width: 1024px)'

/**
 * Mirrors DesktopShell.css's own breakpoint exactly (max-width: 1023px hides
 * the desktop shell's content and shows "too narrow" instead) — kept as one
 * source so "which screen do I land on" and "is the desktop shell usable"
 * can never drift apart. Reactive to resize/rotation, not just read once:
 * a desktop viewport should never be able to get stuck on the mobile entry
 * screen, including by navigating back to "/" directly or resizing into it
 * mid-session.
 */
export function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isDesktop
}
