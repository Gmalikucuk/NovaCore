import { NavLink, Outlet, useOutletContext } from 'react-router-dom'
import type { MyProject } from '../lib/supabase/projects'
import './DesktopShell.css'

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'desktop-nav-link desktop-nav-link-active' : 'desktop-nav-link'
}

/**
 * Nav shell for the office screens (line items, rates, daily entry,
 * dashboard) — deliberately separate from AppShell's own header. The mobile
 * field-capture route stays mounted directly under AppShell with no nav bar
 * at all (see App.tsx); nothing here touches it.
 *
 * Line Items/Rates/Daily Entry are PM-only work screens (RLS write grants
 * are project_manager-only — see 0002) and are gated out of the nav for
 * other roles rather than shown as dead links. Dashboard is not gated: spec
 * §5 explicitly designs a quantities-only reading for every role, field
 * included, so it stays reachable — the column-level gating happens inside
 * that screen, not at the nav.
 */
export function DesktopShell() {
  const project = useOutletContext<MyProject>()
  const isPm = project.role === 'project_manager'

  return (
    <div className="desktop-shell">
      <nav className="desktop-nav" aria-label="Office">
        {isPm && (
          <>
            <NavLink to="/line-items" className={navLinkClass}>
              Line Items
            </NavLink>
            <NavLink to="/rates" className={navLinkClass}>
              Rates
            </NavLink>
            <NavLink to="/daily-entry" className={navLinkClass}>
              Daily Entry
            </NavLink>
          </>
        )}
        <NavLink to="/dashboard" className={navLinkClass}>
          Dashboard
        </NavLink>
      </nav>
      {/* Below the breakpoint: a one-line explanation instead of a squeezed
          layout nobody asked for (see the desktop-brief's own instruction
          on this). Both render always; CSS picks one. */}
      <p className="desktop-shell-too-narrow">This screen is built for a desktop monitor — open it on a larger screen.</p>
      <div className="desktop-shell-content">
        <Outlet context={project} />
      </div>
    </div>
  )
}
