import { useEffect, useState } from 'react'
import { clearCurrentProject, getCurrentProjectId, setCurrentProject } from './currentProject'
import { fetchAssignedProjects } from './supabase/crewMemberProjects'
import type { ProjectOption } from './supabase/milling'

export type ProjectAssignment =
  | { status: 'loading' }
  | { status: 'single'; project: ProjectOption }
  | { status: 'multi'; projects: ProjectOption[] }
  | { status: 'none' }
  | { status: 'error'; message: string }

/**
 * Resolves how many projects a crew member is assigned to (crew_member_projects)
 * and reconciles useCurrentProject accordingly. This is a visibility/UX
 * restriction, not a security boundary — see the migration comment; RLS
 * still governs what's actually allowed regardless of which project is
 * "current".
 *
 * - Exactly one assignment: current project is forced to it every time this
 *   resolves, so the header never offers a switch — matches real
 *   field-crew practice (they're on one site).
 * - More than one: left entirely to ProjectSelector's own manual pick,
 *   except a stale current project that isn't in this crew member's
 *   assigned list (e.g. left over from a previously-claimed identity) gets
 *   cleared rather than silently pointing at a project they're not even
 *   assigned to.
 * - Zero: current project is cleared too, for the same reason — the caller
 *   shows a "not assigned" state instead of an empty picker.
 */
export function useProjectAssignment(crewMemberId: string | null): ProjectAssignment {
  const [assignment, setAssignment] = useState<ProjectAssignment>({ status: 'loading' })

  useEffect(() => {
    if (!crewMemberId) {
      setAssignment({ status: 'loading' })
      return
    }
    let cancelled = false
    setAssignment({ status: 'loading' })
    fetchAssignedProjects(crewMemberId)
      .then((projects) => {
        if (cancelled) return
        if (projects.length === 0) {
          clearCurrentProject()
          setAssignment({ status: 'none' })
        } else if (projects.length === 1) {
          setCurrentProject(projects[0])
          setAssignment({ status: 'single', project: projects[0] })
        } else {
          if (!projects.some((p) => p.id === getCurrentProjectId())) {
            clearCurrentProject()
          }
          setAssignment({ status: 'multi', projects })
        }
      })
      .catch((err) => {
        if (cancelled) return
        setAssignment({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load project assignment.' })
      })
    return () => {
      cancelled = true
    }
  }, [crewMemberId])

  return assignment
}
