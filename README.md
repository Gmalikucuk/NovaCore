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

**A seed script's own upserted columns are not safe to correct in the database alone.** `seed_hwy5_contract.sql`'s Items `insert` is `on conflict (contract_id, item_number) do update` on six columns — description, unit, approximate_quantity, item_kind, provisional_sum, dfpa_category. A fix applied directly to the database (by hand, or via a future admin UI) for any of those six, on any Item, is silently reverted the next time this file is rerun for any reason — including a rerun with nothing to do with that Item, e.g. picking up an unrelated new column from a later migration. The seed file's own hardcoded `values (...)` list is the actual source of truth for those six columns on Hwy 5, not the live database. Found auditing Hwy 5's 48 seeded Items against the real Schedule 7 tender document (04.06.05's Job assignment and 04.07.02's deliberate typo correction) — the fix belongs in the `.sql` source first, same file, same commit as whatever prompted it.

## Verifying against real data

**Live verification that writes anything runs against the sandbox contract, never a real one.** Hwy 97C Pennask Summit Resurfacing (`26914-0000`, `contracts.is_sandbox = true`) exists for exactly this — entirely fictional, seeded and re-seeded idempotently by `seed_demo_contract.sql`, safe to write to, confirm, and rerun against freely. Every other contract — Hwy 5 Snowshed Hill included — is **read-only for verification purposes**: look, click through, inspect, but don't submit a form, confirm a record, or otherwise write, on a real contract while checking that a feature works, even when it'll be reverted afterward.

The reason is structural, not a matter of care. `quantity_records` is append-only once a row is confirmed (0021/0022) — there is no un-confirm, by design. A mistaken write to a real contract can't be undone, only superseded, and the correction leaves permanent history describing work nobody actually did. `scripts/probe-rls.sh` already gets the discovery half of this right: it finds its target project via `is_sandbox = true`, never a hardcoded contract id, precisely so a probe run can't land a row on a real contract by accident. Extend the same discipline to manual/agent-driven browser verification, which has no such built-in guard.

Where a check genuinely can't be done on the sandbox — a rights regression tied to one specific real seat, for instance — say so *before* running it, not after.

**If a verification write ever does land on a real contract, `created_by` resolving to a `@novacore.test` address is the durable marker for finding it again** — not the note text, and not `device_id`. A note only tells you something if whoever wrote it thought to say so in words a later reader would recognize as fabricated (found the hard way on Hwy 5: a confirmed record read "Corrected by superintendent — simulating race," which is only obvious in hindsight). `device_id` is a single value persisted per browser (`src/lib/deviceId.ts`), so it repeats across whichever seat is signed in on that browser at the time — it can make two different people's rows look like the same device, but its mere presence proves nothing about whether a row is real. `created_by` is the one field a test row can't fake without an actual `@keywestasphalt.com` (or other real) account behind it.

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
