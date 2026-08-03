import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { AppShell } from './shell/AppShell'
import { DesktopShell } from './shell/DesktopShell'
import { SignInScreen } from './screens/SignIn/SignInScreen'
import { EntryScreen } from './screens/Entry/EntryScreen'
import { ItemsScreen } from './screens/Items/ItemsScreen'
import { RatesScreen } from './screens/Rates/RatesScreen'
import { QuantityRecordsScreen } from './screens/QuantityRecords/QuantityRecordsScreen'
import { DashboardScreen } from './screens/Dashboard/DashboardScreen'
import { useIsDesktopViewport } from './lib/useIsDesktopViewport'

// The mobile field-capture route (index, "/") is built, deployed, and
// verified on a real device — it stays mounted directly under AppShell with
// no nav chrome, untouched. Everything else (§8 step 5, the desktop office
// screens) is nested under DesktopShell instead, which is where the nav bar
// lives — see DesktopShell.tsx for why the two are kept apart.
//
// A desktop viewport landing on "/" has no way out — no nav chrome exists
// there by design, so a mouse-and-keyboard user would be stuck editing the
// URL bar to reach anything else. IndexRoute exists so that never happens:
// index redirects to /dashboard (the one desktop screen every contract
// member can reach, gated on nothing) whenever the viewport is desktop-sized,
// full stop — not just on first landing, but any time "/" is rendered,
// including a direct link or a resize mid-session. A real mobile viewport
// still gets EntryScreen exactly as before.
function IndexRoute() {
  const isDesktop = useIsDesktopViewport()
  if (isDesktop) return <Navigate to="/dashboard" replace />
  return (
    <ErrorBoundary>
      <EntryScreen />
    </ErrorBoundary>
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
          <Route element={<AppShell />}>
            <Route index element={<IndexRoute />} />
            <Route element={<DesktopShell />}>
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
                path="/daily-entry"
                element={
                  <ErrorBoundary>
                    <QuantityRecordsScreen />
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
