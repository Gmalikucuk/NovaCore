import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { classifyApplicationRateBand } from '../../lib/calculations/applicationRateBand'
import {
  findStrictlyInsideCoverage,
  isStationWithinCoverage,
  mergeIntervals,
  type Interval,
} from '../../lib/calculations/intervalCoverage'
import { findMilledWidthReference } from '../../lib/calculations/milledWidthReference'
import { calculateSegments, cumulativeArea, cumulativeAreaToStation } from '../../lib/calculations/segmentArea'
import { resolveSegmentForStation } from '../../lib/calculations/segmentResolution'
import { daysAgo, formatDayLabel, todayLocalDateString } from '../../lib/dateFormat'
import { db, type QueuedTruckTicket, type QueuedWidthReading } from '../../lib/db'
import { setEntrySessionActive } from '../../lib/entrySessionActive'
import { getEntrySession, type EntrySessionDirection, type EntryResumePayload } from '../../lib/entrySession'
import {
  fetchCurrentCrewMember,
  fetchFullStationCoverageIntervals,
  fetchMillingReferenceReadings,
  fetchProjectSegmentCandidates,
  fetchStationCoverageIntervals,
  type CurrentCrewMember,
  type MillingReferenceReading,
  type SegmentCandidate,
} from '../../lib/supabase/milling'
import { fetchProjectApplicationRateConfig, type ProjectApplicationRateConfig } from '../../lib/supabase/projectConfig'
import {
  enqueueWidthReading,
  importServerReadings,
  registerSyncListeners,
} from '../../lib/sync/widthReadingsSync'
import { useLiveQuery } from '../../lib/sync/useLiveQuery'
import { useCurrentProfile } from '../../lib/useCurrentProfile'
import { useCurrentProject } from '../../lib/useCurrentProject'
import { useEntrySession } from '../../lib/useEntrySession'
import { TruckTicketForm } from '../../components/TruckTicketForm'
import { CorrectionForm } from '../MillingEntry/CorrectionForm'
// No new base layout CSS — this screen intentionally reuses Milling's
// setup/entry styling verbatim (same .milling-* classes throughout), same
// "one consistent visual language across activities" reasoning ExtraAreaForm/
// PhotoCaptureForm already use. Only the milled-width reference line is new
// (see PavingEntryScreen.css).
import '../MillingEntry/MillingEntryScreen.css'
import './PavingEntryScreen.css'

const ACTIVITY = 'paving'

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

/**
 * Paving Stage 1: width entry only — truck tickets, the application-rate
 * checkpoint, and tack coat auto-derivation are later stages. Structurally
 * a close mirror of MillingEntryScreen (same setup flow, same offline
 * queue, same session/segment-resolution machinery — see that file's own
 * comments for the parts that aren't repeated here), with three real
 * differences: no ExtraAreaForm/PhotoCaptureForm (not part of Stage 1),
 * a read-only milled-width reference next to the Width field, and an
 * additional validation that a paving station must fall within MILLING's
 * own confirmed coverage — side-road paving (ExtraAreaForm, not this
 * station walk) is exempt from that check entirely since it never reaches
 * this form.
 */
