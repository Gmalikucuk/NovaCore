import { useEffect, useState } from 'react'
import { getCurrentProject, PROJECT_CHANGED_EVENT, type CurrentProject } from './currentProject'

/** Reactive read of the current project — see currentProject.ts. */
export function useCurrentProject(): CurrentProject | null {
  const [project, setProject] = useState<CurrentProject | null>(getCurrentProject())

  useEffect(() => {
    const handler = () => setProject(getCurrentProject())
    window.addEventListener(PROJECT_CHANGED_EVENT, handler)
    window.addEventListener('storage', handler) // keep tabs in sync
    return () => {
      window.removeEventListener(PROJECT_CHANGED_EVENT, handler)
      window.removeEventListener('storage', handler)
    }
  }, [])

  return project
}
