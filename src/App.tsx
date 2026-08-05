import { Outlet, BrowserRouter, Navigate, Route, Routes, useOutletContext } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { AuthGate } from './shell/AuthGate'
import { CompanyShell } from './shell/CompanyShell'
import { Sidebar } from './shell/Sidebar'
import { FieldHeader } from './shell/FieldHeader'
import type { CurrentContractState } from './lib/useCurrentContract'
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

/**
 * Overview now lives at the company level (CompanyShell), but its own
 * internals are unchanged and still expect a single resolved MyContract
 * via outlet context — the same shape Sidebar always handed it. This is
 * the whole difference: CompanyShell's Outlet carries the full
 * CurrentContractState (Portfolio and Tenders both need the contracts
 * list), so this bridge sits between CompanyShell and OverviewScreen and
 * resolves it down to `current`, exactly what Sidebar used to hand it
 * directly. No multi-project selection here — see the nav-restructure
 * report for what that would take.
 */
function CompanyOverviewBridge() {
  const contractState = useOutletContext<CurrentContractState>()
  if (!contractState.current) return null
  return <Outlet context={contractState.current} />
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