export function PavingEntryScreen() {
  // crewMember comes from a REAL Supabase Auth session, if one exists (it
  // won't, until Google OAuth ships). profile is the claimed/unverified
  // fallback. Real auth wins whenever both are present, mirroring the
  // server's effective_crew_member_id() priority exactly.
  const [crewMember, setCrewMember] = useState<CurrentCrewMember | null>(null)
  const [crewMemberError, setCrewMemberError] = useState<string | null>(null)
  const profile = useCurrentProfile()

  const displayName = crewMember?.name ?? profile?.name ?? null
  const hasIdentity = crewMember !== null || profile !== null

  // A "Continue from here" tap on MillingHomeScreen (shared by Paving, see
  // that component) navigates here with this payload in router state.
  const location = useLocation()
  const [pendingResume] = useState<EntryResumePayload | null>(
    () => (location.state as { resume?: EntryResumePayload } | null)?.resume ?? null,
  )

  // No Project field here either — same reasoning as Milling's setup
  // screen: it's app-wide context (currentProject.ts / the header's
  // ProjectSelector), already validated against this crew member's
  // assignment before this screen ever mounts.
  const currentProject = useCurrentProject()
  const selectedProjectId = currentProject?.id ?? ''

  const [segmentCandidates, setSegmentCandidates] = useState<SegmentCandidate[]>([])
  const [selectedDirection, setSelectedDirection] = useState('')

  const availableDirections = useMemo(
    () => [...new Set(segmentCandidates.map((c) => c.direction))],
    [segmentCandidates],
  )

  const [setupDirection, setSetupDirection] = useState<EntrySessionDirection | null>(null)
  const [setupStartingStation, setSetupStartingStation] = useState('')
  const [workDate, setWorkDate] = useState(() => todayLocalDateString())

  const projectDirectionChosen = selectedProjectId !== '' && selectedDirection !== ''
  const startingStationValue = Number(setupStartingStation)
  const ready =
    projectDirectionChosen &&
    setupDirection !== null &&
    setupStartingStation.trim() !== '' &&
    Number.isFinite(startingStationValue) &&
    workDate.trim() !== ''

  const [entryStarted, setEntryStarted] = useState(false)

  const [loadingReadings, setLoadingReadings] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [stationInput, setStationInput] = useState('')
  const [widthInput, setWidthInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const { session, update: updateSession, clear: clearSession } = useEntrySession(
    ACTIVITY,
    selectedProjectId || null,
    selectedDirection || null,
  )

  const activeSegment = segmentCandidates.find((c) => c.id === session.activeSegmentId) ?? null

  const showEntry = entryStarted

  const [historicalIntervals, setHistoricalIntervals] = useState<Interval[]>([])
  const [coverageError, setCoverageError] = useState<string | null>(null)

  // Milling's own confirmed coverage AND reference readings, prefetched for
  // every candidate segment (not just the currently active one) as soon as
  // the project's segments load — keyed by road_segment_id. Prefetching all
  // of them up front, rather than fetching per active segment on demand,
  // is what lets both the coverage check and the reference display resolve
  // instantly from whatever station is currently TYPED (see
  // liveResolvedSegment below), not just from session.activeSegmentId —
  // which stays null until the first reading actually gets submitted, and
  // "when a paving station is entered/proposed" (the reference display's
  // own spec) means before that first submission too, not only after.
  const [millingCoverageBySegment, setMillingCoverageBySegment] = useState<Map<string, Interval[]>>(new Map())
  const [millingReferenceBySegment, setMillingReferenceBySegment] = useState<Map<string, MillingReferenceReading[]>>(
    new Map(),
  )

  const [correctingEntry, setCorrectingEntry] = useState<QueuedWidthReading | null>(null)

  useEffect(() => {
    registerSyncListeners()
  }, [])

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

  useEffect(() => {
    if (!pendingResume) return
    if (selectedProjectId !== pendingResume.projectId) return
    if (!(availableDirections as string[]).includes(pendingResume.direction)) return
    setSelectedDirection(pendingResume.direction)
  }, [pendingResume, selectedProjectId, availableDirections])

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

  useEffect(() => {
    setHistoricalIntervals([])
    setCoverageError(null)
    if (!session.activeSegmentId) return
    fetchStationCoverageIntervals(ACTIVITY, session.activeSegmentId, workDate)
      .then(setHistoricalIntervals)
      .catch((err) => setCoverageError(extractErrorMessage(err, 'Failed to load station coverage.')))
  }, [session.activeSegmentId, workDate])

  useEffect(() => {
    setMillingCoverageBySegment(new Map())
    setMillingReferenceBySegment(new Map())
    if (segmentCandidates.length === 0) return
    let cancelled = false
    Promise.all(
      segmentCandidates.map(async (c) => {
        const [coverage, reference] = await Promise.all([
          fetchFullStationCoverageIntervals('milling', c.id).catch(() => [] as Interval[]),
          fetchMillingReferenceReadings(c.id).catch(() => [] as MillingReferenceReading[]),
        ])
        return { id: c.id, coverage, reference }
      }),
    ).then((results) => {
      if (cancelled) return
      setMillingCoverageBySegment(new Map(results.map((r) => [r.id, r.coverage])))
      setMillingReferenceBySegment(new Map(results.map((r) => [r.id, r.reference])))
    })
    return () => {
      cancelled = true
    }
  }, [segmentCandidates])

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
            .filter((r) => r.activity === ACTIVITY && r.date === workDate)
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

  const activeEntries = useMemo(
    () => sortedEntries.filter((r) => r.supersededBy === null && !r.isVoided),
    [sortedEntries],
  )

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

  // Resolved live from whatever's currently typed in Station — not just
  // session.activeSegmentId, which stays null until a reading actually
  // gets submitted once. Falls back to activeSegmentId as
  // resolveSegmentForStation's own "prefer the currently active one"
  // hint, same as handleSubmit's own resolution.
  const liveResolvedSegment = useMemo(() => {
    const stationValue = Number(stationInput)
    if (!Number.isFinite(stationValue) || !selectedDirection) return null
    const directionCandidates = segmentCandidates.filter((c) => c.direction === selectedDirection)
    return resolveSegmentForStation(stationValue, directionCandidates, session.activeSegmentId)
  }, [stationInput, selectedDirection, segmentCandidates, session.activeSegmentId])

  // The milled width "at" the currently-typed station, per the session's
  // declared direction of travel — updates live as the crew types, before
  // submitting. Purely informational (see milledWidthReference.ts) — never
  // feeds into the actual width value or any validation.
  const milledWidthReference = useMemo(() => {
    const stationValue = Number(stationInput)
    if (!Number.isFinite(stationValue) || !session.direction || !liveResolvedSegment) return null
    const readings = millingReferenceBySegment.get(liveResolvedSegment.id) ?? []
    return findMilledWidthReference(stationValue, session.direction, readings)
  }, [stationInput, session.direction, liveResolvedSegment, millingReferenceBySegment])

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

  // Stage 3: live application-rate checkpoint. Never hardcode a target rate
  // or band thresholds — always read them from project_config, since they
  // vary per project (see fetchProjectApplicationRateConfig).
  const [projectConfig, setProjectConfig] = useState<ProjectApplicationRateConfig | null>(null)

  useEffect(() => {
    setProjectConfig(null)
    if (!selectedProjectId) return
    let cancelled = false
    fetchProjectApplicationRateConfig(selectedProjectId)
      .then((config) => {
        if (!cancelled) setProjectConfig(config)
      })
      .catch(() => {
        if (!cancelled) setProjectConfig(null)
      })
    return () => {
      cancelled = true
    }
  }, [selectedProjectId])

  // Independent live query from the same truck_tickets local queue
  // TruckTicketForm itself reads — same "one local table is the whole
  // source of truth" reactivity TruckTicketForm already relies on, just
  // scoped here to a running session total rather than a per-row list.
  const sessionTruckTickets = useLiveQuery(
    () =>
      session.activeSegmentId
        ? db.truckTicketsQueue
            .where('roadSegmentId')
            .equals(session.activeSegmentId)
            .filter((t) => t.date === workDate)
            .toArray()
        : Promise.resolve([]),
    [session.activeSegmentId, workDate],
    [] as QueuedTruckTicket[],
  )

  const sessionTotalTonnage = useMemo(
    () =>
      sessionTruckTickets
        .filter((t) => t.supersededBy === null && !t.isVoided && t.liftType === 'top_lift')
        .reduce((sum, t) => sum + t.netTonnage, 0),
    [sessionTruckTickets],
  )

  const [checkpointStationInput, setCheckpointStationInput] = useState('')
  const checkpointStationValue = Number(checkpointStationInput)
  const checkpointStationValid = checkpointStationInput.trim() !== '' && Number.isFinite(checkpointStationValue)

  // Purely a real-time self-monitoring approximation for the crew — it
  // assumes tonnage logged so far in the session went toward paving up to
  // roughly this checkpoint station. The authoritative per-truck
  // attribution (which segment/station range each individual truck's load
  // actually covers) is a separate, later concern — see truckDistribution.ts.
  const checkpointArea = useMemo(() => {
    if (!checkpointStationValid) return null
    return cumulativeAreaToStation(liveSegments, checkpointStationValue)
  }, [checkpointStationValid, checkpointStationValue, liveSegments])

  const checkpointRatePct = useMemo(() => {
    if (checkpointArea === null || checkpointArea <= 0 || !projectConfig) return null
    return ((sessionTotalTonnage * 1000) / checkpointArea / projectConfig.targetRateKgM2) * 100
  }, [checkpointArea, sessionTotalTonnage, projectConfig])

  const checkpointBand = useMemo(() => {
    if (checkpointRatePct === null || !projectConfig) return null
    return classifyApplicationRateBand(checkpointRatePct, projectConfig)
  }, [checkpointRatePct, projectConfig])

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

    const directionCandidates = segmentCandidates.filter((c) => c.direction === selectedDirection)
    const resolved = resolveSegmentForStation(stationValue, directionCandidates, session.activeSegmentId)
    if (!resolved) {
      setFormError(
        `Station ${stationValue} m doesn't fall within any known segment for this project (${selectedDirection}).`,
      )
      return
    }

    let coverageForCheck = mergedCoverage
    if (resolved.id !== session.activeSegmentId) {
      try {
        coverageForCheck = mergeIntervals(await fetchStationCoverageIntervals(ACTIVITY, resolved.id, workDate))
      } catch {
        coverageForCheck = []
      }
    }

    // Milling coverage is prefetched for every candidate segment (see the
    // effect above), so this is a direct lookup, not a fresh fetch —
    // unlike coverageForCheck above, which is genuinely workDate-scoped
    // and can't be prefetched the same way. Paving-specific: reject any
    // station milling hasn't confirmed yet for this segment+direction.
    // Side-road paving never reaches this check — it goes through
    // ExtraAreaForm, not this station walk.
    const millingCoverageForCheck = mergeIntervals(millingCoverageBySegment.get(resolved.id) ?? [])
    if (!isStationWithinCoverage(stationValue, millingCoverageForCheck)) {
      setFormError(
        `Station ${stationValue} m hasn't been milled yet for this segment — paving can't proceed ahead of milling.`,
      )
      return
    }

    // Paving's own no-double-entry check — same rule Milling applies to
    // itself, scoped to activity='paving' throughout.
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
      await enqueueWidthReading({
        activity: ACTIVITY,
        roadSegmentId: resolved.id,
        direction: selectedDirection,
        date: workDate,
        station: stationValue,
        width: widthValue,
      })

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

  function handleChangeProjectDirection() {
    setEntryStarted(false)
  }

  return (
    <div className="milling-screen">
      <header className="milling-header">
        <h1>Paving Entry</h1>
        <div className="milling-user">
          {crewMemberError && <span className="milling-user-error">{crewMemberError}</span>}
          {!crewMemberError && !displayName && <span className="milling-user-error">Not signed in</span>}
        </div>
      </header>

      {!showEntry && !currentProject && (
        <p className="milling-identity-required">No project selected — choose one from the header to continue.</p>
      )}
      {!showEntry && currentProject && (
        <>
          <section className="milling-selectors">
            <label className="milling-field">
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
                const clamped = value > todayLocalDateString() ? todayLocalDateString() : value
                setWorkDate(clamped)
              }}
            />
          </label>

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

      {showEntry && (
        <>
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

          {(activeSegment || (hasIdentity && !session.blocked && session.direction !== null)) && (
            <section className="paving-checkpoint">
              <label className="paving-checkpoint-field">
                <span>Check application rate at station</span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={checkpointStationInput}
                  onChange={(e) => setCheckpointStationInput(e.target.value)}
                  placeholder="e.g. 29500"
                />
              </label>

              {checkpointStationValid && (
                <div className="paving-checkpoint-result">
                  <div className="paving-checkpoint-result-row">
                    <span>Cumulative area to station</span>
                    <strong>{(checkpointArea ?? 0).toFixed(2)} m²</strong>
                  </div>
                  <div className="paving-checkpoint-result-row">
                    <span>Application rate</span>
                    {!projectConfig ? (
                      <strong className="paving-checkpoint-rate paving-checkpoint-rate-unavailable">
                        Target rate not configured for this project
                      </strong>
                    ) : checkpointRatePct === null ? (
                      <strong className="paving-checkpoint-rate paving-checkpoint-rate-unavailable">No area paved yet</strong>
                    ) : (
                      <strong className={'paving-checkpoint-rate paving-checkpoint-rate-' + (checkpointBand ?? 'unavailable')}>
                        {checkpointRatePct.toFixed(1)}%
                      </strong>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {hasIdentity && session.blocked && (
            <div className="milling-session-blocked">
              <p className="milling-session-blocked-message">{session.blockMessage}</p>
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

              {/* Purely a reference — the field person can enter whatever
                  real width they measured, this never validates or
                  constrains the Width input above. */}
              <p className="paving-milled-reference">
                Milled width here: {milledWidthReference !== null ? `${milledWidthReference.toFixed(2)} m` : '—'}
              </p>

              {formError && <p className="milling-error">{formError}</p>}

              <button type="submit" className="milling-submit" disabled={submitting}>
                {submitting ? 'Saving…' : 'Add Reading'}
              </button>
            </form>
          )}

          {(activeSegment || (hasIdentity && !session.blocked && session.direction !== null)) && (
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
          )}

          {activeSegment && (
            <TruckTicketForm
              roadSegmentId={activeSegment.id}
              direction={selectedDirection}
              date={workDate}
              hasIdentity={hasIdentity}
            />
          )}
          {!activeSegment && hasIdentity && !session.blocked && session.direction !== null && (
            <p className="paving-truck-ticket-hint">Log a width reading first to start logging truck tickets for this segment.</p>
          )}
        </>
      )}

      {correctingEntry && (
        <CorrectionForm entry={correctingEntry} onClose={() => setCorrectingEntry(null)} />
      )}
    </div>
  )
}
