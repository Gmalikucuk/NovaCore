import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ProfileSelector } from '../components/ProfileSelector'
import { ProjectSelector } from '../components/ProjectSelector'
import { PwaUpdatePrompt } from '../components/PwaUpdatePrompt'
import { useCurrentProfile } from '../lib/useCurrentProfile'
import { useCurrentProject } from '../lib/useCurrentProject'
import { useEntrySessionActive } from '../lib/useEntrySessionActive'
import { useProjectAssignment } from '../lib/useProjectAssignment'
import './AppShell.css'

// The only route where both restrictions in the header doc comment below
// apply — Milling's setup + live entry screens share this one route,
// distinguished only by MillingEntryScreen's own internal step state (see
// entrySessionActive.ts for how that reaches this component).
const DATA_ENTRY_ROUTE = '/milling/new'

// mobilePrimary marks the items shown in the mobile bottom bar — Milling
// and Paving are already reached via Home's rows, and Tracker/History are
// dense, PM-oriented table views better suited to desktop, so the mobile
// bar stays to just Home + Dashboard. Desktop's sidebar always shows every
// item regardless of this flag (see .app-nav-link-mobile-only in
// AppShell.css) — same routes, same codebase, purely a responsive
// visibility change.
const NAV_ITEMS = [
  { to: '/home', label: 'Home', mobilePrimary: true },
  { to: '/dashboard', label: 'Dashboard', mobilePrimary: true },
  { to: '/milling', label: 'Milling', mobilePrimary: false },
  { to: '/paving', label: 'Paving', mobilePrimary: false },
  { to: '/tracker', label: 'Tracker', mobilePrimary: false },
  { to: '/history', label: 'History', mobilePrimary: false },
]

/**
 * Persistent app shell: header (wordmark + identity, on every route) + nav
 * (sidebar on desktop, bottom bar on mobile) around whatever route is
 * active. Identity comes from useCurrentProfile — the claimed-identity
 * fallback, not a real Supabase Auth session — since real login doesn't
 * exist yet. No /login route: with no profile picked, the header's
 * ProfileSelector shows its own picker and the main content area shows a
 * prompt instead of nav/routes, rather than redirecting anywhere.
 *
 * ProfileSelector is mounted exactly once, here. It used to also be
 * embedded directly in MillingEntryScreen (the only screen that existed
 * before this shell); that copy is now removed — this header instance
 * covers every route, including Milling, so the duplicate was dead weight.
 *
 * ProjectSelector sits next to it — the app-wide current project (see
 * currentProject.ts), same "mounted once in the shell, every screen reads
 * it reactively" shape. Only shown once a profile exists: before that the
 * whole nav/content area is gated anyway (see the identity check below),
 * so there's nothing for a project choice to do yet.
 *
 * Which of the four project-indicator states renders is driven by
 * useProjectAssignment, keyed off the current profile's crew member id —
 * a visibility/UX restriction, not a security boundary (see the
 * crew_member_projects migration comment). Exactly one assignment: a
 * plain, non-interactive pill (no ProjectSelector at all — nothing to
 * switch between). More than one: ProjectSelector, restricted to that
 * person's assigned projects. Zero: a clear "contact your coordinator"
 * notice instead of an empty picker. Still loading/error: nothing, to
 * avoid a flash of the wrong state.
 *
 * Two further restrictions apply only on DATA_ENTRY_ROUTE (Milling's
 * setup + live entry screens), never on Dashboard/Tracker/History/Home:
 * Project always renders as the same plain pill a single-assignment
 * person gets, even for a multi-project person like Mehmet — switching
 * projects mid-entry has no legitimate use and risks attributing a
 * reading to the wrong project. Profile stays switchable through setup
 * (picking up a fresh device still starts there), but goes non-interactive
 * once the live entry step is actually showing — switching identity
 * mid-session on the same device serves no purpose; the real path for a
 * new person continuing someone else's work is Home → pick their own
 * profile → "Continue from here".
 *
 * PwaUpdatePrompt renders first, inside .app-shell itself rather than as
 * a standalone sibling above the router (where it used to live, in
 * App.tsx) — that placement put it outside .app-shell's own
 * height:100dvh flex column, so when it appeared it pushed the whole
 * shell (including the fixed-position bottom nav) taller than the
 * viewport instead of just taking a slice of it. Living inside the shell
 * now, it renders identically on every route — a real fix, not just a
 * relocation, for reliably surfacing an update regardless of which
 * screen happens to be open when one's detected.
 */
export function AppShell() {
  const profile = useCurrentProfile()
  const assignment = useProjectAssignment(profile?.id ?? null)
  const currentProject = useCurrentProject()
  const location = useLocation()
  const entrySessionActive = useEntrySessionActive()

  const onDataEntryRoute = location.pathname === DATA_ENTRY_ROUTE
  const projectSwitchable = assignment.status === 'multi' && !onDataEntryRoute
  const profileSwitchable = !(onDataEntryRoute && entrySessionActive)

  return (
    <div className="app-shell">
      <PwaUpdatePrompt />
      <header className="app-header">
        <span className="app-wordmark">NOVACORE</span>
        <div className="app-header-controls">
          {profile && projectSwitchable && <ProjectSelector projects={assignment.projects} />}
          {profile && !projectSwitchable && (assignment.status === 'single' || assignment.status === 'multi') && (
            <span className="app-project-static">
              {assignment.status === 'single' ? assignment.project.contractNumber : (currentProject?.contractNumber ?? '—')}
            </span>
          )}
          {profile && assignment.status === 'none' && (
            <span className="app-project-unassigned">Not assigned to any project — contact your coordinator</span>
          )}
          {profile && assignment.status === 'error' && (
            <span className="app-project-unassigned">{assignment.message}</span>
          )}
          <ProfileSelector interactive={profileSwitchable} />
        </div>
      </header>

      {profile ? (
        <div className="app-body">
          <nav className="app-nav">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  'app-nav-link' +
                  (item.mobilePrimary ? '' : ' app-nav-link-desktop-only') +
                  (isActive ? ' app-nav-link-active' : '')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <main className="app-main">
            <Outlet />
          </main>
        </div>
      ) : (
        <div className="app-shell-gate-content">
          <p>Select who you are above to continue.</p>
        </div>
      )}
    </div>
  )
}
