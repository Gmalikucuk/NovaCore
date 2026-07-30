import { useCallback, useEffect, useState } from 'react'
import {
  clearEntrySession,
  DEFAULT_ENTRY_SESSION,
  ENTRY_SESSION_CHANGED_EVENT,
  getEntrySession,
  setEntrySession,
  type EntrySessionState,
} from './entrySession'

/**
 * Reactive read/write of a persisted entry session — see entrySession.ts.
 * Keyed by activity + project + physical direction (NB/SB), not by segment:
 * the active segment is auto-resolved from the station and can change mid-
 * session, so it lives inside the session state rather than being the key.
 */
export function useEntrySession(activity: string, projectId: string | null, direction: string | null) {
  const ready = projectId !== null && direction !== null

  const [session, setSessionState] = useState<EntrySessionState>(() =>
    ready ? getEntrySession(activity, projectId, direction) : DEFAULT_ENTRY_SESSION,
  )

  // Re-read whenever the project/direction (or activity) changes — this is
  // what makes switching back to a previously-used project/direction resume
  // its own session instead of carrying over the last-viewed one.
  useEffect(() => {
    setSessionState(ready ? getEntrySession(activity, projectId, direction) : DEFAULT_ENTRY_SESSION)
  }, [activity, projectId, direction, ready])

  // Keep in sync with writes from other mounts of this same hook (e.g. a
  // second tab) — mirrors useCurrentProfile's cross-tab 'storage' handling.
  useEffect(() => {
    function handleChange() {
      setSessionState(ready ? getEntrySession(activity, projectId, direction) : DEFAULT_ENTRY_SESSION)
    }
    window.addEventListener(ENTRY_SESSION_CHANGED_EVENT, handleChange)
    window.addEventListener('storage', handleChange)
    return () => {
      window.removeEventListener(ENTRY_SESSION_CHANGED_EVENT, handleChange)
      window.removeEventListener('storage', handleChange)
    }
  }, [activity, projectId, direction, ready])

  const update = useCallback(
    (patch: Partial<EntrySessionState>) => {
      if (!ready) return
      const next = { ...getEntrySession(activity, projectId, direction), ...patch }
      setEntrySession(activity, projectId, direction, next)
      setSessionState(next)
    },
    [activity, projectId, direction, ready],
  )

  const clear = useCallback(() => {
    if (!ready) return
    clearEntrySession(activity, projectId, direction)
    setSessionState(DEFAULT_ENTRY_SESSION)
  }, [activity, projectId, direction, ready])

  return { session, update, clear }
}
