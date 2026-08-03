import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { AuthGate } from './shell/AuthGate'
import { Sidebar } from './shell/Sidebar'
import { FieldHeader } from './shell/FieldHeader'
import { SignInScreen } from './screens/SignIn/SignInScreen'
import { EntryScreen } from './screens/Entry/EntryScreen'
import { ItemsScreen } from './screens/Items/ItemsScreen'
import { RatesScreen } from './screens/Rates/RatesScreen'
import { QuantityRecordsScreen } from './screens/QuantityRecords/QuantityRecordsScreen'
import { OverviewScreen } from './screens/Overview/OverviewScreen'
import { ConfirmQueueScreen } from './screens/Confirm/ConfirmQueueScreen'
import { TrackerScreen } from './screens/Tracker/TrackerScreen'

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
              <Route
                path="/overview"
                element={
                  <ErrorBoundary>
                    <OverviewScreen />
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
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </>
  )
}

export default App
