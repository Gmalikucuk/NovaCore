import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AppShell } from './shell/AppShell'
import { SignInScreen } from './screens/SignIn/SignInScreen'
import { EntryScreen } from './screens/Entry/EntryScreen'

// Dashboard reads are §8 step 5 of the v1 build order — a separate brief,
// not part of the field entry path. Only sign-in and the entry screen exist
// so far.
function App() {
  return (
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
