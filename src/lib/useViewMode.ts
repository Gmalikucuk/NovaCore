import { useState } from 'react'

export type ViewMode = 'field' | 'office'

const STORAGE_KEY = 'novacore_view_override'

// Memoized at module scope, not recomputed per render or per component
// mount — "evaluate once at load" means once for the whole session, not
// once per remount. Guarded for non-browser environments (vitest's default
// node test environment has no `window`) so importing this module never
// crashes a test that doesn't touch it directly.
let cachedDetection: boolean | null = null

function detectIsFieldDevice(): boolean {
  if (cachedDetection === null) {
    cachedDetection = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse) and (hover: none)').matches
  }
  return cachedDetection
}

interface UseViewModeResult {
  /** The effective mode — override if set, otherwise the one-time capability detection. This is what everything else should read. */
  mode: ViewMode
  /** The raw capability detection, ignoring any override — for the footer's own label ("Switch to..."), not for gating anything. */
  detected: ViewMode
  /** Non-null if a manual override is active. */
  override: ViewMode | null
  /** Sets or clears the override. Always wins over detection when set. */
  setOverride: (mode: ViewMode | null) => void
}

/**
 * A phone reports a coarse pointer and no hover; a laptop reports fine and
 * hover at any window size — a better signal than viewport width because it
 * describes the input device, not the window, and doesn't change when the
 * window is resized or a tablet is rotated. Detected once; a manual
 * override (sidebar footer) always wins and persists across reloads.
 */
export function useViewMode(): UseViewModeResult {
  const [override, setOverrideState] = useState<ViewMode | null>(() => {
    if (typeof window === 'undefined') return null
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === 'field' || stored === 'office' ? stored : null
  })

  const detected: ViewMode = detectIsFieldDevice() ? 'field' : 'office'
  const mode = override ?? detected

  function setOverride(next: ViewMode | null) {
    if (next === null) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
    setOverrideState(next)
  }

  return { mode, detected, override, setOverride }
}
