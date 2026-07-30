import { useEffect, useState } from 'react'
import { fetchMyProjects, type MyProject } from './supabase/projects'

const STORAGE_KEY = 'novacore_current_project_id'

export interface CurrentProjectState {
  status: 'loading' | 'none' | 'ready' | 'error'
  projects: MyProject[]
  current: MyProject | null
  setCurrentId: (id: string) => void
  message?: string
}

/**
 * The signed-in user's projects, plus which one is "current" — persisted so
 * a reload doesn't lose the choice. Auto-selects when there's exactly one
 * (the common case for a field seat), matching the archived build's
 * single-assignment auto-select behavior; a multi-project person keeps an
 * explicit choice.
 */
export function useCurrentProject(): CurrentProjectState {
  const [projects, setProjects] = useState<MyProject[]>([])
  const [status, setStatus] = useState<'loading' | 'none' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | undefined>()
  const [currentId, setCurrentIdState] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY))

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    fetchMyProjects()
      .then((list) => {
        if (cancelled) return
        setProjects(list)
        if (list.length === 0) {
          setStatus('none')
          return
        }
        setStatus('ready')
        setCurrentIdState((prev) => {
          if (prev && list.some((p) => p.id === prev)) return prev
          const fallback = list[0].id
          localStorage.setItem(STORAGE_KEY, fallback)
          return fallback
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus('error')
        setMessage(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function setCurrentId(id: string) {
    localStorage.setItem(STORAGE_KEY, id)
    setCurrentIdState(id)
  }

  const current = projects.find((p) => p.id === currentId) ?? null

  return { status, projects, current, setCurrentId, message }
}
