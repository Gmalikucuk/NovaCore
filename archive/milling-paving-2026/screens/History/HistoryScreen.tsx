// When this gets built for real (Stage 4), it should read project context
// from useCurrentProject (see src/lib/currentProject.ts) from day one, the
// same way Dashboard/Tracker/Milling do — not reinvent its own per-screen
// project handling the way Dashboard originally did (a hardcoded "whichever
// project has data" guess) before that got fixed.
export function HistoryScreen() {
  return (
    <div style={{ padding: 24, color: '#1A1A2E' }}>
      <h1 style={{ margin: '0 0 8px' }}>History</h1>
      <p style={{ margin: 0, color: '#6B7280' }}>
        No daily-report concept exists in the schema yet, so this is a coming-soon stub for now —
        lands properly in Stage 4.
      </p>
    </div>
  )
}
