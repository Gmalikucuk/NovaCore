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

Copy `scripts/.env.probe.example` to `.env.probe` and fill in the five fixture passwords, then run `./scripts/probe-rls.sh`. **Run it after every migration, not just ones that look like they touch a policy** — 0008's rights rewrite renamed roles to rights, 0009/0011 renamed tables and rights, and none of the three were re-verified against this suite at the time beyond a manual, one-off check. The suite itself sat unrun from 0008 through 0012 and a full design-system pass (five migrations) because `.env.probe` had gone stale — the fixture accounts' passwords were rotated in a separate deploy commit, the file was never updated to match, and a missing/wrong env var just makes GoTrue's sign-in call fail, which reads like "something's misconfigured," not "the suite didn't run." The suite now validates its own env (see below) so a stale file fails loudly and immediately instead of silently never running. It exits non-zero on any failure.

**Creating a test fixture user by hand** (as opposed to real signup): inserting directly into `auth.users` needs `email_change` set to `''`, not left `null`. A `null` there makes GoTrue's `/auth/v1/token` endpoint fail with an opaque `500 "Database error querying schema"` — no mention of `email_change` anywhere in the error, so it reads like a broken database rather than one malformed column on one row. Found while creating the `probe-correct-only` fixture for 0008's probe suite; model any new row's non-secret columns after an existing working user's (`select row_to_json(u) from auth.users u where email = '...'`) rather than guessing which columns GoTrue actually requires.

**`CREATE OR REPLACE FUNCTION` cannot rename a parameter.** Changing an existing function's body while keeping its name and argument *types* the same does not require a preceding `DROP FUNCTION` — except renaming one of the parameters, which Postgres rejects outright: `ERROR: cannot change name of input parameter "p_x" (SQLSTATE 42P13)`, regardless of what depends on the function. Found while writing 0009's table-rename migration, trying to rename `is_member`/`has_right`'s `p_project` parameter to `p_contract` for readability alongside the table rename. The fix is either keep the old parameter name (it's internal to the function body, invisible to every caller since all call sites pass arguments positionally) or accept a real `DROP FUNCTION` — which then reintroduces the dependency-ordering hazard below, since a dropped function fails if anything still references it.

**`DROP FUNCTION` fails if any live RLS policy still calls it (`SQLSTATE 2BP01`).** A function being dropped and recreated under a new name (or retired) must have every dependent policy dropped *first* — dropping the function while policies still reference it fails outright, it does not cascade or silently orphan them. Hit twice: 0008's `member_role()`/`can_see_finance()` retirement, and 0009's first draft of `is_member`/`has_right` (see above). Both times the failed `db push` rolled back transactionally with zero schema change — verified each time by re-listing tables/policies/functions immediately after the failure, not assumed. The reliable order is: drop dependent policies, then drop (or replace) the function, then recreate the policies.

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
