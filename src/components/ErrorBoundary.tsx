import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-phase errors from a bad synced reading (e.g. two devices
 * both assigning the same station_sequence before either had seen the
 * other's data — see src/lib/sync/widthReadingsSync.ts) so one malformed
 * row can't blank the whole screen for a crew member in the field. Shows a
 * recoverable message instead of the default React unmount-to-blank
 * behavior; does not attempt to fix the underlying data.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto my-8 max-w-md rounded-xl border-2 border-nc-danger-text bg-nc-danger-bg p-6 text-center">
          <p className="mb-2 text-lg font-bold text-nc-danger-text">Something went wrong loading this screen.</p>
          <p className="mb-4 break-words text-sm text-nc-danger-text">{this.state.error.message}</p>
          <div className="flex justify-center gap-4">
            <button
              type="button"
              className="min-h-11 rounded-lg border-none bg-nc-danger-text px-4 py-2 text-sm font-semibold text-white"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            {/* "/" — the index route — not "/home", which doesn't exist in
                this app's routing (a stale link from the archived
                Milling/Paving build this screen was ported from). */}
            <a href="/" className="inline-flex min-h-11 items-center rounded-lg border-2 border-nc-danger-text px-4 py-2 text-sm font-semibold text-nc-danger-text no-underline">
              Go to Home
            </a>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
