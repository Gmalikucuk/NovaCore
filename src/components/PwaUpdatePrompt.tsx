import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/**
 * A field app that stays open all day is exactly the case a stale PWA
 * service-worker cache bites hardest — silently working against old code
 * until someone happens to hard-refresh. registerType is 'prompt', not
 * 'autoUpdate' (see vite.config.ts), specifically so a new service worker
 * waits for this instead of taking over in the background on its own.
 *
 * Renders nothing until needRefresh flips true. Tapping the banner calls
 * updateServiceWorker(), which sends the waiting worker a skip-waiting
 * message — the actual reload is handled by the controllerchange listener
 * below, not by the library's own internal reload wiring. That internal
 * path (workbox-window's 'controlling' event) only reloads when its
 * isUpdate flag is true, and that flag is captured once, at this page's
 * original service-worker registration — Boolean(navigator.serviceWorker.
 * controller) at that exact moment. If this tab happened to be the one
 * that registered the very first service worker (no controller existed
 * yet), isUpdate is permanently false for the rest of this tab's session,
 * silently skipping the reload on every later update. Confirmed live: a
 * tab that started with no prior service worker correctly showed this
 * banner on a later deploy, but tapping it never reloaded until this
 * listener was added. navigator.serviceWorker.oncontrollerchange is the
 * unconditional, standard signal instead — it fires whenever control
 * actually changes hands, regardless of that stale flag.
 */
const UPDATE_CHECK_INTERVAL_MS = 60 * 1000

export function PwaUpdatePrompt() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      registrationRef.current = registration
      // The browser only re-checks a service worker's script on its own at
      // the next full navigation — an idle open tab (exactly what a field
      // app does all day) would otherwise never discover a new version
      // without this explicit poll.
      setInterval(() => {
        registration.update()
      }, UPDATE_CHECK_INTERVAL_MS)
    },
  })

  useEffect(() => {
    // The other half of the "don't sit on stale code" fix, alongside the
    // shortened interval above: the common case is a tab left open in the
    // background all day, then brought back to the front — worth an
    // immediate check rather than waiting up to a full interval for it.
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        void registrationRef.current?.update()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    let reloaded = false
    function handleControllerChange() {
      if (reloaded) return
      reloaded = true
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange)
  }, [])

  if (!needRefresh) return null

  return (
    // Normal document flow, not fixed/overlaid — sits above whichever shell
    // (Sidebar or FieldHeader) is currently mounted, shrink-0 so it never
    // gets squeezed by a flex ancestor.
    <div className="box-border flex shrink-0 items-center justify-between gap-3 bg-nc-navy text-white">
      <button type="button" className="flex-1 px-4 py-2.5 text-left text-sm font-bold text-nc-accent" onClick={() => updateServiceWorker()}>
        Update available — tap to reload
      </button>
      <button type="button" aria-label="Dismiss" className="min-h-11 min-w-11 shrink-0 px-4 py-2 text-base text-white" onClick={() => setNeedRefresh(false)}>
        ✕
      </button>
    </div>
  )
}
