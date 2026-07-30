import { useEffect, useState } from 'react'
import { fetchActiveCrewMembers, type ActiveCrewMember } from '../lib/supabase/crewMembers'
import { setCurrentProfile } from '../lib/profile'
import { useCurrentProfile } from '../lib/useCurrentProfile'
import './ProfileSelector.css'

/**
 * TEMPORARY UNAUTHENTICATED FALLBACK — see
 * supabase/migrations/20260707110000_fallback_identity.sql.
 *
 * Lets the device "claim" an identity from the list of active crew
 * members — no password, no verification. This is self-asserted, not
 * real login, and is clearly labeled as such. Persists in localStorage
 * across reloads on this device until switched or cleared. Real auth
 * (Google OAuth) will supersede this once it ships.
 *
 * Collapsed to a small single-line summary by default once a profile is
 * set — the full warning + Switch control is still exactly one tap away;
 * nothing about it is removed, just its constant on-screen footprint.
 * There's nothing meaningful to collapse when no profile is set yet (the
 * picker itself has to stay visible), so that state always shows in full.
 *
 * `interactive=false` (set by AppShell during Milling's live entry step —
 * see entrySessionActive.ts) collapses this to plain, non-interactive
 * text unconditionally, regardless of any expanded/switching state left
 * over from before it flipped — switching identity mid-session on the
 * same device has no legitimate use.
 */
export function ProfileSelector({ interactive = true }: { interactive?: boolean }) {
  const profile = useCurrentProfile()
  const [crewMembers, setCrewMembers] = useState<ActiveCrewMember[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    fetchActiveCrewMembers()
      .then(setCrewMembers)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load crew members.'))
  }, [])

  function handleConfirm() {
    const chosen = crewMembers.find((c) => c.id === selectedId)
    if (!chosen) return
    setCurrentProfile(chosen)
    setSwitching(false)
    setSelectedId('')
    setExpanded(false)
  }

  // Also the outside-tap-to-close handler once a backdrop wraps the
  // expanded panel below — collapsing never touches `profile` itself,
  // only this component's own local UI state.
  function handleCancel() {
    setSwitching(false)
    setExpanded(false)
  }

  if (!interactive) {
    return (
      <div className="profile-selector-collapsed">
        <span className="profile-selector-summary profile-selector-summary-static">
          {profile ? `${profile.name} (${profile.role})` : 'Not signed in'}
        </span>
      </div>
    )
  }

  const showPicker = !profile || switching

  if (!showPicker && !expanded) {
    return (
      <div className="profile-selector-collapsed">
        <button type="button" className="profile-selector-summary" onClick={() => setExpanded(true)}>
          <span>
            {profile.name} ({profile.role})
          </span>
          <span className="profile-selector-chevron" aria-hidden="true">
            ▾
          </span>
        </button>
      </div>
    )
  }

  const panel = (
    <div className="profile-selector" onClick={(e) => e.stopPropagation()}>
      {!showPicker && (
        <button
          type="button"
          className="profile-selector-collapse"
          onClick={() => setExpanded(false)}
          aria-label="Collapse"
        >
          ▴
        </button>
      )}

      <div className="profile-selector-warning">⚠ Unverified identity — not real login</div>

      {!showPicker && profile && (
        <div className="profile-selector-current">
          <span>
            Acting as <strong>{profile.name}</strong> ({profile.role})
          </span>
          <button type="button" onClick={() => setSwitching(true)}>
            Switch
          </button>
        </div>
      )}

      {showPicker && (
        <div className="profile-selector-picker">
          <label>
            <span>Who are you?</span>
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              <option value="">Select your name…</option>
              {crewMembers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.role})
                </option>
              ))}
            </select>
          </label>
          {loadError && <p className="profile-selector-error">{loadError}</p>}
          <div className="profile-selector-actions">
            {profile && (
              <button type="button" onClick={handleCancel}>
                Cancel
              </button>
            )}
            <button type="button" onClick={handleConfirm} disabled={!selectedId}>
              Confirm
            </button>
          </div>
        </div>
      )}
    </div>
  )

  // Only dismissible by tapping outside once there's a valid collapsed
  // state to fall back to — first-run "who are you" (no profile yet) has
  // nothing to cancel back to, so it stays exactly as it always has:
  // plain inline content, no backdrop, not dismissible.
  if (!profile) return panel

  return (
    <div className="profile-selector-backdrop" onClick={handleCancel}>
      {panel}
    </div>
  )
}
