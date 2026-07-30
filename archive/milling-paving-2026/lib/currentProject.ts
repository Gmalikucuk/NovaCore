// Persisted "current project" — the project context every project-scoped
// screen (Dashboard, Tracker, Milling, and eventually History) reads from,
// so picking a project is a deliberate, infrequent action taken once (then
// remembered across screens and reloads) rather than a per-screen, per-
// session dropdown. Same localStorage-key + custom-event + hook shape as
// profile.ts/useCurrentProfile.ts, but unlike that one this isn't a stand-in
// for something real auth will replace — project context is orthogonal to
// who's logged in, and will still be needed once real login exists.

const STORAGE_KEY = 'novacore:current-project'
const PROJECT_CHANGED_EVENT = 'novacore:project-changed'

export interface CurrentProject {
  id: string
  contractNumber: string
  name: string
}

export function getCurrentProject(): CurrentProject | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CurrentProject
  } catch {
    return null
  }
}

export function getCurrentProjectId(): string | null {
  return getCurrentProject()?.id ?? null
}

export function setCurrentProject(project: CurrentProject): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
  window.dispatchEvent(new Event(PROJECT_CHANGED_EVENT))
}

export function clearCurrentProject(): void {
  localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new Event(PROJECT_CHANGED_EVENT))
}

export { PROJECT_CHANGED_EVENT }
