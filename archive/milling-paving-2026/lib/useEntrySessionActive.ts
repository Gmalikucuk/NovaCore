import { useEffect, useState } from 'react'
import { ENTRY_SESSION_ACTIVE_CHANGED_EVENT, isEntrySessionActive } from './entrySessionActive'

/** Reactive read of whether a live entry-screen session is active — see entrySessionActive.ts. */
export function useEntrySessionActive(): boolean {
  const [active, setActive] = useState(isEntrySessionActive())

  useEffect(() => {
    const handler = () => setActive(isEntrySessionActive())
    window.addEventListener(ENTRY_SESSION_ACTIVE_CHANGED_EVENT, handler)
    return () => window.removeEventListener(ENTRY_SESSION_ACTIVE_CHANGED_EVENT, handler)
  }, [])

  return active
}
