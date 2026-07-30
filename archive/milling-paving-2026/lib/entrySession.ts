// Local-first, per-(activity, project, direction) entry-session state — same
// localStorage-backed pattern as profile.ts. Survives navigating away and
// back, closing and reopening the tab, and going offline/online (all pure
// localStorage reads/writes, nothing network-dependent). Only cleared by an
// explicit clearEntrySession call (the "End session" action) — never by
// navigation, app restart, or a connectivity change.
//
// Keyed by activity ('milling', later 'paving') + project + physical
// direction (NB/SB/etc), NOT by road_segment_id — the active segment can
// change mid-session (auto-detected from the station as the crew crosses a
// segment boundary) while the walk itself continues uninterrupted, so it's
// tracked as a field WITHIN the session rather than being the session's key.
// Two independent sessions (different activities, or the same activity on
// two different project/direction combinations) never collide or overwrite
// each other.

export type EntrySessionDirection = 'ascending' | 'descending'

export interface EntrySessionState {
  direction: EntrySessionDirection | null
  /** Last station committed IN THIS SESSION — not the day's history — since the first reading of a session always requires manual entry with no proposal. */
  lastStation: number | null
  /** Segment auto-resolved from the most recent station — may change mid-session as the walk crosses a segment boundary. */
  activeSegmentId: string | null
  blocked: boolean
  blockMessage: string | null
}

/** Carried via router state from a "Continue from here" tap on a past session (MillingHomeScreen, shared by Paving too) to the activity's own setup screen — pre-fills its four fields without touching this device's own persisted session for that project/direction, since the resumed session may belong to a different day or device entirely. */
export interface EntryResumePayload {
  projectId: string
  direction: string
  ascendingDescending: EntrySessionDirection | null
  startingStation: number
}

export const DEFAULT_ENTRY_SESSION: EntrySessionState = {
  direction: null,
  lastStation: null,
  activeSegmentId: null,
  blocked: false,
  blockMessage: null,
}

const STORAGE_PREFIX = 'novacore:entry-session:'
const ENTRY_SESSION_CHANGED_EVENT = 'novacore:entry-session-changed'

function storageKey(activity: string, projectId: string, direction: string): string {
  return `${STORAGE_PREFIX}${activity}:${projectId}:${direction}`
}

export function getEntrySession(activity: string, projectId: string, direction: string): EntrySessionState {
  const raw = localStorage.getItem(storageKey(activity, projectId, direction))
  if (!raw) return DEFAULT_ENTRY_SESSION
  try {
    return { ...DEFAULT_ENTRY_SESSION, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_ENTRY_SESSION
  }
}

export function setEntrySession(
  activity: string,
  projectId: string,
  direction: string,
  state: EntrySessionState,
): void {
  localStorage.setItem(storageKey(activity, projectId, direction), JSON.stringify(state))
  window.dispatchEvent(new Event(ENTRY_SESSION_CHANGED_EVENT))
}

export function clearEntrySession(activity: string, projectId: string, direction: string): void {
  localStorage.removeItem(storageKey(activity, projectId, direction))
  window.dispatchEvent(new Event(ENTRY_SESSION_CHANGED_EVENT))
}

export { ENTRY_SESSION_CHANGED_EVENT }
