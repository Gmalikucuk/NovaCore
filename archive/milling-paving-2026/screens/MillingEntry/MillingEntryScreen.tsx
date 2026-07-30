import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ExtraAreaForm } from '../../components/ExtraAreaForm'
import { PhotoCaptureForm } from '../../components/PhotoCaptureForm'
import { findStrictlyInsideCoverage, mergeIntervals, type Interval } from '../../lib/calculations/intervalCoverage'
import { calculateSegments, cumulativeArea } from '../../lib/calculations/segmentArea'
import { resolveSegmentForStation } from '../../lib/calculations/segmentResolution'
import { daysAgo, formatDayLabel, todayLocalDateString } from '../../lib/dateFormat'
import { db, type QueuedWidthReading } from '../../lib/db'
import { setEntrySessionActive } from '../../lib/entrySessionActive'
import { getEntrySession, type EntrySessionDirection, type EntryResumePayload } from '../../lib/entrySession'
import {
  fetchCurrentCrewMember,
  fetchProjectSegmentCandidates,
  fetchStationCoverageIntervals,
  type CurrentCrewMember,
  type SegmentCandidate,
} from '../../lib/supabase/milling'
import {
  enqueueWidthReading,
  importServerReadings,
  registerSyncListeners,
} from '../../lib/sync/widthReadingsSync'
import { useLiveQuery } from '../../lib/sync/useLiveQuery'
import { useCurrentProfile } from '../../lib/useCurrentProfile'
import { useCurrentProject } from '../../lib/useCurrentProject'
import { useEntrySession } from '../../lib/useEntrySession'
import { CorrectionForm } from './CorrectionForm'
import './MillingEntryScreen.css'

const ACTIVITY = 'milling'

// Supabase/PostgREST errors are plain objects with a `message` property, not
// actual Error instances — `instanceof Error` misses them and would hide the
// real reason behind a generic fallback string.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

/**
 * Uniform for both a clean multiple-of-50 last station and an irregular
 * one — floor/ceil to the next full 50 in the declared direction, not a
 * simple +/-50, so an irregular reading (e.g. 28,537) still proposes a
 * clean round number (28,550) rather than another irregular one.
 */
function computeNextStation(lastStation: number, direction: EntrySessionDirection): number {
  return direction === 'ascending'
    ? (Math.floor(lastStation / 50) + 1) * 50
    : (Math.ceil(lastStation / 50) - 1) * 50
}

