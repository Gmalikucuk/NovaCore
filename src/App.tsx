import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { AppShell } from './shell/AppShell'
import { DesktopShell } from './shell/DesktopShell'
import { SignInScreen } from './screens/SignIn/SignInScreen'
import { EntryScreen } from './screens/Entry/EntryScreen'
import { LineItemsScreen } from './screens/LineItems/LineItemsScreen'
import { RatesScreen } from './screens/Rates/RatesScreen'
import { DailyEntryScreen } from './screens/DailyEntry/DailyEntryScreen'
import { DashboardScreen } from './screens/Dashboard/DashboardScreen'

// The mobile field-capture route (index, "/") is built, deployed, and
// verified on a real device — it stays mounted directly under AppShell with
// no nav chrome, untouched. Everything else (§8 step 5, the desktop office
// screens) is nested under DesktopShell instead, which is where the nav bar
// lives — see DesktopShell.tsx for why the two are kept apart.
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
          <Route element={<AppShell />}>
            <Route
              index
              element={
                <ErrorBoundary>
                  <EntryScreen />
                </ErrorBoundary>
              }
            />
            <Route element={<DesktopShell />}>
              <Route
                path="/line-items"
                element={
                  <ErrorBoundary>
                    <LineItemsScreen />
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
                path="/daily-entry"
                element={
                  <ErrorBoundary>
                    <DailyEntryScreen />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <ErrorBoundary>
                    <DashboardScreen />
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
