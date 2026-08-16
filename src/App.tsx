import { BrowserRouter, Navigate, Route, Routes, useOutletContext } from 'react-router-dom'
import { Outlet } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { AuthGate } from './shell/AuthGate'
import { Sidebar } from './shell/Sidebar'
import { FieldHeader } from './shell/FieldHeader'
import type { CurrentContractState } from './lib/useCurrentContract'
import { SignInScreen } from './screens/SignIn/SignInScreen'
import { EntryScreen } from './screens/Entry/EntryScreen'
import { PortfolioScreen } from './screens/Portfolio/PortfolioScreen'
import { BidsScreen } from './screens/Bids/BidsScreen'
import { OverviewScreen } from './screens/Overview/OverviewScreen'
import { ItemsScreen } from './screens/Items/ItemsScreen'
import { RatesScreen } from './screens/Rates/RatesScreen'
import { CostBuildScreen } from './screens/CostBuild/CostBuildScreen'
import { DailyReportsScreen } from './screens/DailyReports/DailyReportsScreen'
import { PaymentsScreen } from './screens/Payments/PaymentsScreen'
import { PurchaseOrdersScreen } from './screens/PurchaseOrders/PurchaseOrdersScreen'
import { QuantityRecordsScreen } from './screens/QuantityRecords/QuantityRecordsScreen'
import { ProgressScreen } from './screens/Progress/ProgressScreen'
import { MonthsScreen } from './screens/Finance/MonthsScreen'
import { FinanceMonthScreen } from './screens/Finance/FinanceMonthScreen'
import { ProgressEstimatesScreen } from './screens/Finance/ProgressEstimatesScreen'
import { ProgressEstimateScreen } from './screens/Finance/ProgressEstimateScreen'
import { ConfirmQueueScreen } from './screens/Confirm/ConfirmQueueScreen'
import { TrackerScreen } from './screens/Tracker/TrackerScreen'
import { TrackerItemScreen } from './screens/Tracker/TrackerItemScreen'
import { CreateContractScreen } from './screens/Admin/CreateContractScreen'
import { SeatMembersScreen } from './screens/Admin/SeatMembersScreen'

/**
 * Narrows the full CurrentContractState (Sidebar's own outlet context, since
 * Portfolio/Overview/Bids/Admin need the whole contracts list) down to
 * the single resolved `current` contract that every contract-scoped screen
 * (Tracker, Rates, Progress, ...) has always expected. The same narrowing
 * CompanyOverviewBridge used to do for Overview alone, now applied to every
 * route that's actually about one contract rather than the company as a
 * whole.
 */
function ContractScopeBridge() {
  const { current } = useOutletContext<CurrentContractState>()
  if (!current) return null
  return <Outlet context={current} />
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
            {/* One persistent sidebar for the whole office experience — see
                Sidebar.tsx's own comment for why the old CompanyShell/
                Sidebar split is gone. Its own Outlet carries the FULL
                CurrentContractState (Portfolio/Overview/Bids/Admin all
                need the contracts list, not one resolved contract);
                ContractScopeBridge narrows that down for the routes below
                that are actually scoped to a single contract. */}
            <Route element={<Sidebar />}>
              <Route
                path="/portfolio"
                element={
                  <ErrorBoundary>
                    <PortfolioScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/overview"
                element={
                  <ErrorBoundary>
                    <OverviewScreen />
                  </ErrorBoundary>
                }
              />
              {/* Route path unchanged — renamed Tenders -> Bids on the nav
                  side only (see BidsScreen's own comment); flagged as a
                  candidate route rename, not done in this pass. */}
              <Route
                path="/tenders"
                element={
                  <ErrorBoundary>
                    <BidsScreen />
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
              {/* Production + Finance — one contract at a time, reached by
                  opening a contract from Portfolio or Overview. */}
              <Route element={<ContractScopeBridge />}>
                <Route
                  path="/progress"
                  element={
                    <ErrorBoundary>
                      <ProgressScreen />
                    </ErrorBoundary>
                  }
                />
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
                  path="/daily-reports"
                  element={
                    <ErrorBoundary>
                      <DailyReportsScreen />
                    </ErrorBoundary>
                  }
                />
                <Route
                  path="/payments"
                  element={
                    <ErrorBoundary>
                      <PaymentsScreen />
                    </ErrorBoundary>
                  }
                />
                <Route
                  path="/purchase-orders"
                  element={
                    <ErrorBoundary>
                      <PurchaseOrdersScreen />
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
                {/* Months — the list. Reached from the Finance nav link. */}
                <Route
                  path="/finance"
                  element={
                    <ErrorBoundary>
                      <MonthsScreen />
                    </ErrorBoundary>
                  }
                />
                {/* One month's detail — reached only by opening a row on
                    Months, no nav link of its own, same convention as
                    Tracker's own deep link into /daily-entry. */}
                <Route
                  path="/finance/:period"
                  element={
                    <ErrorBoundary>
                      <FinanceMonthScreen />
                    </ErrorBoundary>
                  }
                />
                {/* Progress estimates — the list. Reached from the Finance
                    nav link. */}
                <Route
                  path="/progress-estimates"
                  element={
                    <ErrorBoundary>
                      <ProgressEstimatesScreen />
                    </ErrorBoundary>
                  }
                />
                {/* One estimate's detail — reached only by opening a row on
                    the list (or right after creating one), same convention
                    as /finance/:period. */}
                <Route
                  path="/progress-estimates/:id"
                  element={
                    <ErrorBoundary>
                      <ProgressEstimateScreen />
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
                    reached only by opening an Item # on the Tracker list,
                    same convention as /finance/:period. */}
                <Route
                  path="/tracker/:itemId"
                  element={
                    <ErrorBoundary>
                      <TrackerItemScreen />
                    </ErrorBoundary>
                  }
                />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </>
  )
}

export default App
