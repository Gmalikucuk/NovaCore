import { useState } from 'react'
import { setCurrentProject } from '../lib/currentProject'
import type { ProjectOption } from '../lib/supabase/milling'
import { useCurrentProject } from '../lib/useCurrentProject'
import './ProjectSelector.css'

/**
 * Always-visible current-project indicator, next to the profile pill.
 * Project context is meant to be a deliberate, infrequent choice ("projects
 * act in their own habitat"), not a per-screen dropdown — so unlike
 * ProfileSelector this has no warning banner or "switching" distinction,
 * just a small pill that expands into a picker on an explicit tap and
 * collapses again once a project is confirmed. Every project-scoped screen
 * (Dashboard, Tracker, Milling) reads the result via useCurrentProject
 * rather than each keeping its own picker.
 *
 * Only ever mounted for multi-project crew members (see AppShell +
 * useProjectAssignment) — `projects` is that person's assigned list, not
 * every project in the system, so the picker can't offer a project they
 * don't actually work on. Single-assignment crew members never see this
 * component at all; zero-assignment ones see a "not assigned" message
 * instead.
 */
export function ProjectSelector({ projects }: { projects: ProjectOption[] }) {
  const currentProject = useCurrentProject()
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState('')

  function handleConfirm() {
    const chosen = projects.find((p) => p.id === selectedId)
    if (!chosen) return
    setCurrentProject(chosen)
    setSelectedId('')
    setExpanded(false)
  }

  if (!expanded) {
    return (
      <button type="button" className="project-selector-summary" onClick={() => setExpanded(true)}>
        <span>{currentProject ? currentProject.contractNumber : 'No project'}</span>
        <span className="project-selector-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
    )
  }

  return (
    // Backdrop makes tapping anywhere outside the picker collapse it
    // without changing the current project — same pattern ProfileSelector
    // uses, stopPropagation on the panel itself so a tap inside doesn't
    // bubble up and immediately close it again.
    <div className="project-selector-backdrop" onClick={() => setExpanded(false)}>
      <div className="project-selector" onClick={(e) => e.stopPropagation()}>
        <label>
          <span>Project</span>
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            <option value="">Select project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.contractNumber} — {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="project-selector-actions">
          <button type="button" onClick={() => setExpanded(false)}>
            Cancel
          </button>
          <button type="button" onClick={handleConfirm} disabled={!selectedId}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
