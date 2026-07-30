# Novacore

Keywest Asphalt Project 26754-0000 — field data tracker (rebuild).

Vite + React + TypeScript, offline-first via Dexie (IndexedDB) and a PWA service worker,
backed by Supabase. Capacitor is wired in for future native iOS/Android builds.

## Setup

```
npm install
cp .env.example .env.local   # fill in Supabase URL + anon key
npm run dev
```

## Testing the RLS wall

Copy `scripts/.env.probe.example` to `.env.probe` and fill in the four seat passwords, then run `./scripts/probe-rls.sh`. Re-run it after any migration that touches a policy or a trigger on `daily_entries` — it exits non-zero on any failure.

## Stack

- `vite-plugin-pwa` — installable, offline-capable (service worker + manifest)
- `dexie` — local offline queue (IndexedDB)
- `@supabase/supabase-js` — client configured in `src/lib/supabase/client.ts`
- `@capacitor/core` + `@capacitor/cli` — native shell scaffolding for later, not built yet

## Structure

```
src/
  lib/
    calculations/  # pure business-logic functions, unit-testable, no UI deps
    supabase/      # Supabase client + typed query functions
  screens/         # UI screens
  components/      # shared UI components
```

The pre-rebuild prototype lives in `archive/prototype-2026/` for reference.
