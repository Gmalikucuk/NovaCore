// Whether a live data-entry session (step 2 of an entry screen — e.g.
// Milling's Station/Width form — not its setup step) is currently showing.
// AppShell reads this to decide whether ProfileSelector should offer
// switching: identity-switching mid-session on the same device serves no
// purpose (see AppShell's comment) and shouldn't be offered, but AppShell
// has no other way to know which step an entry screen's own local state is
// on, since Outlet doesn't let a descendant hand state back up to it.
//
// Deliberately NOT the localStorage+event pattern profile.ts/
// currentProject.ts use — those represent real persisted choices worth
// surviving a reload; this is transient per-mount UI state (a reload
// always drops back to a screen's own initial step), so an in-memory
// module variable is the honest fit, not localStorage.
let active = false
const EVENT = 'novacore:entry-session-active-changed'

export function isEntrySessionActive(): boolean {
  return active
}

export function setEntrySessionActive(value: boolean): void {
  if (active === value) return
  active = value
  window.dispatchEvent(new Event(EVENT))
}

export { EVENT as ENTRY_SESSION_ACTIVE_CHANGED_EVENT }