export function MillingEntryScreen() {
  // crewMember comes from a REAL Supabase Auth session, if one exists (it
  // won't, until Google OAuth ships — this stays here so the header
  // automatically starts showing the verified identity the moment a real
  // session does exist, with no UI change needed). profile is the
  // claimed/unverified fallback. Real auth wins whenever both are present,
  // mirroring the server's effective_crew_member_id() priority exactly.
  const [crewMember, setCrewMember] = useState<CurrentCrewMember | null>(null)
  const [crewMemberError, setCrewMemberError] = useState<string | null>(null)
  const profile = useCurrentProfile()

  const displayName = crewMember?.name ?? profile?.name ?? null
  const hasIdentity = crewMember !== null || profile !== null

  // A "Continue from here" tap on MillingHomeScreen navigates here with this
  // payload in router state — captured once via the lazy useState
  // initializer (not re-read on later re-renders/navigations within this
  // same mount) since it's a one-shot hydration of the setup screen, not a
  // live binding to browser history state.
  const location = useLocation()
  const [pendingResume] = useState<EntryResumePayload | null>(
    () => (location.state as { resume?: EntryResumePayload } | null)?.resume ?? null,
  )

  // There is no Project field on this screen anymore — it's purely
  // app-wide context now (see currentProject.ts / the header's
  // ProjectSelector), already validated/reconciled against this crew
  // member's assignment by AppShell's useProjectAssignment before this
  // screen ever mounts, so nothing here needs its own copy of that
  // validation. selectedProjectId is just a convenience alias for
  // everywhere below that already reads it by that name (segment
  // fetching, useEntrySession's key, PhotoCaptureForm's prop, etc.) — a
  // resume payload is never a different project than currentProject in
  // practice, since MillingHomeScreen's own "Previous Days" list is
  // already scoped to currentProject, so there's nothing to reconcile
  // between the two here.
  const currentProject = useCurrentProject()
  const selectedProjectId = currentProject?.id ?? ''

  // Segment is no longer manually picked — every road_segment for the
  // project is fetched once, and segmentResolution.ts resolves which one a
  // typed station belongs to. Direction (NB/SB/etc) is still explicit: it's
  // a real physical-road distinction, not something a station number alone
  // can imply, and multiple segment groups can share a direction.
  const [segmentCandidates, setSegmentCandidates] = useState<SegmentCandidate[]>([])
  const [selectedDirection, setSelectedDirection] = useState('')

  const availableDirections = useMemo(
    () => [...new Set(segmentCandidates.map((c) => c.direction))],
    [segmentCandidates],
  )

  // Ascending/descending (direction of travel) and the starting station are
  // both decided on the setup screen, alongside Project + Direction (NB/SB)
  // — all four before "Begin Entry". Starting station is never computed or
  // defaulted here (see the pre-fill effect below for why) — the crew
  // always sees and explicitly confirms it, since the mechanical "next
  // round 50" isn't always right (segment-cut exceptions).
  const [setupDirection, setSetupDirection] = useState<EntrySessionDirection | null>(null)
  const [setupStartingStation, setSetupStartingStation] = useState('')

  // The entry's real work date — what groups it into a day's totals and
  // drives mill-to-pave deadline calculations — kept entirely separate
  // from the server-side entry_timestamp (always the true moment of
  // entry, set by the DB's own now() default; the client never sends a
  // value for it, here or anywhere else, so nothing about this field can
  // ever touch it). Defaults to today regardless of whether this setup is
  // fresh or a "Continue from here" resume — resuming is about picking up
  // a station/direction/project thread, not necessarily re-dating new
  // readings to match whatever day the resumed session originally used;
  // someone backfilling that same older day can still set this manually.
  const [workDate, setWorkDate] = useState(() => todayLocalDateString())

  const projectDirectionChosen = selectedProjectId !== '' && selectedDirection !== ''
  const startingStationValue = Number(setupStartingStation)
  const ready =
    projectDirectionChosen &&
    setupDirection !== null &&
    setupStartingStation.trim() !== '' &&
    Number.isFinite(startingStationValue) &&
    workDate.trim() !== ''

  // Two-step flow: setup (Project + Direction + ascending/descending +
  // starting station) then entry. showEntry is true ONLY after the explicit
  // "Begin Entry" tap — a persisted session with an already-declared
  // direction does NOT skip setup anymore; it just pre-fills setup's fields
  // (see the effect below) so confirming it again is fast, not skipped.
  const [entryStarted, setEntryStarted] = useState(false)

  const [loadingReadings, setLoadingReadings] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [stationInput, setStationInput] = useState('')
  const [widthInput, setWidthInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Persisted to localStorage (see entrySession.ts) keyed by activity +
  // project + direction — survives navigating away and back, closing and
  // reopening the tab, and going offline/online. Only cleared by the
  // explicit "End session" action (handleEndSession/clearSession below),
  // never by navigation, app restart, or a connectivity change. The active
  // segment (auto-resolved from the station) lives inside this session
  // state too, since it can change mid-session as the walk crosses a
  // segment boundary.
  const { session, update: updateSession, clear: clearSession } = useEntrySession(
    ACTIVITY,
    selectedProjectId || null,
    selectedDirection || null,
  )

  const activeSegment = segmentCandidates.find((c) => c.id === session.activeSegmentId) ?? null

  const showEntry = entryStarted

  // [lo, hi] per prior day with active readings on the active segment —
  // merged with the work date's own live interval (from activeEntries,
  // below) to check new stations against. Excludes the work date itself
  // since that comes from the live local queue instead, which reflects
  // not-yet-synced entries this server fetch wouldn't have yet.
  const [historicalIntervals, setHistoricalIntervals] = useState<Interval[]>([])
  const [coverageError, setCoverageError] = useState<string | null>(null)

  const [correctingEntry, setCorrectingEntry] = useState<QueuedWidthReading | null>(null)

  useEffect(() => {
    registerSyncListeners()
  }, [])

  // Tells AppShell's ProfileSelector when the live entry step (not setup)
  // is showing, so it can go non-interactive — see entrySessionActive.ts
  // for why this needs a shared flag rather than a prop. Cleanup covers
  // both leaving showEntry and navigating away from this screen entirely.
  useEffect(() => {
    setEntrySessionActive(showEntry)
    return () => setEntrySessionActive(false)
  }, [showEntry])

  useEffect(() => {
    fetchCurrentCrewMember()
      .then(setCrewMember)
      .catch((err) => setCrewMemberError(extractErrorMessage(err, 'Failed to load crew member.')))
  }, [])

  useEffect(() => {
    setSelectedDirection('')
    setSegmentCandidates([])
    if (!selectedProjectId) return
    fetchProjectSegmentCandidates(selectedProjectId).then(setSegmentCandidates)
  }, [selectedProjectId])

  // Applies a pending resume's Direction (NB/SB) once the project's segment
  // candidates have loaded and actually offer it — the select's options
  // don't exist yet on the same tick selectedProjectId is first set from
  // pendingResume, so this can't just be folded into that initial state.
  useEffect(() => {
    if (!pendingResume) return
    if (selectedProjectId !== pendingResume.projectId) return
    if (!(availableDirections as string[]).includes(pendingResume.direction)) return
    setSelectedDirection(pendingResume.direction)
  }, [pendingResume, selectedProjectId, availableDirections])

  // Every project/direction (re)selection pre-fills the SETUP screen's own
  // fields (ascending/descending, starting station) from that combination's
  // persisted session, if one exists — never the entry screen directly,
  // since step 2 is only ever reached via the explicit Begin Entry tap now
  // (no auto-skip). Starting station pre-fills with the session's raw
  // lastStation (where it left off), not a computed "next" proposal — the
  // crew reviews and can edit it before confirming, since the mechanical
  // next-round-50 guess isn't always right (segment-cut exceptions). Reads
  // storage directly via getEntrySession rather than through `session` so
  // it can't race the hook's own change effect (both fire off this same
  // selectedDirection change).
  //
  // A pendingResume matching the current Project+Direction wins over the
  // persisted local session — it's an explicit "continue this specific past
  // session" request, which may be a different session than whatever this
  // device last has stored locally for that combination (or there may be
  // nothing stored locally at all, e.g. a different device recorded it).
  // Per its own fallback rule (see sessionThreads.ts), an unresolvable
  // ascending/descending on the resumed session is left unset here too,
  // rather than guessed — the crew confirms it explicitly instead.
  useEffect(() => {
    setFormError(null)
    setWidthInput('')
    setSetupDirection(null)
    setSetupStartingStation('')

    if (!selectedProjectId || !selectedDirection) return

    if (pendingResume && pendingResume.projectId === selectedProjectId && pendingResume.direction === selectedDirection) {
      if (pendingResume.ascendingDescending) setSetupDirection(pendingResume.ascendingDescending)
      setSetupStartingStation(String(pendingResume.startingStation))
      return
    }

    const persisted = getEntrySession(ACTIVITY, selectedProjectId, selectedDirection)
    if (persisted.direction) setSetupDirection(persisted.direction)
    if (persisted.lastStation !== null) setSetupStartingStation(String(persisted.lastStation))
  }, [selectedProjectId, selectedDirection, pendingResume])

  // Whenever the resolved active segment OR the selected work date changes
  // (including a mid-session crossing into a different segment, or editing
  // the date back on the setup screen) — reload historical coverage for
  // that (segment, date) combination.
  useEffect(() => {
    setHistoricalIntervals([])
    setCoverageError(null)
    if (!session.activeSegmentId) return
    fetchStationCoverageIntervals(ACTIVITY, session.activeSegmentId, workDate)
      .then(setHistoricalIntervals)
      .catch((err) => setCoverageError(extractErrorMessage(err, 'Failed to load station coverage.')))
  }, [session.activeSegmentId, workDate])

  // Pull the work date's server-confirmed rows into the local queue table.
  // After this, the running list reads entirely from Dexie (via
  // useLiveQuery below) — server rows and locally-queued rows live in the
  // same local table, so there's nothing to reconcile between "the fetched
  // list" and "the queue".
  useEffect(() => {
    if (!session.activeSegmentId) return
    setLoadingReadings(true)
    setLoadError(null)
    importServerReadings(ACTIVITY, session.activeSegmentId, workDate)
      .catch((err) => setLoadError(extractErrorMessage(err, 'Failed to load entries.')))
      .finally(() => setLoadingReadings(false))
  }, [session.activeSegmentId, workDate])

  const allEntries = useLiveQuery(
    () =>
      session.activeSegmentId
        ? db.widthReadingsQueue
            .where('roadSegmentId')
            .equals(session.activeSegmentId)
            .filter((r) => r.date === workDate)
            .toArray()
        : Promise.resolve([]),
    [session.activeSegmentId, workDate],
    [] as QueuedWidthReading[],
  )

  const sortedEntries = useMemo(
    () =>
      [...allEntries].sort((a, b) =>
        a.stationSequence !== b.stationSequence
          ? a.stationSequence - b.stationSequence
          : a.createdAt - b.createdAt,
      ),
    [allEntries],
  )

  // Superseded readings (their own superseded_by is set, pointing at the
  // correction that replaced them) are excluded from the live calculation —
  // the correction row itself is what's authoritative. Voided readings are
  // excluded too — same reasoning, same bug class TruckTicketForm had until
  // this local queue never carried isVoided at all.
  const activeEntries = useMemo(
    () => sortedEntries.filter((r) => r.supersededBy === null && !r.isVoided),
    [sortedEntries],
  )

  // The work date's own coverage, computed live from the local queue
  // rather than fetched — always reflects not-yet-synced entries, unlike
  // historicalIntervals (a one-time server fetch per active-segment/work-
  // date change).
  const workDateCoverageInterval = useMemo<Interval | null>(() => {
    if (activeEntries.length === 0) return null
    const stations = activeEntries.map((r) => r.station)
    return { lo: Math.min(...stations), hi: Math.max(...stations) }
  }, [activeEntries])

  const mergedCoverage = useMemo(
    () =>
      mergeIntervals(
        workDateCoverageInterval ? [...historicalIntervals, workDateCoverageInterval] : historicalIntervals,
      ),
    [historicalIntervals, workDateCoverageInterval],
  )

  const liveSegments = useMemo(() => {
    if (activeEntries.length < 2) return []
    return calculateSegments(
      activeEntries.map((r) => ({
        stationSequence: r.stationSequence,
        station: r.station,
        width: r.width,
      })),
    )
  }, [activeEntries])

  const liveTotalArea = useMemo(() => cumulativeArea(liveSegments), [liveSegments])

  const queuedCount = useMemo(() => allEntries.filter((r) => r.status === 'queued').length, [allEntries])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedProjectId || !selectedDirection || !hasIdentity || !session.direction || session.blocked) return

    const stationValue = Number(stationInput)
    const widthValue = Number(widthInput)
    if (stationInput.trim() === '' || !Number.isFinite(stationValue)) {
      setFormError('Enter a valid station.')
      return
    }
    if (widthInput.trim() === '' || !Number.isFinite(widthValue)) {
      setFormError('Enter a valid width.')
      return
    }

    // Resolved against the currently active segment first — never a blind
    // "find any segment containing this station" lookup, since two
    // unrelated segments' station ranges can numerically overlap. Only
    // considers a different candidate when the station falls outside the
    // active segment's range (a real segment-boundary crossing).
    const directionCandidates = segmentCandidates.filter((c) => c.direction === selectedDirection)
    const resolved = resolveSegmentForStation(stationValue, directionCandidates, session.activeSegmentId)
    if (!resolved) {
      setFormError(
        `Station ${stationValue} m doesn't fall within any known segment for this project (${selectedDirection}).`,
      )
      return
    }

    // Crossing into a different segment than the one currently loaded —
    // mergedCoverage still reflects the OLD segment, so fetch the new
    // segment's historical coverage fresh rather than checking against
    // stale data. (The work date's own interval for the new segment is
    // empty either way: nothing's been queued locally against it yet.)
    let coverageForCheck = mergedCoverage
    if (resolved.id !== session.activeSegmentId) {
      try {
        coverageForCheck = mergeIntervals(await fetchStationCoverageIntervals(ACTIVITY, resolved.id, workDate))
      } catch {
        coverageForCheck = []
      }
    }

    // Rejected before ever reaching the queue — landing exactly on a
    // boundary (continuing from where coverage currently ends) is fine,
    // only strictly-inside is blocked.
    const covering = findStrictlyInsideCoverage(stationValue, coverageForCheck)
    if (covering) {
      setFormError(
        `Station ${stationValue} m is already covered (${covering.lo}–${covering.hi} m already recorded). Pick a station outside this range.`,
      )
      return
    }

    setFormError(null)
    setSubmitting(true)
    try {
      // Writes to the local queue immediately (optimistic UI — it shows up
      // in the list right away tagged 'queued') and kicks off a sync
      // attempt in the background. This screen is online-only no longer:
      // if the network is down, the entry stays 'queued' and retries on
      // reconnect / app foreground (see registerSyncListeners). Who this
      // gets attributed to server-side is handled entirely by client.ts's
      // fetch wrapper (X-Claimed-Crew-Member-Id) plus real auth if it
      // exists — this screen never touches that itself.
      await enqueueWidthReading({
        activity: ACTIVITY,
        roadSegmentId: resolved.id,
        direction: selectedDirection,
        date: workDate,
        station: stationValue,
        width: widthValue,
      })

      // Direction-integrity check happens AFTER the reading is committed —
      // its value is only final once submitted, and this reading itself is
      // never rolled back. A violation only blocks further NEW entries in
      // this session until an explicit reset; it resets the persisted
      // proposal state (lastStation), not the queued/synced data.
      if (session.lastStation !== null) {
        const wentBackward = stationValue < session.lastStation
        const wentForward = stationValue > session.lastStation
        const violatesDirection =
          (session.direction === 'ascending' && wentBackward) || (session.direction === 'descending' && wentForward)

        if (violatesDirection) {
          updateSession({
            blocked: true,
            blockMessage: `Station ${stationValue} m moves ${wentBackward ? 'backward' : 'forward'} from ${session.lastStation} m — opposite the declared ${session.direction} direction. That reading has been saved as entered. No further entries are allowed until you end this session.`,
            lastStation: null,
            activeSegmentId: resolved.id,
          })
          setStationInput('')
          setWidthInput('')
          return
        }
      }

      updateSession({ lastStation: stationValue, activeSegmentId: resolved.id })
      setStationInput(String(computeNextStation(stationValue, session.direction)))
      setWidthInput('')
    } catch (err) {
      setFormError(extractErrorMessage(err, 'Failed to queue entry.'))
    } finally {
      setSubmitting(false)
    }
  }

  // The ONLY way session state (direction/last station/active segment/
  // proposal) is ever cleared — not navigation, not app close/reopen, not
  // going offline/online. Both call sites below (the voluntary "End
  // Session" link during normal entry, and the mandatory recovery button
  // after a direction violation) call this exact same function — one
  // action, two entry points, not two separate "end a session"
  // implementations. Never touches width_readings: already-submitted
  // readings are committed (or safely queued offline) independent of
  // session state, exactly as already built — this only clears the local
  // proposal-tracking, and only for this activity+project+direction (a
  // future PavingEntryScreen would call clearSession() from its own
  // useEntrySession('paving', projectId, direction) instance, same pattern,
  // entirely independent key).
  //
  // Also resets entryStarted/setupDirection/setupStartingStation/workDate
  // so this returns to the setup screen with all five choices (Project,
  // Direction, ascending/descending, starting station, date) to make
  // again — setup is the only place any of these are declared now, there's
  // no step-2 fallback. workDate resetting to today specifically matters:
  // without it, backdating one session (to catch up on a missed day) would
  // silently carry that same backdate into whatever unrelated session gets
  // started next.
  function handleEndSession() {
    clearSession()
    setStationInput('')
    setWidthInput('')
    setFormError(null)
    setEntryStarted(false)
    setSetupDirection(null)
    setSetupStartingStation('')
    setWorkDate(todayLocalDateString())
  }

  // Returns to step 1 without touching the persisted session — Project and
  // Direction stay at their current values (just re-editable), and if the
  // person comes right back to the same combination, showEntry picks the
  // resumed session back up exactly as before. Distinct from End Session,
  // which is about ending a WALK on the current project/direction, not
  // about picking a different one.
  function handleChangeProjectDirection() {
    setEntryStarted(false)
  }

  return (
    <div className="milling-screen">
      <header className="milling-header">
        <h1>Milling Entry</h1>
        {/* Who's identified is already shown in the header's identity pill
            (every route, not just this one) — this only surfaces something
            that pill doesn't: a real problem (fetch error, or genuinely no
            identity at all). */}
        <div className="milling-user">
          {crewMemberError && <span className="milling-user-error">{crewMemberError}</span>}
          {!crewMemberError && !displayName && <span className="milling-user-error">Not signed in</span>}
        </div>
      </header>

      {/* Step 1: setup. Direction (NB/SB) + ascending/descending, with a
          clear "Begin Entry" tap to move to step 2 — the transition never
          happens just by having everything filled in. Project isn't a
          field here at all: it's app-wide context (see currentProject.ts /
          the header's ProjectSelector), already shown in the header pill,
          so a second, permanently-disabled copy of it here was pure
          duplication. Gated on currentProject existing at all — there's
          nothing to fetch Direction options for otherwise. */}
      {!showEntry && !currentProject && (
        <p className="milling-identity-required">No project selected — choose one from the header to continue.</p>
      )}
      {!showEntry && currentProject && (
        <>
          <section className="milling-selectors">
            <label className="milling-field">
              {/* "Direction" deliberately, not "Lane" — Lane is reserved
                  for a real, distinct upcoming concept (Fast/Slow/Middle
                  lanes, a future project), so reusing it for NB/SB here
                  would recreate the exact ambiguity that word was meant to
                  avoid. */}
              <span>Direction</span>
              <select value={selectedDirection} onChange={(e) => setSelectedDirection(e.target.value)}>
                <option value="">Select direction…</option>
                {availableDirections.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <div className="milling-direction-prompt">
            <p className="milling-direction-prompt-label">Ascending or descending?</p>
            <div className="milling-direction-buttons">
              <button
                type="button"
                className={
                  'milling-direction-button' + (setupDirection === 'ascending' ? ' milling-direction-button-selected' : '')
                }
                onClick={() => setSetupDirection('ascending')}
              >
                <span aria-hidden="true">↑</span> Ascending
              </button>
              <button
                type="button"
                className={
                  'milling-direction-button' + (setupDirection === 'descending' ? ' milling-direction-button-selected' : '')
                }
                onClick={() => setSetupDirection('descending')}
              >
                <span aria-hidden="true">↓</span> Descending
              </button>
            </div>
          </div>

          <label className="milling-field milling-field-large">
            <span>Starting station (m)</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={setupStartingStation}
              onChange={(e) => setSetupStartingStation(e.target.value)}
              placeholder="0.00"
            />
          </label>

          <label className="milling-field">
            <span>Date</span>
            <input
              type="date"
              value={workDate}
              max={todayLocalDateString()}
              onChange={(e) => {
                const value = e.target.value
                if (!value) return
                // max on a native date input only constrains the picker
                // UI — not every browser blocks typing a future date
                // straight into the text portion, so this is a real
                // guard, not just belt-and-suspenders.
                const clamped = value > todayLocalDateString() ? todayLocalDateString() : value
                setWorkDate(clamped)
              }}
            />
          </label>

          {/* Same "may affect previously calculated totals" awareness
              already used for corrections — a backdated entry lands in a
              day's totals that may already have been reviewed. Yesterday
              doesn't trigger it (entering yesterday's data first thing
              this morning is routine, not a stale-totals concern);
              anything older does. */}
          {daysAgo(workDate) > 1 && (
            <p className="milling-correction-past-day-warning">This may affect previously calculated totals.</p>
          )}

          <div className="milling-begin-entry-row">
            <button
              type="button"
              className="milling-submit"
              disabled={!ready}
              onClick={() => {
                if (!setupDirection) return
                updateSession({ direction: setupDirection })
                setStationInput(setupStartingStation)
                setEntryStarted(true)
              }}
            >
              Begin Entry
            </button>
          </div>
        </>
      )}

      {/* Step 2: entry. Project/Direction are settled by now — shown as
          compact context instead of editable dropdowns, with an explicit
          way back to step 1 rather than a second implementation of picking
          them. */}
      {showEntry && (
        <>
          {/* Combined topbar: icon-only "back to setup" (no label — same
              learnable-icon convention as the resume icon on
              MillingHomeScreen's previous-day cards), the project/direction
              context centered, and sync state as a small dot rather than a
              full-width banner — replaces the old separate context-row +
              sync-status banner, which competed with the entry form for
              vertical space above the fold. */}
          <div className="milling-topbar">
            <button
              type="button"
              className="milling-change-context-icon"
              onClick={handleChangeProjectDirection}
              aria-label="Change Direction"
            >
              ←
            </button>
            <span className="milling-topbar-project">
              {currentProject?.contractNumber} · {selectedDirection}
              {/* Only surfaced when it's not today — the common case needs
                  no reminder, but entering against a backdated work date
                  with nothing on screen showing which date that is would
                  be an easy way to lose track mid-session. */}
              {workDate !== todayLocalDateString() && ` · ${formatDayLabel(workDate)}`}
            </span>
            <span
              className={'milling-sync-dot' + (queuedCount > 0 ? ' milling-sync-dot-pending' : ' milling-sync-dot-synced')}
              role="status"
              aria-label={queuedCount > 0 ? `${queuedCount} queued, syncing` : 'All synced'}
              title={queuedCount > 0 ? `${queuedCount} queued, syncing` : 'All synced'}
            />
          </div>

          {!hasIdentity && (
            <p className="milling-identity-required">Select who you are above to start entering readings.</p>
          )}

          {/* Total area (and reading count) pinned at the top of step 2 —
              see .milling-summary-sticky — so it's visible without
              scrolling no matter how long the running list below grows.
              Shown as soon as a session is underway, even before the first
              reading resolves a segment (a zero-entries session shows an
              explicit "nothing yet" state, not a blank gap), and stays
              visible through a direction-violation block so the crew can
              still see what's been entered while resolving it. */}
          {(activeSegment || (hasIdentity && !session.blocked && session.direction !== null)) && (
            <section className="milling-summary milling-summary-sticky">
              <div>
                <span>Total area</span>
                <strong>{liveTotalArea.toFixed(2)} m²</strong>
              </div>
              <span className="milling-summary-count">
                {activeEntries.length} reading{activeEntries.length === 1 ? '' : 's'}
              </span>
            </section>
          )}

          {hasIdentity && session.blocked && (
            <div className="milling-session-blocked">
              <p className="milling-session-blocked-message">{session.blockMessage}</p>
              {/* Mandatory recovery path — same handleEndSession as the
                  voluntary "End Session" link in the normal form below. */}
              <button type="button" className="milling-submit" onClick={handleEndSession}>
                End session and start new
              </button>
            </div>
          )}

          {hasIdentity && !session.blocked && session.direction !== null && (
            <form className="milling-form" onSubmit={handleSubmit}>
              <div className="milling-session-indicator-row">
                <span className="milling-session-indicator">
                  {session.direction === 'ascending' ? 'Ascending' : 'Descending'} session
                  {activeSegment && ` · ${activeSegment.highway} ${activeSegment.direction}`}
                </span>
                {/* Same handleEndSession as the direction-violation recovery
                    button below — this is a voluntary version of the exact
                    same action, not a second implementation of "end a
                    session". Either path clears the persisted session
                    (direction/last station/active segment/proposal) and
                    nothing else — already-submitted readings are untouched
                    either way. */}
                <button type="button" className="milling-end-session-link" onClick={handleEndSession}>
                  End
                </button>
              </div>

              {activeSegment && coverageError && <p className="milling-error">{coverageError}</p>}

              <div className="milling-field-row">
                <label className="milling-field milling-field-large">
                  <span>Station (m)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={stationInput}
                    onChange={(e) => setStationInput(e.target.value)}
                    placeholder="0.00"
                  />
                </label>

                <label className="milling-field milling-field-large">
                  <span>Width (m)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={widthInput}
                    onChange={(e) => setWidthInput(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
              </div>

              {formError && <p className="milling-error">{formError}</p>}

              <button type="submit" className="milling-submit" disabled={submitting}>
                {submitting ? 'Saving…' : 'Add Reading'}
              </button>
            </form>
          )}

          {(activeSegment || (hasIdentity && !session.blocked && session.direction !== null)) && (
            <>
              <section className="milling-list">
                {loadingReadings && <p>Loading…</p>}
                {loadError && <p className="milling-error">{loadError}</p>}
                {!loadingReadings && sortedEntries.length === 0 && <p>No entries yet for this date.</p>}
                <ul>
                  {sortedEntries.map((entry) => {
                    const isSuperseded = entry.supersededBy !== null
                    const struckThrough = isSuperseded || entry.isVoided
                    const canEdit = hasIdentity && entry.status === 'synced' && !isSuperseded
                    return (
                      <li
                        key={entry.localId}
                        className={struckThrough ? 'milling-entry-superseded' : 'milling-entry'}
                      >
                        <span className="milling-entry-station">{entry.station} m</span>
                        <span className="milling-entry-width">{entry.width} m wide</span>
                        <span className="milling-entry-status">
                          {entry.isCorrection && <span className="milling-badge milling-badge-correction">corrected</span>}
                          {isSuperseded && <span className="milling-badge milling-badge-superseded">superseded</span>}
                          {entry.isVoided && <span className="milling-badge milling-badge-voided">voided</span>}
                          {!struckThrough && (
                            <span
                              className={'milling-sync-dot' + (entry.status === 'synced' ? ' milling-sync-dot-synced' : ' milling-sync-dot-pending')}
                              role="status"
                              aria-label={entry.status === 'synced' ? 'Synced' : 'Queued, syncing'}
                              title={entry.status === 'synced' ? 'Synced' : 'Queued, syncing'}
                            />
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              className="milling-edit-button"
                              aria-label="Edit entry"
                              onClick={() => setCorrectingEntry(entry)}
                            >
                              ✏️
                            </button>
                          )}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </section>

              {activeSegment && (
                <ExtraAreaForm
                  roadSegmentId={activeSegment.id}
                  date={workDate}
                  hasIdentity={hasIdentity}
                  segmentFromStation={activeSegment.fromStation}
                  segmentToStation={activeSegment.toStation}
                />
              )}

              {selectedProjectId && (
                <PhotoCaptureForm
                  projectId={selectedProjectId}
                  workDate={workDate}
                  hasIdentity={hasIdentity}
                  sessionDirection={selectedDirection}
                />
              )}
            </>
          )}
        </>
      )}

      {correctingEntry && (
        <CorrectionForm entry={correctingEntry} onClose={() => setCorrectingEntry(null)} />
      )}
    </div>
  )
}
