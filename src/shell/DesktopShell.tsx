import { NavLink, Outlet, useOutletContext } from 'react-router-dom'
import type { MyContract } from '../lib/supabase/contracts'
import './DesktopShell.css'

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'desktop-nav-link desktop-nav-link-active' : 'desktop-nav-link'
}

/**
 * Nav shell for the office screens (items, rates, daily entry,
 * dashboard) — deliberately separate from AppShell's own header. The mobile
 * field-capture route stays mounted directly under AppShell with no nav bar
 * at all (see App.tsx); nothing here touches it.
 *
 * Each link is gated on the specific right that screen needs, per 0008 —
 * no bundled "isPm" check standing in for all three. Items needs
 * create_items (nothing useful there without it — the screen would be
 * a bare read-only catalog). Rates needs view_rates alone: with it but
 * without set_cost/set_unit_price, the screen is reachable and reads the
 * rates read-only (see RatesScreen). Daily Entry needs enter_quantity OR
 * correct_quantity — either one reaches it, with the unavailable half of
 * the form disabled inside (see QuantityRecordsScreen). Dashboard is never
 * gated here: it's reachable by every contract member, and the finance
 * columns/analysis gate on view_rates inside the screen itself.
 */
export function DesktopShell() {
  const contract = useOutletContext<MyContract>()

  return (
    <div className="desktop-shell">
      <nav className="desktop-nav" aria-label="Office">
        {contract.createItems && (
          <NavLink to="/line-items" className={navLinkClass}>
            Items
          </NavLink>
        )}
        {contract.viewRates && (
          <NavLink to="/rates" className={navLinkClass}>
            Rates
          </NavLink>
        )}
        {(contract.enterQuantity || contract.correctQuantity) && (
          <NavLink to="/daily-entry" className={navLinkClass}>
            Daily Entry
          </NavLink>
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
        <Outlet context={contract} />
      </div>
    </div>
  )
}
