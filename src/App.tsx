import { useState } from 'react'
import { Outlet, BrowserRouter, Navigate, Route, Routes, useOutletContext } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { AuthGate } from './shell/AuthGate'
import { CompanyShell } from './shell/CompanyShell'
import { Sidebar } from './shell/Sidebar'
import { FieldHeader } from './shell/FieldHeader'
import type { CurrentContractState } from './lib/useCurrentContract'
import { Button } from './components/ui'
import { SignInScreen } from './screens/SignIn/SignInScreen'
import { EntryScreen } from './screens/Entry/EntryScreen'
import { PortfolioScreen } from './screens/Portfolio/PortfolioScreen'
import { TendersScreen } from './screens/Tenders/TendersScreen'
import { ItemsScreen } from './screens/Items/ItemsScreen'
import { RatesScreen } from './screens/Rates/RatesScreen'
import { CostBuildScreen } from './screens/CostBuild/CostBuildScreen'
import { QuantityRecordsScreen } from './screens/QuantityRecords/QuantityRecordsScreen'
import { OverviewScreen } from './screens/Overview/OverviewScreen'
import { FinanceMonthScreen } from './screens/Finance/FinanceMonthScreen'
import { ConfirmQueueScreen } from './screens/Confirm/ConfirmQueueScreen'
import { TrackerScreen } from './screens/Tracker/TrackerScreen'
import { TrackerItemScreen } from './screens/Tracker/TrackerItemScreen'
import { CreateContractScreen } from './screens/Admin/CreateContractScreen'
import { SeatMembersScreen } from './screens/Admin/SeatMembersScreen'

/**
 * Overview now lives at the company level (CompanyShell), but its own
 * internals are unchanged and still expect a single resolved MyContract
 * via outlet context — the same shape Sidebar always handed it. CompanyShell's
 * Outlet carries the full CurrentContractState (Portfolio and Tenders both
 * need the contracts list), so this bridge sits between CompanyShell and
 * OverviewScreen and resolves it down to `current`, exactly what Sidebar
 * used to hand it directly.
 *
 * It's also the ONLY place left that can change which contract that is,
 * now that opening a contract from Portfolio lands on Tracker (project
 * level) instead — without this, `current` would only ever change as a
 * side effect of a Portfolio row click made for an unrelated reason, with
 * no way to switch contracts from Overview itself. The picker is a row
 * list (Portfolio's own shape: name/number + sandbox tag), not the old
 * sidebar `<select>` — deliberately, per the report this replaces. Hidden
 * entirely with one contract: nothing to switch to.
 *
 * Still single-select — this is the fix for "no path exists," not the
 * separate, larger multi-project Overview piece already reported on.
 */
function CompanyOverviewBridge() {
  const contractState = useOutletContext<CurrentContractState>()
  const { contracts, current, setCurrentId } = contractState
  const [pickerOpen, setPickerOpen] = useState(false)
  if (!current) return null

  return (
    <div>
      {contracts.length > 1 && (
        <div className="mb-4">
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={() => setPickerOpen((v) => !v)}>
              {pickerOpen ? 'Cancel' : 'Switch contract'}
            </Button>
          </div>
          {pickerOpen && (
            <div className="mt-2 divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
              {contracts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setCurrentId(c.id)
                    setPickerOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-nc-secondary ${c.id === current.id ? 'bg-nc-secondary' : ''}`}
                >
                  <span className="truncate font-medium text-nc-text">{c.contractNo ? `${c.contractNo} — ${c.name}` : c.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {c.isSandbox && <span className="rounded-full bg-nc-danger-bg px-2 py-0.5 text-xs font-medium text-nc-danger-text">Sandbox</span>}
                    {c.id === current.id && <span className="text-xs text-nc-text-muted">Current</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Outlet context={current} />
    </div>
  )
}

function App() {
  return (
    <>
      {/* vite.config.ts sets injectRegister: false — this is the ONLY
          place the service worker is registered (via useRegisterSW inside
          PwaUpdatePrompt). Outside the router, once, so it's active
          regardless of route — an app that never registers a service
          worker has nothing to serve offline, no matter how correct the
          Dexie/sync layer is. */}
      <PwaUpdatePrompt />
      <BrowserRouter>
        <Routes>
          <Route path="/sign-in" element={<SignInScreen />} />
          <Route element={<AuthGate />}>
            {/* FieldHeader owns the "office viewport never lands here"
                redirect internally (capability-detected, not viewport-width
                — see FieldHeader.tsx) — no separate IndexRoute needed. */}
            <Route element={<FieldHeader />}>
              <Route
                index
                element={
                  <ErrorBoundary>
                    <EntryScreen />
                  </ErrorBoundary>
                }
              />
            </Route>
            {/* Company level — spans every contract: the portfolio, the
                top-management Overview, and pre-award (Tenders). */}
            <Route element={<CompanyShell />}>
              <Route
                path="/portfolio"
                element={
                  <ErrorBoundary>
                    <PortfolioScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/tenders"
                element={
                  <ErrorBoundary>
                    <TendersScreen />
                  </ErrorBoundary>
                }
              />
              {/* Admin — contract creation and member seating. Both screens
                  gate themselves on their own specific company-wide right
                  (create_projects / manage_members respectively); the
                  routes themselves aren't gated a second time here. */}
              <Route
                path="/admin/contracts/new"
                element={
                  <ErrorBoundary>
                    <CreateContractScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/admin/members"
                element={
                  <ErrorBoundary>
                    <SeatMembersScreen />
                  </ErrorBoundary>
                }
              />
              {/* See CompanyOverviewBridge's own comment. */}
              <Route element={<CompanyOverviewBridge />}>
                <Route
                  path="/overview"
                  element={
                    <ErrorBoundary>
                      <OverviewScreen />
                    </ErrorBoundary>
                  }
                />
              </Route>
            </Route>
            {/* Project level — one contract at a time, reached by opening a
                project from Portfolio. "Projects" is this workspace's nav
                label (see Sidebar's own comment); the data underneath is
                still a Contract, unrenamed. */}
            <Route element={<Sidebar />}>
              <Route
                path="/line-items"
                element={
                  <ErrorBoundary>
                    <ItemsScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/rates"
                element={
                  <ErrorBoundary>
                    <RatesScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/cost-build"
                element={
                  <ErrorBoundary>
                    <CostBuildScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/daily-entry"
                element={
                  <ErrorBoundary>
                    <QuantityRecordsScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/confirm"
                element={
                  <ErrorBoundary>
                    <ConfirmQueueScreen />
                  </ErrorBoundary>
                }
              />
              {/* Reached only by opening a month row on Overview's Finance
                  tab — no nav link of its own, same convention as the
                  Tracker's own ?itemId=&period= deep link into
                  /daily-entry. Stays at project level even though Overview
                  (its only entry point) moved up a level — see the
                  nav-restructure report for why. */}
              <Route
                path="/finance/:period"
                element={
                  <ErrorBoundary>
                    <FinanceMonthScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/tracker"
                element={
                  <ErrorBoundary>
                    <TrackerScreen />
                  </ErrorBoundary>
                }
              />
              {/* The "records" step of contract → Item → its records —
                  reached only by opening an Item # on the Tracker list, same
                  convention as /finance/:period. */}
              <Route
                path="/tracker/:itemId"
                element={
                  <ErrorBoundary>
                    <TrackerItemScreen />
                  </ErrorBoundary>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </>
  )
}

export default App
