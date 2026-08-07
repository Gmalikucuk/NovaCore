#!/usr/bin/env bash
#
# NovaCore RLS acceptance probe suite.
#
# Rewritten for 0008 (rights replace roles) — not adjusted. The old suite
# authenticated as four ROLE seats (field/pm/cfo/owner) and asserted things
# about what a role could do. Roles no longer exist: a seat now holds an
# arbitrary combination of boolean rights, and the property worth proving
# is that EACH RIGHT gates EXACTLY what it claims to, independent of the
# others. A role-shaped suite cannot express that — it was never able to
# test "correct_quantity without enter_quantity", because no role ever had
# that combination. This suite is built around exactly that kind of pair.
#
# Five fixtures, seated on the sandbox project (projects.is_sandbox = true)
# with deliberately narrow, awkward right sets — chosen so every probe below
# is proving an ABSENCE of a right did something, not just that a
# convenient bundle of rights happened to work. Per-PROJECT rights (below)
# are unrelated to the two COMPANY-WIDE ones on profiles (create_projects,
# manage_members, 0011) — noted separately since 0030 added targeted,
# isolated grants of those to two of the five specifically so neither
# company-wide right ever has to be proven using readonly, which holds BOTH
# already (backfilled from global_role = 'owner', 0008) and is therefore
# useless for isolating either in the Admin surface's own probes (see that
# section's own comment for why):
#   quantities     enter_quantity + correct_quantity only      (old field)
#                  + create_projects company-wide (0030)
#   full           every per-project right, no company-wide    (old pm)
#   viewer         view_rates + extract_report only            (old cfo)
#                  no company-wide rights
#   readonly       seated, zero PER-PROJECT rights              (old owner,
#                                                                repurposed)
#                  + create_projects AND manage_members company-wide
#                  (backfilled from global_role = 'owner', not 0030)
#   correct_only   correct_quantity only, NOT enter_quantity   (new — no old
#                                                                role could
#                                                                express this)
#                  + manage_members company-wide (0030)
#
# Re-runs, against the REAL linked Supabase project (never a local stub):
#   - the finance wall (item_prices has no grant path to a seat lacking
#     view_rates, whatever else that seat holds)
#   - membership-grants-visibility-and-nothing-else (readonly sees
#     quantity_records, can write nothing)
#   - the enter_quantity / correct_quantity split (the pair a role model
#     could not express)
#   - per-project rights don't imply company-wide ones (full has every
#     per-project right and still can't create a project)
#   - the confirmation-guard checks from 0003 (confirmed_by/confirmed_at
#     spoof + backdate, attribution pinned on re-touch, un-confirm rejected —
#     since 0022 these are only reachable via direct SQL, see the
#     privileged-path section; PostgREST has no route to them at all anymore)
#   - the station append-only check from 0004
#   - the draft-edit / confirm-wall split from 0021 (enter_quantity edits a
#     draft it didn't author; correct_quantity alone cannot; nobody, by any
#     path, edits a confirmed record — not even the confirm action itself,
#     in the same statement it confirms)
#   - confirmation requires a witnessed version (0022): confirming is only
#     possible through confirm_quantity_record(id, expected_version) — the
#     plain PATCH-to-confirmed path is gone outright, for every seat, right
#     or no right. A stale (pre-edit) version is rejected as stale, a
#     correct version from a seat lacking confirm_quantity is still
#     rejected, and re-confirming an already-confirmed row is rejected too —
#     three distinct, greppable failure messages, not one flat denial
#   - positive controls throughout — a suite that only ever asserts "empty"
#     or "rejected" passes just as well when authentication is silently
#     broken, which is the failure mode most likely to fool a human skimming
#     curl output
#   - Admin: contract creation and member seating (0028/0029/0030/0031) — a seat
#     without create_projects cannot create a contract by any query shape;
#     a seat without manage_members cannot seat anyone, read the roster, or
#     widen its own view of a contract it isn't a member of; a seat WITH
#     manage_members (correct_only) sees a contract and its member list it
#     isn't itself a member of, via the two widened SELECT policies; the
#     contract creator's own enrol_global_roles() grant is exactly
#     create_items and nothing else (not the seed scripts' all-rights-true
#     shape); seating a person is a fresh INSERT carrying only the rights
#     checked, and a single-column right PATCH afterward leaves every other
#     right on that row untouched; find_profile_by_email rejects a caller
#     lacking manage_members outright, resolves a real signed-in address
#     case/whitespace-insensitively, and returns empty (not an error) for an
#     address with no profiles row
#
# Meant to be re-run after every migration that touches a policy or a
# trigger on quantity_records or project_members — not read once and trusted
# forever.
#
# Writes real rows via the write-path and privileged-path checks below, so
# it always targets the dedicated sandbox project (see 0005/0006's
# "PROBE — do not use" project), never a live one. Discovery picks whichever
# sandbox project the quantities seat is on; it doesn't assume a fixed id.
#
# Usage:
#   cp scripts/.env.probe.example .env.probe   # fill in values
#   ./scripts/probe-rls.sh
#
# .env.probe is gitignored (matched by the repo's existing `.env*` pattern).
# No credentials are read from or written to any committed file.
#
# Required (from the shell environment, or from .env.probe in the repo root):
#   SUPABASE_URL, SUPABASE_ANON_KEY
#   QUANTITIES_PASSWORD, FULL_PASSWORD, VIEWER_PASSWORD, READONLY_PASSWORD,
#   CORRECT_ONLY_PASSWORD
# Optional, default to the seeded test accounts:
#   QUANTITIES_EMAIL, FULL_EMAIL, VIEWER_EMAIL, READONLY_EMAIL,
#   CORRECT_ONLY_EMAIL
#
# Exit code: 0 if every probe passed, 1 if any probe failed or a fatal setup
# error (bad credentials, no seed data) prevented probes from running at all.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Environment variables already set (e.g. CI secrets) win over .env.probe —
# loaded line by line rather than `source`d, which would silently clobber
# anything already exported. A stray leftover .env.probe on a shared runner
# overriding real CI credentials is exactly the kind of silent failure this
# script exists to catch elsewhere; it shouldn't cause one itself.
#
# Every key found in .env.probe is checked against the known set below and
# any stranger is a fatal error, not a silently-ignored line — this is what
# actually catches a stale file. A leftover pre-0008 .env.probe (FIELD_
# PASSWORD/PM_PASSWORD/CFO_PASSWORD/OWNER_PASSWORD, no CORRECT_ONLY_PASSWORD)
# used to fail downstream as either a generic missing-var error with no clue
# why, or — worse, if the stale names happened to coincide with a required
# one holding an outdated value — an opaque GoTrue sign-in failure. Neither
# reads as "your fixture file is out of date," which is the actual problem
# every time this has happened so far.
KNOWN_ENV_KEYS="SUPABASE_URL SUPABASE_ANON_KEY QUANTITIES_PASSWORD FULL_PASSWORD VIEWER_PASSWORD READONLY_PASSWORD CORRECT_ONLY_PASSWORD QUANTITIES_EMAIL FULL_EMAIL VIEWER_EMAIL READONLY_EMAIL CORRECT_ONLY_EMAIL"
if [ -f .env.probe ]; then
  unrecognised=""
  while IFS='=' read -r key value; do
    case "$key" in ''|'#'*) continue ;; esac
    case " $KNOWN_ENV_KEYS " in
      *" $key "*) ;;
      *) unrecognised="$unrecognised $key" ;;
    esac
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < .env.probe
  if [ -n "$unrecognised" ]; then
    echo "FATAL: .env.probe has variable name(s) this script doesn't use:$unrecognised" >&2
    echo "  This is what a stale, pre-rights-model .env.probe looks like (e.g. FIELD_PASSWORD" >&2
    echo "  instead of QUANTITIES_PASSWORD) — copy scripts/.env.probe.example fresh rather than" >&2
    echo "  editing an old file, and see probe-rls.sh's header for the current five fixtures." >&2
    exit 1
  fi
fi

: "${SUPABASE_URL:?Set SUPABASE_URL (env or .env.probe)}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY (env or .env.probe)}"
: "${QUANTITIES_PASSWORD:?Set QUANTITIES_PASSWORD (env or .env.probe)}"
: "${FULL_PASSWORD:?Set FULL_PASSWORD (env or .env.probe)}"
: "${VIEWER_PASSWORD:?Set VIEWER_PASSWORD (env or .env.probe)}"
: "${READONLY_PASSWORD:?Set READONLY_PASSWORD (env or .env.probe)}"
: "${CORRECT_ONLY_PASSWORD:?Set CORRECT_ONLY_PASSWORD (env or .env.probe)}"

QUANTITIES_EMAIL="${QUANTITIES_EMAIL:-field@novacore.test}"
FULL_EMAIL="${FULL_EMAIL:-pm@novacore.test}"
VIEWER_EMAIL="${VIEWER_EMAIL:-cfo@novacore.test}"
READONLY_EMAIL="${READONLY_EMAIL:-owner@novacore.test}"
CORRECT_ONLY_EMAIL="${CORRECT_ONLY_EMAIL:-probe-correct-only@novacore.test}"

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

PASS=0
FAIL=0

# check "<name>" "<expected>" <0|1> "<detail-on-failure>"
check() {
  local name="$1" expected="$2" ok="$3" detail="${4:-}"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-58s expected: %s\n' "$name" "$expected"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-58s expected: %-30s actual: %s\n' "$name" "$expected" "$detail"
  fi
}

# json_len '<json>'  -> element count if a JSON array, -1 otherwise/on parse error
json_len() {
  python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1] or '[]')
    print(len(d) if isinstance(d, list) else -1)
except Exception:
    print(-1)
" "$1"
}

# json_field '<json>' <index> <key>  -> value at d[index][key], or empty string
json_field() {
  python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
    print(d[int(sys.argv[2])].get(sys.argv[3], '') or '')
except Exception:
    print('')
" "$1" "$2" "$3"
}

# obj_field '<json>' <key>  -> value at d[key], or empty string. For RPC
# responses: confirm_quantity_record returns a single row (`returns
# public.quantity_records`, not SETOF), so PostgREST serialises it as one
# JSON OBJECT, not an array — json_field's d[int(index)] indexing doesn't
# apply here at all (indexing a dict by 0 just raises and silently returns
# '', which reads as "field missing" rather than "wrong helper used").
obj_field() {
  python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
    print(d.get(sys.argv[2], '') or '')
except Exception:
    print('')
" "$1" "$2"
}

# request METHOD PATH TOKEN [BODY]
# Sets $STATUS and $BODY_OUT.
request() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local resp
  if [ -n "$body" ]; then
    resp=$(curl -s -w '\n%{http_code}' -X "$method" "$SUPABASE_URL/rest/v1/$path" \
      -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" -H "Prefer: return=representation" \
      -d "$body")
  else
    resp=$(curl -s -w '\n%{http_code}' -X "$method" "$SUPABASE_URL/rest/v1/$path" \
      -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $token")
  fi
  STATUS=$(printf '%s' "$resp" | tail -n1)
  BODY_OUT=$(printf '%s' "$resp" | sed '$d')
}

# sign_in EMAIL PASSWORD -> prints "access_token|user_id", or "SIGNIN_FAILED"
sign_in() {
  local email="$1" password="$2" resp
  resp=$(curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}")
  python3 -c "
import json, sys
d = json.loads(sys.argv[1])
if 'access_token' not in d:
    print('SIGNIN_FAILED')
else:
    print(d['access_token'] + '|' + d['user']['id'])
" "$resp"
}

echo "=== Signing in ==="
QUANTITIES_AUTH=$(sign_in "$QUANTITIES_EMAIL" "$QUANTITIES_PASSWORD")
FULL_AUTH=$(sign_in "$FULL_EMAIL" "$FULL_PASSWORD")
VIEWER_AUTH=$(sign_in "$VIEWER_EMAIL" "$VIEWER_PASSWORD")
READONLY_AUTH=$(sign_in "$READONLY_EMAIL" "$READONLY_PASSWORD")
CORRECT_ONLY_AUTH=$(sign_in "$CORRECT_ONLY_EMAIL" "$CORRECT_ONLY_PASSWORD")

for seat_auth in "quantities $QUANTITIES_AUTH" "full $FULL_AUTH" "viewer $VIEWER_AUTH" "readonly $READONLY_AUTH" "correct_only $CORRECT_ONLY_AUTH"; do
  seat="${seat_auth%% *}"
  auth="${seat_auth#* }"
  if [ "$auth" = "SIGNIN_FAILED" ]; then
    echo "FATAL: sign-in failed for the $seat seat — check credentials in .env.probe" >&2
    exit 1
  fi
done

QUANTITIES_TOKEN="${QUANTITIES_AUTH%%|*}"; QUANTITIES_ID="${QUANTITIES_AUTH##*|}"
FULL_TOKEN="${FULL_AUTH%%|*}"; FULL_ID="${FULL_AUTH##*|}"
VIEWER_TOKEN="${VIEWER_AUTH%%|*}"; VIEWER_ID="${VIEWER_AUTH##*|}"
READONLY_TOKEN="${READONLY_AUTH%%|*}"; READONLY_ID="${READONLY_AUTH##*|}"
CORRECT_ONLY_TOKEN="${CORRECT_ONLY_AUTH%%|*}"; CORRECT_ONLY_ID="${CORRECT_ONLY_AUTH##*|}"
echo "Signed in: quantities=$QUANTITIES_ID full=$FULL_ID correct_only=$CORRECT_ONLY_ID"
echo

echo "=== Discovering a line item on the sandbox project ==="
# Filtered on contracts.is_sandbox = true (see 0005/0006), not just "whatever
# the quantities seat sees first" — this suite writes confirmed quantity_records
# as part of its own checks, and those rows must never land on a real,
# non-sandbox project. order=created_at.asc makes this deterministic: more
# than one is_sandbox=true contract now has Items (PROBE-ADMIN's
# items_earned_fields_guard fixtures, further down, are also is_sandbox=true
# — items has no DELETE grant for authenticated, so they persist across
# runs), and an unordered limit=1 previously picked whichever row Postgres
# happened to return first, silently redirecting PROJECT_ID onto
# PROBE-ADMIN on some runs and breaking every downstream section that
# expects the original seeded sandbox project (Jobs' 'PROBE Job' etc.).
# Oldest-first is stable regardless of what gets added later.
request GET "items?select=id,contract_id,contracts!inner(is_sandbox)&contracts.is_sandbox=eq.true&order=created_at.asc&limit=1" "$QUANTITIES_TOKEN"
PROJECT_ID=$(json_field "$BODY_OUT" 0 contract_id)
LINE_ITEM_ID=$(json_field "$BODY_OUT" 0 id)
if [ -z "$PROJECT_ID" ] || [ -z "$LINE_ITEM_ID" ]; then
  echo "FATAL: quantities seat sees no items on a sandbox project — seed data missing, cannot run probes" >&2
  echo "  ($STATUS $BODY_OUT)" >&2
  exit 1
fi
echo "Using project $PROJECT_ID / line item $LINE_ITEM_ID"
echo

# =============================================================================
# Finance wall — view_rates gates item_prices, independent of every
# other right a seat holds. quantities has enter_quantity + correct_quantity
# and nothing else — no view_rates, so none of these should return a price.
# =============================================================================
echo "=== Finance wall (quantities seat — no view_rates) ==="

request GET "item_prices?select=*" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: item_prices direct select" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "items?select=*,item_prices(*)" "$QUANTITIES_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  all_empty=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('1' if d and all(not r.get('item_prices') for r in d) else '0')
" "$BODY_OUT")
  [ "$all_empty" = "1" ] && ok=1
fi
check "quantities: items embed item_prices" "200, prices empty every row" "$ok" "$STATUS $BODY_OUT"

request GET "v_item_finance?select=*" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: v_item_finance" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "item_prices?select=cost_price,unit_price&limit=1000" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: item_prices unfiltered/unlimited" "200, []" "$ok" "$STATUS $BODY_OUT"

# readonly holds NO rights on the SANDBOX project specifically — scoped by
# contract_id deliberately: the readonly fixture (owner@novacore.test) keeps
# its real view_rates on Hwy 5 untouched (correct — a real project owner
# should see real prices there), so an unscoped query would return Hwy 5's
# rows and pass for the wrong reason. This is exactly what happened on the
# first run of this suite: caught it, scoped the query, not the fixture.
request GET "item_prices?select=*&contract_id=eq.$PROJECT_ID" "$READONLY_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "readonly: item_prices on sandbox project" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Monthly period views (0013) — v_contract_month joins item_prices, so it's
# behind the same finance wall by construction: view_rates gates it exactly
# like item_prices itself, zero rows rather than an error for a seat without
# it. v_item_month and v_item_progress_rate carry no money (quantity and
# rate-of-progress only) and are readable by any member regardless of
# view_rates — the readonly checks below are their positive controls.
# =============================================================================
echo
echo "=== Monthly periods (0013) ==="

request GET "v_contract_month?select=*" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: v_contract_month" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "v_contract_month?select=*&contract_id=eq.$PROJECT_ID" "$READONLY_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "readonly: v_contract_month on sandbox project" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "v_contract_month?select=*&limit=1" "$VIEWER_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "viewer: v_contract_month returns rows (view_rates)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

request GET "v_item_month?select=*&limit=1" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "quantities: v_item_month returns rows (no view_rates needed)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

request GET "v_item_progress_rate?select=*&limit=1" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "quantities: v_item_progress_rate returns rows (no view_rates needed)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Progress estimate reconciliation (0010) — finance material even without a
# price column: certified quantities and paid amounts reveal Unit Prices by
# arithmetic, so reads gate on view_rates, not mere membership. Nothing else
# ever populates these tables (0010's own header: no UI for entering estimates
# yet), so `full` (confirm_quantity) upserts one estimate + one reconciliation
# row here purely to give the checks below real data to be correctly blocked
# from — plain INSERT would 409 on a second run against the same period
# (progress_estimates' own unique(contract_id, period_start, period_end)), so
# this is the one setup step in the suite using on_conflict=merge-duplicates
# instead of the shared request() helper, deliberately, for idempotent reruns.
# =============================================================================
echo
echo "=== Progress estimate reconciliation (0010) ==="

upsert_resp=$(curl -s -w '\n%{http_code}' -X POST "$SUPABASE_URL/rest/v1/progress_estimates?on_conflict=contract_id,period_start,period_end" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $FULL_TOKEN" \
  -H "Content-Type: application/json" -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "{\"contract_id\":\"$PROJECT_ID\",\"period_start\":\"2026-01-01\",\"period_end\":\"2026-01-31\"}")
STATUS=$(printf '%s' "$upsert_resp" | tail -n1)
BODY_OUT=$(printf '%s' "$upsert_resp" | sed '$d')
ESTIMATE_ID=$(json_field "$BODY_OUT" 0 id)
ok=0; { [ "$STATUS" = "201" ] || [ "$STATUS" = "200" ]; } && [ -n "$ESTIMATE_ID" ] && ok=1
check "full: upsert progress_estimates (setup — real data for the wall below)" "200 or 201" "$ok" "$STATUS $BODY_OUT"

upsert_resp=$(curl -s -w '\n%{http_code}' -X POST "$SUPABASE_URL/rest/v1/progress_estimate_items?on_conflict=progress_estimate_id,item_id" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $FULL_TOKEN" \
  -H "Content-Type: application/json" -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "{\"progress_estimate_id\":\"$ESTIMATE_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"certified_quantity\":100}")
STATUS=$(printf '%s' "$upsert_resp" | tail -n1)
BODY_OUT=$(printf '%s' "$upsert_resp" | sed '$d')
ok=0; { [ "$STATUS" = "201" ] || [ "$STATUS" = "200" ]; } && ok=1
check "full: upsert progress_estimate_items (setup)" "200 or 201" "$ok" "$STATUS $BODY_OUT"

request GET "progress_estimates?select=*" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: progress_estimates (no view_rates)" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "progress_estimate_items?select=*" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: progress_estimate_items (no view_rates)" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "v_progress_estimate_reconciliation?select=*&contract_id=eq.$PROJECT_ID" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: v_progress_estimate_reconciliation (no view_rates)" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "progress_estimates?select=*&contract_id=eq.$PROJECT_ID" "$READONLY_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "readonly: progress_estimates on sandbox project (zero rights)" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "v_progress_estimate_reconciliation?select=*&contract_id=eq.$PROJECT_ID" "$READONLY_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "readonly: v_progress_estimate_reconciliation on sandbox project" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "v_progress_estimate_reconciliation?select=*&contract_id=eq.$PROJECT_ID" "$VIEWER_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "viewer: v_progress_estimate_reconciliation sees the row (view_rates)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

request POST "progress_estimates" "$QUANTITIES_TOKEN" "{\"contract_id\":\"$PROJECT_ID\",\"period_start\":\"2026-02-01\",\"period_end\":\"2026-02-28\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: insert progress_estimates rejected (no confirm_quantity)" "403" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Positive controls — prove the seats can still do their jobs. A suite that
# only asserts "empty"/"rejected" passes just as well when auth is silently
# broken; these are the checks that would actually catch that.
# =============================================================================
echo
echo "=== Pinned Items (0015) — discovering a unit_price and a non-unit_price Item ==="

request GET "items?select=id,contracts!inner(is_sandbox)&contracts.is_sandbox=eq.true&item_kind=eq.unit_price&limit=1" "$QUANTITIES_TOKEN"
UNIT_PRICE_ITEM_ID=$(json_field "$BODY_OUT" 0 id)

# The sandbox project (PROBE) happens to carry only unit_price Items — every
# lump_sum/provisional_sum Item quantities can see lives on Hwy 5 (a REAL
# contract quantities is also seated on). That's fine here specifically: this
# Item is used for ONE rejected insert below (expect 403), so no row is ever
# written — unlike the quantity_records probes elsewhere in this script,
# there is nothing here that could land fabricated data on a live contract.
request GET "items?select=id,contract_id&item_kind=neq.unit_price&limit=1" "$QUANTITIES_TOKEN"
NON_UNIT_ITEM_ID=$(json_field "$BODY_OUT" 0 id)
NON_UNIT_CONTRACT_ID=$(json_field "$BODY_OUT" 0 contract_id)
if [ -z "$UNIT_PRICE_ITEM_ID" ] || [ -z "$NON_UNIT_ITEM_ID" ]; then
  echo "FATAL: quantities seat needs to see at least one unit_price Item on a sandbox project AND one lump_sum/provisional_sum Item somewhere — seed data missing, cannot run pin probes" >&2
  exit 1
fi
echo "Using unit_price item $UNIT_PRICE_ITEM_ID (sandbox) / non-unit_price item $NON_UNIT_ITEM_ID (contract $NON_UNIT_CONTRACT_ID)"

# Pinning needs no special right beyond membership — it's the seat's own
# watch-list, not a contract-management action. quantities (enter_quantity +
# correct_quantity only) can still pin.
request POST "pinned_items" "$QUANTITIES_TOKEN" \
  "{\"contract_id\":\"$PROJECT_ID\",\"user_id\":\"$QUANTITIES_ID\",\"item_id\":\"$UNIT_PRICE_ITEM_ID\"}"
QUANTITIES_PIN_ID=$(json_field "$BODY_OUT" 0 id)
ok=0; [ "$STATUS" = "201" ] && [ -n "$QUANTITIES_PIN_ID" ] && ok=1
check "quantities: pin a unit_price Item" "201" "$ok" "$STATUS $BODY_OUT"

# Only Unit Price Items are pinnable — enforced at the policy, not just the UI.
request POST "pinned_items" "$QUANTITIES_TOKEN" \
  "{\"contract_id\":\"$NON_UNIT_CONTRACT_ID\",\"user_id\":\"$QUANTITIES_ID\",\"item_id\":\"$NON_UNIT_ITEM_ID\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: pin a lump_sum/provisional_sum Item rejected" "403" "$ok" "$STATUS $BODY_OUT"

# A seat may only ever pin FOR ITSELF.
request POST "pinned_items" "$QUANTITIES_TOKEN" \
  "{\"contract_id\":\"$PROJECT_ID\",\"user_id\":\"$FULL_ID\",\"item_id\":\"$UNIT_PRICE_ITEM_ID\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: pin with someone else's user_id rejected" "403" "$ok" "$STATUS $BODY_OUT"

# readonly holds zero rights but is still a seated member — pinning is a
# membership-level action, matching quantity_records' own positive control.
# Idempotent re-run: delete any leftover pin from a prior run first (a
# no-op if nothing matches — DELETE never errors on zero rows), then a
# plain insert. Not an upsert (on_conflict=merge-duplicates): that resolves
# through an UPDATE under the hood even on a genuine conflict, which
# pinned_items has no grant or policy for — deliberately, since a pin only
# ever exists or is deleted, never edited in place (see the migration).
request DELETE "pinned_items?contract_id=eq.$PROJECT_ID&user_id=eq.$READONLY_ID&item_id=eq.$UNIT_PRICE_ITEM_ID" "$READONLY_TOKEN" "{}"

request POST "pinned_items" "$READONLY_TOKEN" \
  "{\"contract_id\":\"$PROJECT_ID\",\"user_id\":\"$READONLY_ID\",\"item_id\":\"$UNIT_PRICE_ITEM_ID\"}"
READONLY_PIN_ID=$(json_field "$BODY_OUT" 0 id)
ok=0; [ "$STATUS" = "201" ] && [ -n "$READONLY_PIN_ID" ] && ok=1
check "readonly: pin a unit_price Item (membership, not a right)" "201" "$ok" "$STATUS $BODY_OUT"

# A seat sees only its own pins — readonly's select must not include
# quantities' pin row, even though both are on the same contract/Item.
request GET "pinned_items?select=id&contract_id=eq.$PROJECT_ID" "$READONLY_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  contains_others=$(python3 -c "
import json, sys
ids = [r['id'] for r in json.loads(sys.argv[1])]
print('1' if '$QUANTITIES_PIN_ID' in ids else '0')
" "$BODY_OUT")
  [ "$contains_others" = "0" ] && ok=1
fi
check "readonly: select does not include quantities' pin" "quantities' pin not present" "$ok" "$STATUS $BODY_OUT"

# ...and cannot delete a pin it doesn't own — matches 0 rows, not an error.
request DELETE "pinned_items?id=eq.$QUANTITIES_PIN_ID" "$READONLY_TOKEN" "{}"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "readonly: delete on quantities' pin matches 0 rows" "200, []" "$ok" "$STATUS $BODY_OUT"

# Owning seat can unpin its own row.
request DELETE "pinned_items?id=eq.$QUANTITIES_PIN_ID" "$QUANTITIES_TOKEN" "{}"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "quantities: unpin own row" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

# Cleanup — leaving this in place would only matter for the next run's own
# on_conflict upsert above, but there's no reason to leave a probe-created
# row sitting on the sandbox project once every check that needed it has run.
request DELETE "pinned_items?id=eq.$READONLY_PIN_ID" "$READONLY_TOKEN" "{}"

echo
echo "=== Jobs and contract dates (0016) — full holds manage_schedule on the sandbox project (0017 seed) ==="

# Upsert, not a plain insert — unlike pinned_items (which has no UPDATE grant
# at all, see that section's own comment), jobs DOES have an UPDATE grant and
# policy for the same manage_schedule right, so on_conflict resolving through
# an UPDATE is a real, safe merge here, not a hole. Makes this probe rerun-
# safe without a DELETE step, which jobs has no grant for at all. Needs the
# shared request() helper's own raw curl call bypassed for one line: PostgREST
# only actually MERGES on a genuine conflict when Prefer: resolution=merge-
# duplicates is sent — on_conflict alone (what request() sends) still hits
# the raw unique constraint on a second run, 409, confirmed by running this
# once before adding the header.
resp=$(curl -s -w '\n%{http_code}' -X POST "$SUPABASE_URL/rest/v1/jobs?on_conflict=contract_id,name" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $FULL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "{\"contract_id\":\"$PROJECT_ID\",\"name\":\"PROBE Insert Test Job\",\"planned_start\":\"2026-05-01\",\"planned_end\":\"2026-06-01\"}")
STATUS=$(printf '%s' "$resp" | tail -n1)
BODY_OUT=$(printf '%s' "$resp" | sed '$d')
ok=0
if [ "$STATUS" = "201" ] || [ "$STATUS" = "200" ]; then
  [ "$(json_len "$BODY_OUT")" != "0" ] && ok=1
fi
check "full: create/upsert a Job (manage_schedule)" "201/200, 1 row" "$ok" "$STATUS $BODY_OUT"

# quantities holds no manage_schedule on the sandbox project — creating a Job
# is rejected, same shape as every other right-gated write in this suite.
request POST "jobs?on_conflict=contract_id,name" "$QUANTITIES_TOKEN" \
  "{\"contract_id\":\"$PROJECT_ID\",\"name\":\"PROBE Quantities Should Not Create\",\"planned_start\":\"2026-05-01\",\"planned_end\":\"2026-06-01\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: create a Job rejected (no manage_schedule)" "403" "$ok" "$STATUS $BODY_OUT"

# readonly (seated, zero rights) can still see Jobs — membership, not a
# right, same positive control as items/quantity_records/pinned_items.
request GET "jobs?select=id&contract_id=eq.$PROJECT_ID" "$READONLY_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  n=$(json_len "$BODY_OUT")
  [ "$n" != "-1" ] && [ "$n" -ge 1 ] 2>/dev/null && ok=1
fi
check "readonly: select jobs (membership, not a right)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

# A Job's planned dates OUTSIDE its contract's own planned range still
# succeeds — proves the containment rule is a warning today, not a hard
# block, rather than only asserting it in a migration comment. The sandbox
# project's own planned_end is 2026-11-30 (0017 seed); this pushes a Job
# well past it.
request PATCH "jobs?contract_id=eq.$PROJECT_ID&name=eq.PROBE%20Job" "$FULL_TOKEN" \
  '{"planned_end":"2027-06-30"}'
ok=0
if [ "$STATUS" = "200" ]; then
  moved=$(json_field "$BODY_OUT" 0 planned_end)
  [ "$moved" = "2027-06-30" ] && ok=1
fi
check "full: Job planned_end outside contract's planned range still succeeds" "200, changed" "$ok" "$STATUS $BODY_OUT"

# manage_schedule covers Keywest's own planned_start/planned_end on the
# contract row itself.
request PATCH "contracts?id=eq.$PROJECT_ID" "$FULL_TOKEN" '{"planned_end":"2026-12-01"}'
ok=0
if [ "$STATUS" = "200" ]; then
  moved=$(json_field "$BODY_OUT" 0 planned_end)
  [ "$moved" = "2026-12-01" ] && ok=1
fi
check "full: update contracts.planned_end (manage_schedule)" "200, changed" "$ok" "$STATUS $BODY_OUT"

# ...but NOT the Ministry's contract_start/contract_end — manage_schedule
# alone is not manage_members, and guard_contract_date_columns() (0016)
# raises rather than silently no-op'ing. A trigger-raised exception, not a
# bare RLS denial — same >=400 pattern this suite already uses below for
# guard_entry_transitions' un-confirm rejection.
request PATCH "contracts?id=eq.$PROJECT_ID" "$FULL_TOKEN" '{"contract_end":"2026-12-20"}'
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: update contracts.contract_end rejected (manage_schedule alone is not enough)" ">=400" "$ok" "$STATUS $BODY_OUT"

# quantities (neither manage_schedule nor manage_members) can't move either
# date pair on contracts. USING excludes the row outright (no right matches),
# so this is PostgREST's "0 rows visible to update" shape — 200 with an
# empty body, not a 403 — same as "quantities: status update rejected"
# and "viewer: update item_prices rejected" elsewhere in this suite. The
# full-seat probes above got 403/>=400 instead because THEY are members with
# SOME matching right (manage_schedule), so USING passes and it's WITH CHECK
# or the trigger that then blocks the specific column — a different failure
# point with a different shape.
request PATCH "contracts?id=eq.$PROJECT_ID" "$QUANTITIES_TOKEN" '{"planned_start":"2026-04-01"}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: update contracts.planned_start rejected" "200, []" "$ok" "$STATUS $BODY_OUT"

echo
echo "=== item_jobs (0019) — Item <-> Job assignment, same right as jobs itself ==="

# A stable Job on the sandbox project — 0017's own seed ('PROBE Job'), not
# whichever one this suite's Jobs section above just inserted, so this
# section doesn't depend on staying immediately after that one.
request GET "jobs?select=id&contract_id=eq.$PROJECT_ID&name=eq.PROBE%20Job" "$FULL_TOKEN"
JOB_ID=$(json_field "$BODY_OUT" 0 id)
if [ -z "$JOB_ID" ]; then
  echo "FATAL: could not find 'PROBE Job' on the sandbox project — has 0017's seed been applied?" >&2
  exit 1
fi

# full holds manage_schedule on the sandbox project — the same right that
# gates jobs itself (0016), reused rather than a new one: assigning an Item
# to a Job is the same kind of decision as creating the Job.
request POST "item_jobs" "$FULL_TOKEN" \
  "{\"item_id\":\"$UNIT_PRICE_ITEM_ID\",\"job_id\":\"$JOB_ID\",\"contract_id\":\"$PROJECT_ID\"}"
ok=0; [ "$STATUS" = "201" ] && [ "$(json_len "$BODY_OUT")" != "0" ] && ok=1
check "full: assign an Item to a Job (manage_schedule)" "201, 1 row" "$ok" "$STATUS $BODY_OUT"

# quantities holds no manage_schedule — WITH CHECK fails outright, same 403
# shape as jobs' own insert-right probe above (this is an insert being
# refused, not a row simply invisible under USING).
request POST "item_jobs" "$QUANTITIES_TOKEN" \
  "{\"item_id\":\"$UNIT_PRICE_ITEM_ID\",\"job_id\":\"$JOB_ID\",\"contract_id\":\"$PROJECT_ID\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: assign an Item to a Job rejected (no manage_schedule)" "403" "$ok" "$STATUS $BODY_OUT"

# readonly (seated, zero rights) can still see the assignment — membership,
# not a right, same positive control as jobs/items/quantity_records.
request GET "item_jobs?select=item_id&contract_id=eq.$PROJECT_ID&job_id=eq.$JOB_ID&item_id=eq.$UNIT_PRICE_ITEM_ID" "$READONLY_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  n=$(json_len "$BODY_OUT")
  [ "$n" != "-1" ] && [ "$n" -ge 1 ] 2>/dev/null && ok=1
fi
check "readonly: select item_jobs (membership, not a right)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

# quantities can't remove the assignment either — DELETE's USING clause
# simply excludes the row for a seat without manage_schedule, so this is
# PostgREST's "0 rows visible" shape (200, empty body), not a 403 — same
# distinction this suite already draws for contracts.planned_start above:
# a policy that only ever gates via USING (no WITH CHECK path for DELETE)
# fails this way, not with an error status.
request DELETE "item_jobs?item_id=eq.$UNIT_PRICE_ITEM_ID&job_id=eq.$JOB_ID" "$QUANTITIES_TOKEN" "{}"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: unassign an Item from a Job matches 0 rows (no manage_schedule)" "200, []" "$ok" "$STATUS $BODY_OUT"

# full removes it — cleanup, and proves the delete grant/policy actually
# works, not just that it's absent for quantities.
request DELETE "item_jobs?item_id=eq.$UNIT_PRICE_ITEM_ID&job_id=eq.$JOB_ID" "$FULL_TOKEN" "{}"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "full: unassign an Item from a Job (manage_schedule)" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

echo
echo "=== Actual cost (0018) — behind the finance wall exactly as item_prices, gated to write by record_actual_cost ==="

# quantities holds no view_rates — same wall as item_prices, by construction
# (actual_cost_entries' own SELECT policy) and independently on the view
# (inner join on item_prices).
request GET "actual_cost_entries?select=*" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: actual_cost_entries direct select" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "v_item_actual_cost?select=*" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: v_item_actual_cost" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "actual_cost_entries?select=*" "$READONLY_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "readonly: actual_cost_entries on sandbox project" "200, []" "$ok" "$STATUS $BODY_OUT"

# viewer holds view_rates but not record_actual_cost — reads the ledger
# (0018's own seed on the sandbox project's item ...0001) but cannot write
# to it.
request GET "v_item_actual_cost?select=*&item_id=eq.c0ffee00-c0de-0000-0000-000000000001" "$VIEWER_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  actual=$(json_field "$BODY_OUT" 0 actual_cost_to_date)
  [ -n "$actual" ] && ok=1
fi
check "viewer: v_item_actual_cost sees the seeded entry (view_rates)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

request POST "actual_cost_entries" "$VIEWER_TOKEN" \
  '{"contract_id":"c0ffee00-c0de-0000-0000-000000000000","item_id":"c0ffee00-c0de-0000-0000-000000000002","amount":10,"incurred_date":"2026-08-01"}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "viewer: insert actual cost rejected (view_rates alone is not record_actual_cost)" "403" "$ok" "$STATUS $BODY_OUT"

# quantities holds neither view_rates nor record_actual_cost.
request POST "actual_cost_entries" "$QUANTITIES_TOKEN" \
  "{\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"c0ffee00-c0de-0000-0000-000000000002\",\"amount\":10,\"incurred_date\":\"2026-08-01\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: insert actual cost rejected (no record_actual_cost)" "403" "$ok" "$STATUS $BODY_OUT"

# full holds record_actual_cost (0018 seed) — a genuine insert against item
# ...0002 (the "stays absent" fixture item, otherwise untouched), so this
# probe's own write is exactly what flips it from absent to a real, non-null
# actual_cost_to_date the first time this suite runs, and adds another
# ledger entry on every rerun thereafter — same accepted, ever-accumulating-
# on-purpose shape as the quantities write path below has always had on this
# dedicated sandbox project.
request POST "actual_cost_entries" "$FULL_TOKEN" \
  "{\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"c0ffee00-c0de-0000-0000-000000000002\",\"amount\":25,\"incurred_date\":\"2026-08-01\",\"note\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "201" ] && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "full: insert actual cost (record_actual_cost)" "201, 1 row" "$ok" "$STATUS $BODY_OUT"

# Absent, not zero — item ...0003 has never had a ledger entry.
request GET "v_item_actual_cost?select=actual_cost_to_date,cost_variance&item_id=eq.c0ffee00-c0de-0000-0000-000000000003" "$FULL_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  actual=$(json_field "$BODY_OUT" 0 actual_cost_to_date)
  [ -z "$actual" ] && ok=1
fi
check "full: v_item_actual_cost absent (no entries) reads null, not zero" "200, null" "$ok" "$STATUS $BODY_OUT"

# No update or delete grant at all — append-only, corrections are a new
# signed entry, never an edit.
request PATCH "actual_cost_entries?contract_id=eq.$PROJECT_ID&limit=1" "$FULL_TOKEN" '{"amount":1}'
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: update actual_cost_entries rejected (no grant, append-only)" ">=400" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Cost as a total or per unit (0023/0024) — the new reachable surface. A
# Lump Sum Item has no non-sandbox equivalent quantities can see (every
# lump_sum/provisional_sum Item lives on Hwy 5, off-limits for verification
# writes per README.md's standing rule) — 0025 seeds PROBE-LS-001 on the
# sandbox contract specifically so this has somewhere to write.
#
# viewer holds set_cost on the SANDBOX CONTRACT ONLY (0026) — nowhere else —
# specifically so it can isolate "set_cost alone suffices for a non-
# unit_price Item" from "full has every right anyway": no existing fixture
# held set_cost without set_unit_price, and this is the one thing 0023
# actually changed (a Unit Price Item's cost still needs both — viewer's
# pre-existing "update item_prices rejected" check against a unit_price
# Item is unaffected by this grant, still rejected, since set_unit_price is
# still required for that item_kind).
# =============================================================================
echo
echo "=== Cost as a total or per unit (0023/0024) ==="

LUMP_SUM_ITEM_ID="c0ffee00-c0de-0000-0000-000000000004"

# Insert-time guard: per_unit is not offered to, and not writable for, a
# Lump Sum Item — full holds every per-project right and still can't.
request POST "item_prices" "$FULL_TOKEN" \
  "{\"item_id\":\"$LUMP_SUM_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"cost_price\":50000,\"cost_basis\":\"per_unit\"}"
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: per_unit cost_basis on a Lump Sum Item rejected (0024)" ">=400" "$ok" "$STATUS $BODY_OUT"

# quantities holds no set_cost at all — the wall holds for the new surface
# exactly as it always has for the old one.
request POST "item_prices" "$QUANTITIES_TOKEN" \
  "{\"item_id\":\"$LUMP_SUM_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"cost_price\":50000,\"cost_basis\":\"total\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: insert Lump Sum Item cost rejected (no set_cost)" "403" "$ok" "$STATUS $BODY_OUT"

# viewer holds set_cost on the sandbox contract ONLY, and NOT set_unit_price
# anywhere — this succeeding is the actual proof that set_unit_price is not
# required for a non-unit_price Item, isolated from full's blanket rights.
# Upsert (on_conflict=item_id, resolution=merge-duplicates), not a plain
# POST: item_id is item_prices' own primary key, so a second run of this
# suite would otherwise hit a 409 on the still-existing row from the first
# — same idempotent-rerun shape this file already uses for progress_estimates
# and jobs, via the shared request() helper's own raw-curl escape hatch.
upsert_resp=$(curl -s -w '\n%{http_code}' -X POST "$SUPABASE_URL/rest/v1/item_prices?on_conflict=item_id" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H "Content-Type: application/json" -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "{\"item_id\":\"$LUMP_SUM_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"cost_price\":50000,\"cost_basis\":\"total\"}")
STATUS=$(printf '%s' "$upsert_resp" | tail -n1)
BODY_OUT=$(printf '%s' "$upsert_resp" | sed '$d')
ok=0
if [ "$STATUS" = "201" ] || [ "$STATUS" = "200" ]; then
  cb=$(json_field "$BODY_OUT" 0 cost_basis)
  cp=$(json_field "$BODY_OUT" 0 cost_price)
  [ "$cb" = "total" ] && [ "$cp" = "50000" ] && ok=1
fi
check "viewer: insert/upsert Lump Sum Item cost as a total (set_cost alone, no set_unit_price)" "200/201, cost_basis=total" "$ok" "$STATUS $BODY_OUT"

# Same seat, update path — a fresh total, proving the UPDATE policy carries
# the same set_unit_price-only-if-unit_price exception as INSERT, not just
# the one this suite happened to check first.
request PATCH "item_prices?item_id=eq.$LUMP_SUM_ITEM_ID" "$VIEWER_TOKEN" '{"cost_price": 62000}'
ok=0
if [ "$STATUS" = "200" ]; then
  cp=$(json_field "$BODY_OUT" 0 cost_price)
  [ "$cp" = "62000" ] && ok=1
fi
check "viewer: update Lump Sum Item cost (set_cost alone, no set_unit_price)" "200, cost_price=62000" "$ok" "$STATUS $BODY_OUT"

# viewer still can't move it to per_unit on update either. USING still
# admits the row (viewer holds set_cost, item isn't unit_price), so this
# fails at WITH CHECK on the resulting new row instead of being excluded
# up front — an explicit "violates row-level security policy" 403, not a
# silent 0-row match, same shape already established for an analogous
# USING-passes-but-WITH-CHECK-fails case in the draft-edit section above.
request PATCH "item_prices?item_id=eq.$LUMP_SUM_ITEM_ID" "$VIEWER_TOKEN" '{"cost_basis": "per_unit"}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "viewer: update Lump Sum Item to per_unit rejected (0024)" "403" "$ok" "$STATUS $BODY_OUT"

# item_prices_cost_basis_matches_value (0023) — a cost with no basis is
# rejected regardless of who's asking. PATCH against PROBE-002 (already
# priced, per the sandbox seed) rather than POST: an insert here would hit
# the primary key conflict first and never reach the CHECK constraint at
# all, which would pass this probe for the wrong reason.
request PATCH "item_prices?item_id=eq.c0ffee00-c0de-0000-0000-000000000002" "$FULL_TOKEN" '{"cost_basis": null}'
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: cost_price without a matching cost_basis rejected (0023 constraint)" ">=400" "$ok" "$STATUS $BODY_OUT"

# quantities lacks view_rates entirely — the read wall is unchanged for the
# new surface: a Lump Sum Item's cost is exactly as invisible to it as a
# Unit Price Item's always has been.
request GET "item_prices?select=cost_price,cost_basis&item_id=eq.$LUMP_SUM_ITEM_ID" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: Lump Sum Item cost invisible (no view_rates)" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# items.percent_complete / items.authorized_value — write access
# (items_earned_fields_update_right, projected-versus-actual). Same gate as
# setting a price — set_cost AND set_unit_price — not create_items: full
# holds every per-project right including both, quantities holds neither.
# The pre-existing kind constraints (items_percent_only_lump_sum /
# items_provisional_fields_only_provisional) are untouched by this
# migration; the third check proves the new grant doesn't loosen them —
# a fully-rights seat still can't put authorized_value on a Lump Sum Item.
#
# The "quantities: rejected" check below only proves rejection when
# quantities holds no relevant right at all. It does NOT prove the
# set_cost/set_unit_price gate specifically — see the "items_earned_fields_
# guard trigger (0037)" section further down (PROBE-ADMIN contract) for the
# isolated version of that claim, and why this block alone let a real gap
# ship unnoticed for two migrations.
# =============================================================================
echo
echo "=== items earned fields (percent_complete / authorized_value) ==="

request PATCH "items?id=eq.$LUMP_SUM_ITEM_ID" "$FULL_TOKEN" '{"percent_complete": 45}'
ok=0
if [ "$STATUS" = "200" ]; then
  pc=$(json_field "$BODY_OUT" 0 percent_complete)
  [ "$pc" = "45" ] && ok=1
fi
check "full: set percent_complete on a Lump Sum Item (set_cost + set_unit_price)" "200, percent_complete=45" "$ok" "$STATUS $BODY_OUT"

request PATCH "items?id=eq.$LUMP_SUM_ITEM_ID" "$QUANTITIES_TOKEN" '{"percent_complete": 10}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: set percent_complete rejected (no set_cost/set_unit_price)" "200, []" "$ok" "$STATUS $BODY_OUT"

request PATCH "items?id=eq.$LUMP_SUM_ITEM_ID" "$FULL_TOKEN" '{"authorized_value": 1000}'
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: authorized_value on a Lump Sum Item still rejected (kind constraint, unrelated to this grant)" ">=400" "$ok" "$STATUS $BODY_OUT"

# Cleanup — shared fixture across the whole suite.
request PATCH "items?id=eq.$LUMP_SUM_ITEM_ID" "$FULL_TOKEN" '{"percent_complete": null}'
check "cleanup: percent_complete reverted to null" "200, 1 row" "$([ "$STATUS" = "200" ] && echo 1 || echo 0)" "$STATUS $BODY_OUT"

# =============================================================================
# items.area_basis (0038) — no new grant or policy: items_update_right
# already gates every column of items on create_items unconditionally, and
# that's exactly the right this is meant to be gated on (whoever creates a
# contract's Items sets this from the contract documents). full holds
# create_items on the sandbox project (UNIT_PRICE_ITEM_ID's contract),
# quantities does not. UNIT_PRICE_ITEM_ID starts null (Litre — the
# backfill's own deliberate carve-out), so this probe also doubles as a
# check that "Unclassified" round-trips as null, not a default.
# =============================================================================
echo
echo "=== items.area_basis (0038) ==="

request PATCH "items?id=eq.$UNIT_PRICE_ITEM_ID" "$FULL_TOKEN" '{"area_basis": "not_applicable"}'
ok=0
if [ "$STATUS" = "200" ]; then
  ab=$(json_field "$BODY_OUT" 0 area_basis)
  [ "$ab" = "not_applicable" ] && ok=1
fi
check "full: set area_basis (create_items)" "200, area_basis=not_applicable" "$ok" "$STATUS $BODY_OUT"

request PATCH "items?id=eq.$UNIT_PRICE_ITEM_ID" "$QUANTITIES_TOKEN" '{"area_basis": "quantity_is_area"}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: set area_basis rejected (no create_items)" "200, []" "$ok" "$STATUS $BODY_OUT"

request PATCH "items?id=eq.$UNIT_PRICE_ITEM_ID" "$FULL_TOKEN" '{"area_basis": "not_a_real_value"}'
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: invalid area_basis value rejected (check constraint)" ">=400" "$ok" "$STATUS $BODY_OUT"

# Cleanup — restore the pre-probe state (null, "Unclassified").
request PATCH "items?id=eq.$UNIT_PRICE_ITEM_ID" "$FULL_TOKEN" '{"area_basis": null}'
check "cleanup: area_basis reverted to null" "200, 1 row" "$([ "$STATUS" = "200" ] && echo 1 || echo 0)" "$STATUS $BODY_OUT"

# =============================================================================
# item_prices history — item_price_history + log_item_price_change() trigger.
# viewer holds set_cost on the sandbox contract only (see above) and
# view_rates everywhere (its whole fixture identity) — the one seat that can
# both cause a change here and read what it logged. quantities holds neither,
# so it's the negative control for both the write wall (trigger-only) and
# the read wall (view_rates, mirrored from item_prices itself).
# =============================================================================
echo
echo "=== item_prices history (0036) ==="

# An ordinary change: old_cost_price should be the value this suite's own
# 0023/0024 section just left it at (62000, from the update-path check
# above), new_cost_price the fresh value.
request PATCH "item_prices?item_id=eq.$LUMP_SUM_ITEM_ID" "$VIEWER_TOKEN" '{"cost_price": 71000}'
ok=0; [ "$STATUS" = "200" ] && ok=1
check "viewer: update Lump Sum Item cost again, to generate a history row" "200" "$ok" "$STATUS $BODY_OUT"

request GET "item_price_history?select=old_cost_price,new_cost_price&item_id=eq.$LUMP_SUM_ITEM_ID&order=changed_at.desc&limit=1" "$VIEWER_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  ocp=$(json_field "$BODY_OUT" 0 old_cost_price)
  ncp=$(json_field "$BODY_OUT" 0 new_cost_price)
  [ "$ocp" = "62000" ] && [ "$ncp" = "71000" ] && ok=1
fi
check "viewer: item_price_history captured old->new (view_rates)" "200, 62000->71000" "$ok" "$STATUS $BODY_OUT"

# The actual failure mode this table exists for: a value replaced by null
# must be captured, not silently lost.
request PATCH "item_prices?item_id=eq.$LUMP_SUM_ITEM_ID" "$VIEWER_TOKEN" '{"cost_price": null, "cost_basis": null}'
ok=0; [ "$STATUS" = "200" ] && ok=1
check "viewer: null out Lump Sum Item cost" "200" "$ok" "$STATUS $BODY_OUT"

request GET "item_price_history?select=old_cost_price,new_cost_price&item_id=eq.$LUMP_SUM_ITEM_ID&order=changed_at.desc&limit=1" "$VIEWER_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  ocp=$(json_field "$BODY_OUT" 0 old_cost_price)
  ncp=$(json_field "$BODY_OUT" 0 new_cost_price)
  [ "$ocp" = "71000" ] && [ "$ncp" = "" ] && ok=1
fi
check "viewer: item_price_history recovers value replaced by null" "200, old=71000, new=null" "$ok" "$STATUS $BODY_OUT"

# Re-saving the exact same values (both null, unchanged) must NOT log a
# fresh row — row(...) IS DISTINCT FROM row(...) should treat this as a
# no-op, same as it already is for item_prices' own no-op-write case.
request GET "item_price_history?select=id&item_id=eq.$LUMP_SUM_ITEM_ID" "$VIEWER_TOKEN"
before_count=$(json_len "$BODY_OUT")
request PATCH "item_prices?item_id=eq.$LUMP_SUM_ITEM_ID" "$VIEWER_TOKEN" '{"cost_price": null, "cost_basis": null}'
request GET "item_price_history?select=id&item_id=eq.$LUMP_SUM_ITEM_ID" "$VIEWER_TOKEN"
after_count=$(json_len "$BODY_OUT")
ok=0; [ "$before_count" != "-1" ] && [ "$before_count" = "$after_count" ] && ok=1
check "viewer: re-saving unchanged (null) values logs no new row" "row count unchanged" "$ok" "before=$before_count after=$after_count"

# Restore the sandbox fixture's price so reruns of the 0023/0024 section
# above still find it in the state those checks assume.
request PATCH "item_prices?item_id=eq.$LUMP_SUM_ITEM_ID" "$VIEWER_TOKEN" '{"cost_price": 50000, "cost_basis": "total"}'

# No view_rates -> no read, exactly like item_prices itself.
request GET "item_price_history?select=*&item_id=eq.$LUMP_SUM_ITEM_ID" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: item_price_history invisible (no view_rates)" "200, []" "$ok" "$STATUS $BODY_OUT"

# No insert grant to authenticated at all — only the trigger, running as
# its owner, ever writes here. full holds every per-project right and
# still can't reach this table directly.
request POST "item_price_history" "$FULL_TOKEN" \
  "{\"item_id\":\"$LUMP_SUM_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"new_cost_price\":1}"
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: direct insert into item_price_history rejected (trigger-only writes)" ">=400" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Admin: contract creation and member seating (0028/0029/0030/0031) — the new
# reachable surface. readonly (owner@novacore.test) already holds BOTH
# company-wide rights but is ALSO auto-enrolled on every contract that has
# ever existed (global_role holders get view_rates/extract_report the
# moment ANY contract is created), which confounds exactly the two things
# worth proving here: "the creator gets create_items and nothing else" and
# "manage_members sees a contract it isn't a member of". 0030 gave
# quantities create_projects and correct_only manage_members specifically
# because neither holds a global_role — clean isolation, not readonly's
# blanket case.
#
# 0031 exists because isolating quantities this way caught a REAL bug in
# the shipped CreateContractScreen, not just a probe artifact: createContract()
# (contracts.ts) chains .select() after .insert(), which sends Prefer:
# return=representation. Postgres checks an INSERT's RETURNING rows against
# the table's SELECT policy at the moment the row is inserted — BEFORE any
# AFTER INSERT trigger runs. enrol_global_roles() (the trigger that gives
# the creator their own create_items) is exactly such a trigger, so a
# create_projects-only creator with no manage_members and no global_role
# failed contracts_select_member's is_member(id) check on their own
# just-created row, every time — a 403 on contract creation itself, for
# precisely the "holds one right without the other" seat this whole brief
# exists to support. readonly never surfaces this (has_global_right(
# 'manage_members') already satisfies the policy regardless of trigger
# timing); only an isolated create_projects-only fixture like quantities
# does. 0031 adds `created_by = auth.uid()` as a third OR branch — a
# creator can always see the row they just made. The two checks below
# (contract creation succeeding at all, then the exact-match rights check)
# are what catch a regression back to this if the policy is ever narrowed
# again.
# =============================================================================
echo
echo "=== Admin: contract creation and member seating (0028/0029/0030/0031) ==="

ADMIN_CONTRACT_ID="ba5eba11-0000-0000-0000-000000000000"

# viewer holds neither company-wide right — the wall for BOTH new actions
# is the same has_global_right() gate the rest of this suite already
# proves works everywhere else.
request POST "contracts" "$VIEWER_TOKEN" \
  "{\"contract_name\":\"should not be created\",\"created_by\":\"$VIEWER_ID\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "viewer: create a contract rejected (no create_projects)" "403" "$ok" "$STATUS $BODY_OUT"

# quantities creates the fixed-id PROBE-ADMIN contract. Plain INSERT, not
# an upsert: unlike item_prices/jobs, contracts carries NO general UPDATE
# grant on contract_name/contract_no/is_sandbox/created_by (by design —
# 0017's own header notes this gap was deliberately left for "the queued
# contract-admin UI", and this brief did not open it, since nothing in
# either screen ever edits an existing contract's own details). An
# on_conflict=id upsert 403s outright even on a FRESH insert, because
# Postgres checks UPDATE privilege on every SET-clause column the moment
# the statement is parsed, before it even knows whether the conflict
# branch will fire. So: plain POST, and a rerun's 409 (primary-key
# conflict — the row already exists from a prior run) is treated as
# success too, re-fetched via GET to confirm its shape rather than assumed.
request POST "contracts" "$QUANTITIES_TOKEN" \
  "{\"id\":\"$ADMIN_CONTRACT_ID\",\"contract_name\":\"PROBE-ADMIN — do not use\",\"contract_no\":\"PROBE-ADMIN-0000\",\"is_sandbox\":true,\"created_by\":\"$QUANTITIES_ID\"}"
ok=0
if [ "$STATUS" = "201" ]; then
  sandbox=$(json_field "$BODY_OUT" 0 is_sandbox)
  [ "$sandbox" = "True" ] || [ "$sandbox" = "true" ] && ok=1
elif [ "$STATUS" = "409" ]; then
  request GET "contracts?select=is_sandbox&id=eq.$ADMIN_CONTRACT_ID" "$QUANTITIES_TOKEN"
  if [ "$STATUS" = "200" ]; then
    sandbox=$(json_field "$BODY_OUT" 0 is_sandbox)
    [ "$sandbox" = "True" ] || [ "$sandbox" = "true" ] && ok=1
  fi
fi
check "quantities: create the PROBE-ADMIN sandbox contract (create_projects)" "201 (or 409 on rerun), is_sandbox=true" "$ok" "$STATUS $BODY_OUT"

# enrol_global_roles' new branch (0028): the creator gets create_items and
# ONLY create_items. quantities holds no global_role, so this row is not
# also touched by the OTHER branch (which would add view_rates/
# extract_report for a global_role holder) — an exact-match check, not
# just "create_items is true", precisely so a future regression back
# toward the seed scripts' all-rights-true shape would be caught here.
request GET "contract_members?select=create_items,set_cost,set_unit_price,enter_quantity,correct_quantity,confirm_quantity,view_rates,extract_report&contract_id=eq.$ADMIN_CONTRACT_ID&user_id=eq.$QUANTITIES_ID" "$QUANTITIES_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  exact=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
expected = {
  'create_items': True, 'set_cost': False, 'set_unit_price': False,
  'enter_quantity': False, 'correct_quantity': False, 'confirm_quantity': False,
  'view_rates': False, 'extract_report': False,
}
print('1' if len(d) == 1 and d[0] == expected else '0')
" "$BODY_OUT")
  [ "$exact" = "1" ] && ok=1
fi
check "quantities: creator auto-granted create_items ONLY, not every right" "exact match" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# items_earned_fields_guard trigger (0037) — the gap a live PATCH proved:
# items_update_right (create_items) is a PERMISSIVE policy with no column
# granularity, so a create_items-only seat could already write
# percent_complete/authorized_value straight through it —
# items_earned_fields_update_right (0036) added no real restriction, since
# permissive policies on the same table OR together. The check above
# ("quantities: set percent_complete rejected") never isolated this:
# on that fixture quantities holds NEITHER create_items NOR
# set_cost/set_unit_price, so the rejection came from items_update_right's
# own row check failing — "no rights at all", not "create_items without
# set_cost/set_unit_price". quantities on PROBE-ADMIN, confirmed just above
# (create_items=true, set_cost=false, set_unit_price=false), is the one
# seat shape that actually exercises the claim, on both INSERT and UPDATE.
# =============================================================================
GUARD_LUMP_SUM_ID="deadbeef-0000-0000-0000-0000000000a1"
GUARD_PROVISIONAL_ID="deadbeef-0000-0000-0000-0000000000a2"

request POST "items" "$QUANTITIES_TOKEN" \
  "{\"id\":\"$GUARD_LUMP_SUM_ID\",\"contract_id\":\"$ADMIN_CONTRACT_ID\",\"item_number\":\"GUARD.01\",\"description\":\"earned-fields guard probe (lump sum)\",\"unit\":\"Lump Sum\",\"approximate_quantity\":1,\"item_kind\":\"lump_sum\"}"
ok=0; { [ "$STATUS" = "201" ] || [ "$STATUS" = "409" ]; } && ok=1
check "quantities: create guard-probe Lump Sum Item on PROBE-ADMIN (create_items)" "201 (or 409 on rerun)" "$ok" "$STATUS $BODY_OUT"

request POST "items" "$QUANTITIES_TOKEN" \
  "{\"id\":\"$GUARD_PROVISIONAL_ID\",\"contract_id\":\"$ADMIN_CONTRACT_ID\",\"item_number\":\"GUARD.02\",\"description\":\"earned-fields guard probe (provisional sum)\",\"unit\":\"Provisional Sum\",\"approximate_quantity\":1,\"item_kind\":\"provisional_sum\"}"
ok=0; { [ "$STATUS" = "201" ] || [ "$STATUS" = "409" ]; } && ok=1
check "quantities: create guard-probe Provisional Sum Item on PROBE-ADMIN (create_items)" "201 (or 409 on rerun)" "$ok" "$STATUS $BODY_OUT"

request PATCH "items?id=eq.$GUARD_LUMP_SUM_ID" "$QUANTITIES_TOKEN" '{"percent_complete": 77}'
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "quantities: percent_complete UPDATE rejected at the database (create_items alone, no set_cost/set_unit_price)" ">=400" "$ok" "$STATUS $BODY_OUT"

request PATCH "items?id=eq.$GUARD_PROVISIONAL_ID" "$QUANTITIES_TOKEN" '{"authorized_value": 500}'
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "quantities: authorized_value UPDATE rejected at the database (create_items alone)" ">=400" "$ok" "$STATUS $BODY_OUT"

request POST "items" "$QUANTITIES_TOKEN" \
  "{\"contract_id\":\"$ADMIN_CONTRACT_ID\",\"item_number\":\"GUARD.03\",\"description\":\"earned-fields guard probe (insert-time)\",\"unit\":\"Lump Sum\",\"approximate_quantity\":1,\"item_kind\":\"lump_sum\",\"percent_complete\":88}"
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "quantities: percent_complete INSERT rejected at the database (create_items alone)" ">=400" "$ok" "$STATUS $BODY_OUT"

# A plain, non-finance edit (create_items alone, finance fields untouched)
# must still succeed — the trigger only fires when percent_complete/
# authorized_value actually change, so it must not regress ordinary Item
# edits (or the area_basis column landing in 0038 right after this).
request PATCH "items?id=eq.$GUARD_LUMP_SUM_ID" "$QUANTITIES_TOKEN" '{"description": "earned-fields guard probe (lump sum, edited)"}'
ok=0; [ "$STATUS" = "200" ] && ok=1
check "quantities: ordinary field edit still succeeds (create_items, finance fields untouched)" "200" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# item_derivation_rules / item_derivation_sources / item_application_rate_
# targets (0039) — same create_items gate as area_basis, fresh tables with
# no prior grant to widen (see 0039's own header on why no trigger is
# needed here, unlike 0037). PROBE-002 (Tonne, separately_measured) is the
# rule/target Item; PROBE-004 (also Tonne, separately_measured, same
# contract) is the source. Both pre-exist as fixtures (0025).
# GUARD_LUMP_SUM_ID (PROBE-ADMIN, just above) is what makes the
# cross-contract composite-FK check possible this far into the script.
# =============================================================================
echo
echo "=== item_derivation_rules / sources / item_application_rate_targets (0039) ==="

RULE_ITEM_ID="c0ffee00-c0de-0000-0000-000000000002"
SOURCE_ITEM_ID="3c4e0a28-2e27-40ee-b1e6-4f8cd6233c33"

request POST "item_derivation_rules" "$FULL_TOKEN" \
  "{\"item_id\":\"$RULE_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"coefficient\":0.26,\"basis\":\"area\"}"
ok=0; [ "$STATUS" = "201" ] && ok=1
check "full: create a derivation rule (create_items)" "201" "$ok" "$STATUS $BODY_OUT"

request POST "item_derivation_sources" "$FULL_TOKEN" \
  "{\"rule_item_id\":\"$RULE_ITEM_ID\",\"source_item_id\":\"$SOURCE_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\"}"
ok=0; [ "$STATUS" = "201" ] && ok=1
check "full: add a source to the rule (create_items)" "201" "$ok" "$STATUS $BODY_OUT"

request GET "item_derivation_rules?item_id=eq.$RULE_ITEM_ID" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "quantities: reads the rule (membership alone, no right needed)" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

request POST "item_derivation_rules" "$QUANTITIES_TOKEN" \
  "{\"item_id\":\"$SOURCE_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"coefficient\":1,\"basis\":\"area\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: create a derivation rule rejected (no create_items)" "403" "$ok" "$STATUS $BODY_OUT"

# contract_id correctly matches the rule (PROJECT_ID) here — it's the
# SOURCE Item that actually belongs elsewhere (GUARD_LUMP_SUM_ID, on
# PROBE-ADMIN), isolating the second composite FK specifically rather
# than just tripping the first one on a contract_id/rule mismatch.
request POST "item_derivation_sources" "$FULL_TOKEN" \
  "{\"rule_item_id\":\"$RULE_ITEM_ID\",\"source_item_id\":\"$GUARD_LUMP_SUM_ID\",\"contract_id\":\"$PROJECT_ID\"}"
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: source Item that actually belongs to a different contract rejected (composite FK)" ">=400" "$ok" "$STATUS $BODY_OUT"

request POST "item_application_rate_targets" "$FULL_TOKEN" \
  "{\"item_id\":\"$RULE_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"target_rate\":124.35,\"band_low_percent\":96,\"band_high_percent\":104}"
ok=0; [ "$STATUS" = "201" ] && ok=1
check "full: create an application rate target (create_items)" "201" "$ok" "$STATUS $BODY_OUT"

request POST "item_application_rate_targets" "$QUANTITIES_TOKEN" \
  "{\"item_id\":\"$SOURCE_ITEM_ID\",\"contract_id\":\"$PROJECT_ID\",\"target_rate\":100}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: create an application rate target rejected (no create_items)" "403" "$ok" "$STATUS $BODY_OUT"

# Cleanup — rule delete cascades to its source row. "{}" body triggers
# Prefer: return=representation (see request()), so PostgREST returns 200
# with the deleted row rather than a bodyless 204 — matching every other
# DELETE cleanup in this suite (pinned_items, item_jobs).
request DELETE "item_derivation_rules?item_id=eq.$RULE_ITEM_ID" "$FULL_TOKEN" "{}"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "cleanup: derivation rule (and its source, via cascade) deleted" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

request DELETE "item_application_rate_targets?item_id=eq.$RULE_ITEM_ID" "$FULL_TOKEN" "{}"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "cleanup: application rate target deleted" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

request GET "item_derivation_sources?rule_item_id=eq.$RULE_ITEM_ID" "$FULL_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "cleanup: derivation source cascaded away with its rule" "200, []" "$ok" "$STATUS $BODY_OUT"

# correct_only holds manage_members but has never been added to this
# contract by anyone — seeing it at all is the widened contracts_select_
# member (0028) actually doing something, not is_member() coincidentally
# already covering it (readonly's global_role would have).
request GET "contracts?select=id&id=eq.$ADMIN_CONTRACT_ID" "$CORRECT_ONLY_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "correct_only: sees PROBE-ADMIN contract despite no membership (manage_members, 0028)" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

# Same widening one table over (0029) — seeing who's already seated,
# before seating anyone else, needs contract_members visible too.
request GET "contract_members?select=user_id&contract_id=eq.$ADMIN_CONTRACT_ID" "$CORRECT_ONLY_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  n=$(json_len "$BODY_OUT")
  [ "$n" != "-1" ] && [ "$n" -ge 1 ] 2>/dev/null && ok=1
fi
check "correct_only: sees PROBE-ADMIN's members despite no membership (manage_members, 0029)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

# viewer holds no manage_members — cannot seat anyone, on this contract or
# any other.
request POST "contract_members" "$VIEWER_TOKEN" \
  "{\"contract_id\":\"$ADMIN_CONTRACT_ID\",\"user_id\":\"$VIEWER_ID\",\"view_rates\":true}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "viewer: seat a member rejected (no manage_members)" "403" "$ok" "$STATUS $BODY_OUT"

# correct_only seats viewer with EXACTLY view_rates true. Plain INSERT, not
# an upsert: contract_members' own column-scoped UPDATE grant (0017) covers
# only the nine boolean right columns, not contract_id/user_id — an
# on_conflict upsert's SET clause includes every submitted column
# (including the two conflict-target ones), so it 403s for the same reason
# the contracts upsert above did. A rerun's 409 (already seated from a
# prior run) is treated as success, re-fetched via GET rather than assumed.
request POST "contract_members" "$CORRECT_ONLY_TOKEN" \
  "{\"contract_id\":\"$ADMIN_CONTRACT_ID\",\"user_id\":\"$VIEWER_ID\",\"view_rates\":true}"
ok=0
if [ "$STATUS" = "201" ]; then
  vr=$(json_field "$BODY_OUT" 0 view_rates)
  [ "$vr" = "True" ] || [ "$vr" = "true" ] && ok=1
elif [ "$STATUS" = "409" ]; then
  request GET "contract_members?select=view_rates&contract_id=eq.$ADMIN_CONTRACT_ID&user_id=eq.$VIEWER_ID" "$CORRECT_ONLY_TOKEN"
  if [ "$STATUS" = "200" ]; then
    vr=$(json_field "$BODY_OUT" 0 view_rates)
    [ "$vr" = "True" ] || [ "$vr" = "true" ] && ok=1
  fi
fi
check "correct_only: seat viewer with exactly view_rates (manage_members)" "201 (or 409 on rerun), view_rates=true" "$ok" "$STATUS $BODY_OUT"

# A single-column PATCH adds extract_report WITHOUT disturbing view_rates —
# the actual "never a wholesale rewrite" property this whole feature exists
# to guarantee, checked directly: both rights present after touching only
# one of them.
request PATCH "contract_members?contract_id=eq.$ADMIN_CONTRACT_ID&user_id=eq.$VIEWER_ID" "$CORRECT_ONLY_TOKEN" '{"extract_report": true}'
ok=0
if [ "$STATUS" = "200" ]; then
  vr=$(json_field "$BODY_OUT" 0 view_rates)
  er=$(json_field "$BODY_OUT" 0 extract_report)
  [ "$vr" = "True" ] || [ "$vr" = "true" ] && { [ "$er" = "True" ] || [ "$er" = "true" ]; } && ok=1
fi
check "correct_only: adding extract_report leaves view_rates untouched (single-column PATCH)" "200, both true" "$ok" "$STATUS $BODY_OUT"

# find_profile_by_email (0028) — same wall, same shape.
request POST "rpc/find_profile_by_email" "$VIEWER_TOKEN" '{"p_email":"field@novacore.test"}'
ok=0; case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
check "viewer: find_profile_by_email rejected (no manage_members)" ">=400" "$ok" "$STATUS $BODY_OUT"

request POST "rpc/find_profile_by_email" "$CORRECT_ONLY_TOKEN" '{"p_email":"field@novacore.test"}'
ok=0
if [ "$STATUS" = "200" ]; then
  found_id=$(json_field "$BODY_OUT" 0 id)
  [ "$found_id" = "$QUANTITIES_ID" ] && ok=1
fi
check "correct_only: find_profile_by_email resolves a known address (manage_members)" "200, id=$QUANTITIES_ID" "$ok" "$STATUS $BODY_OUT"

request POST "rpc/find_profile_by_email" "$CORRECT_ONLY_TOKEN" '{"p_email":"nobody-real-probe@keywestasphalt.com"}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "correct_only: find_profile_by_email returns empty, not an error, for no account" "200, []" "$ok" "$STATUS $BODY_OUT"

echo
echo "=== Preservation, not just denial (rights regression on Hwy 97C) ==="
# Every probe above proves the wall holds (a right-less seat is denied) or
# that a fixture WITH a right succeeds. None of them prove a right present
# before a change is still present after it — which is exactly how 60/60
# stayed green while seed_demo_contract.sql was silently deleting real
# grants on every rerun. The creator seat on the sandbox contract can't
# close this gap: seed_demo_contract.sql unconditionally RE-GRANTS it every
# right on every run, by design, so it is structurally immune to this class
# of failure and would pass even if the rerun had just destroyed someone
# else's row. correct_only's Hwy 97C membership is the opposite on purpose
# — granted once, on_conflict do nothing, in seed_demo_contract.sql, never
# re-asserted. If a future migration or seed rerun ever touches it, this
# probe is what turns that into a red line instead of a silent loss.

request GET "contract_members?select=contract_id,contracts!inner(contract_no)&contracts.contract_no=eq.26914-0000&user_id=eq.$CORRECT_ONLY_ID" "$CORRECT_ONLY_TOKEN"
DEMO_CONTRACT_ID=$(json_field "$BODY_OUT" 0 contract_id)
if [ -z "$DEMO_CONTRACT_ID" ]; then
  echo "FATAL: correct_only is not seated on the Hwy 97C demo contract — seed_demo_contract.sql's preservation-fixture grant is missing, cannot run this probe" >&2
  exit 1
fi

request GET "contract_members?select=create_items,set_cost,set_unit_price,enter_quantity,correct_quantity,confirm_quantity,view_rates,extract_report,manage_schedule,record_actual_cost&contract_id=eq.$DEMO_CONTRACT_ID&user_id=eq.$CORRECT_ONLY_ID" "$CORRECT_ONLY_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  exact=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
expected = {
  'create_items': False, 'set_cost': False, 'set_unit_price': False,
  'enter_quantity': True, 'correct_quantity': False, 'confirm_quantity': False,
  'view_rates': True, 'extract_report': False,
  'manage_schedule': False, 'record_actual_cost': False,
}
print('1' if len(d) == 1 and d[0] == expected else '0')
" "$BODY_OUT")
  [ "$exact" = "1" ] && ok=1
fi
check "correct_only: Hwy 97C rights are EXACTLY {enter_quantity, view_rates} — survived every rerun" "exact match" "$ok" "$STATUS $BODY_OUT"

echo
echo "=== Positive controls ==="

request GET "v_item_progress?select=*" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "quantities: v_item_progress returns rows" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

request GET "item_prices?select=*&limit=1" "$VIEWER_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "viewer: item_prices returns rows (view_rates)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

# Membership grants visibility and nothing else: readonly has ZERO rights
# but is still a seated member, so quantities must still be visible.
request GET "quantity_records?select=id&limit=1" "$READONLY_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "readonly: quantity_records still visible (membership, not a right)" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# readonly — zero rights, membership only. Every write must be rejected.
# =============================================================================
echo
echo "=== readonly seat: writes rejected ==="

READONLY_ENTRY_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$READONLY_TOKEN" \
  "{\"id\":\"$READONLY_ENTRY_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":1,\"created_by\":\"$READONLY_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "readonly: insert daily_entry rejected (no enter/correct_quantity)" "403" "$ok" "$STATUS $BODY_OUT"

request POST "items" "$READONLY_TOKEN" \
  "{\"contract_id\":\"$PROJECT_ID\",\"item_number\":\"PROBE-READONLY\",\"description\":\"should not insert\",\"unit\":\"Each\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "readonly: insert item rejected (no create_items)" "403" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# viewer — view_rates + extract_report only. Can read prices, cannot write
# anything (no per-project write right at all).
# =============================================================================
echo
echo "=== viewer seat: writes rejected despite seeing prices ==="

VIEWER_ENTRY_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$VIEWER_TOKEN" \
  "{\"id\":\"$VIEWER_ENTRY_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":1,\"created_by\":\"$FULL_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "viewer: insert daily_entry rejected" "403" "$ok" "$STATUS $BODY_OUT"

request PATCH "item_prices?item_id=eq.$LINE_ITEM_ID" "$VIEWER_TOKEN" '{"cost_price": 1}'
# item_prices has a table-level UPDATE grant (0002) — the gate is the
# RLS USING clause, not a missing grant, so a policy failure here surfaces
# as 200 with zero matched rows, not 403 (403 is INSERT's WITH CHECK
# failure mode; UPDATE's is "no matching row"). Same pattern as the
# quantities status-update check above.
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "viewer: update item_prices rejected (view_rates != set_cost/set_unit_price)" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# quantities write path — enter_quantity covers an ORIGINAL entry only.
# =============================================================================
echo
echo "=== quantities write path ==="

ENTRY_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$QUANTITIES_TOKEN" \
  "{\"id\":\"$ENTRY_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":10,\"station_from\":2090,\"station_to\":2091,\"created_by\":\"$QUANTITIES_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "201" ] && ok=1
check "quantities: insert original entry (supersedes null)" "201" "$ok" "$STATUS $BODY_OUT"

# 0021: a still-draft record is editable in place by its own author, same as
# any other enter_quantity seat — see the dedicated draft-edit section below
# for the "not just the author" and "not once confirmed" proofs.
request PATCH "quantity_records?id=eq.$ENTRY_ID" "$QUANTITIES_TOKEN" '{"quantity": 999}'
ok=0
if [ "$STATUS" = "200" ]; then
  q=$(json_field "$BODY_OUT" 0 quantity)
  [ "$q" = "999" ] && ok=1
fi
check "quantities: edit own draft quantity in place (enter_quantity, 0021)" "200, quantity=999" "$ok" "$STATUS $BODY_OUT"

# 0022: there is no longer a plain PATCH path to confirmed at all — the
# grant for status/confirmed_by/confirmed_at was revoked outright, so this
# now fails at the GRANT level regardless of rights, before RLS is even
# reached. Confirming only ever happens through confirm_quantity_record().
request PATCH "quantity_records?id=eq.$ENTRY_ID" "$QUANTITIES_TOKEN" '{"status": "confirmed"}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: plain PATCH to confirmed rejected outright (0022 grant revoked)" "403" "$ok" "$STATUS $BODY_OUT"

# Not just for a seat lacking the right — even FULL, who DOES hold
# confirm_quantity, cannot use the old plain-PATCH path anymore. This is the
# actual proof that the guarantee moved to Postgres: it isn't gated by rights
# at this layer at all, the path itself no longer exists for anyone.
request PATCH "quantity_records?id=eq.$ENTRY_ID" "$FULL_TOKEN" '{"status": "confirmed"}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "full: plain PATCH to confirmed rejected too (0022 — no rights-based path left)" "403" "$ok" "$STATUS $BODY_OUT"

# And via the RPC: quantities still can't confirm, right or version aside —
# has_right(confirm_quantity) is checked explicitly inside the function
# (SECURITY DEFINER bypasses RLS, so this check is NOT optional there).
request GET "quantity_records?select=version&id=eq.$ENTRY_ID" "$QUANTITIES_TOKEN"
ENTRY_VERSION=$(json_field "$BODY_OUT" 0 version)
request POST "rpc/confirm_quantity_record" "$QUANTITIES_TOKEN" \
  "{\"p_id\":\"$ENTRY_ID\",\"p_expected_version\":$ENTRY_VERSION}"
ok=0
case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
[ "$ok" = "1" ] && { printf '%s' "$BODY_OUT" | grep -q "not-permitted" || ok=0; }
check "quantities: confirm via RPC rejected (no confirm_quantity)" ">=400, not-permitted" "$ok" "$STATUS $BODY_OUT"

OTHER_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$QUANTITIES_TOKEN" \
  "{\"id\":\"$OTHER_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":5,\"created_by\":\"$FULL_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: insert with wrong created_by rejected" "403" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Draft editing (0021) — editable in place while unconfirmed, gated on
# enter_quantity (not correct_quantity), and NOT scoped to the row's own
# author: "any seat holding enter_quantity on that contract may edit any
# draft on it — not only its author." full creates the draft here so the
# edit below is genuinely done by someone other than its creator.
# =============================================================================
echo
echo "=== Draft editing (0021) — enter_quantity, any author, blocked the instant it's confirmed ==="

SHARED_DRAFT_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$FULL_TOKEN" \
  "{\"id\":\"$SHARED_DRAFT_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":50,\"created_by\":\"$FULL_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "201" ] && ok=1
check "full: insert a shared draft (created_by = full)" "201" "$ok" "$STATUS $BODY_OUT"

# quantities is NOT this row's author, and holds enter_quantity — the edit
# must still succeed, proving the right is what's checked, not authorship.
request PATCH "quantity_records?id=eq.$SHARED_DRAFT_ID" "$QUANTITIES_TOKEN" '{"quantity": 51}'
ok=0
if [ "$STATUS" = "200" ]; then
  q=$(json_field "$BODY_OUT" 0 quantity)
  [ "$q" = "51" ] && ok=1
fi
check "quantities: edit ANOTHER seat's draft (enter_quantity, not the author)" "200, quantity=51" "$ok" "$STATUS $BODY_OUT"

# correct_only holds correct_quantity but not enter_quantity — editing a
# draft is explicitly an enter_quantity action per the brief, so this must
# be excluded by RLS (0 rows visible), not merely denied for some other
# reason.
request PATCH "quantity_records?id=eq.$SHARED_DRAFT_ID" "$CORRECT_ONLY_TOKEN" '{"quantity": 999}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "correct_only: edit a draft rejected (correct_quantity is not enter_quantity)" "200, []" "$ok" "$STATUS $BODY_OUT"

# readonly holds neither right at all.
request PATCH "quantity_records?id=eq.$SHARED_DRAFT_ID" "$READONLY_TOKEN" '{"quantity": 999}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "readonly: edit a draft rejected (no enter_quantity)" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# direction/LKI/average_width/area — the five columns added on top of
# draft-editing/append-only/witnessed-version. Not new mechanisms, the SAME
# ones proven above, re-run against fields that didn't exist when those
# mechanisms were first built — the exact risk flagged before writing that
# migration: a column left out of guard_entry_transitions()'s row(...) lists
# would be silently unprotected regardless of how solid the six original
# columns' coverage is.
# =============================================================================
echo
echo "=== direction/LKI/average_width/area — new columns share the existing guards, not exempt from them ==="

# A record with all five entirely absent must still insert — nothing here
# may ever block entry of a record that lacks them (historical records,
# point work, count-measured Items).
BARE_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$FULL_TOKEN" \
  "{\"id\":\"$BARE_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":1,\"created_by\":\"$FULL_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "201" ] && ok=1
check "full: insert with direction/LKI/width/area all absent still succeeds" "201" "$ok" "$STATUS $BODY_OUT"

# quantity_records_lki_pair — a version without a segment means nothing
# (which segment does it version?), same asymmetric shape as station_pair's
# own "a to needs a from."
LKI_BAD_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$FULL_TOKEN" \
  "{\"id\":\"$LKI_BAD_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":1,\"lki_version\":2,\"created_by\":\"$FULL_ID\",\"device_id\":\"probe-rls\"}"
ok=0
case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
check "full: lki_version without lki_segment rejected (quantity_records_lki_pair)" ">=400" "$ok" "$STATUS $BODY_OUT"

# A draft edit touching ONLY a new field (no change to any of the original
# six) must still bump version — proving all five new columns are actually
# wired into guard_entry_transitions()'s row(...) comparison, not just the
# pre-existing set.
NEW_FIELD_DRAFT_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$FULL_TOKEN" \
  "{\"id\":\"$NEW_FIELD_DRAFT_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":1,\"created_by\":\"$FULL_ID\",\"device_id\":\"probe-rls\"}"
NEW_FIELD_DRAFT_VERSION_BEFORE=$(json_field "$BODY_OUT" 0 version)

request PATCH "quantity_records?id=eq.$NEW_FIELD_DRAFT_ID" "$QUANTITIES_TOKEN" '{"direction": "NBL", "lki_segment": 2090, "lki_version": 1, "average_width": 5.5, "area": 15345}'
ok=0
if [ "$STATUS" = "200" ]; then
  v=$(json_field "$BODY_OUT" 0 version)
  dir=$(json_field "$BODY_OUT" 0 direction)
  [ "$v" -gt "$NEW_FIELD_DRAFT_VERSION_BEFORE" ] 2>/dev/null && [ "$dir" = "NBL" ] && ok=1
fi
check "quantities: draft edit touching ONLY new fields still bumps version" "200, version incremented, direction=NBL" "$ok" "$STATUS $BODY_OUT"

# Confirm it, then confirm the new fields are just as append-only as the
# original six — matches 0 rows via RLS, same shape as every other confirmed-
# row-edit-attempt in this suite (0022 removed the applicable policy
# entirely; there's no route left for PostgREST to even reach the trigger).
request GET "quantity_records?select=version&id=eq.$NEW_FIELD_DRAFT_ID" "$FULL_TOKEN"
NEW_FIELD_DRAFT_VERSION=$(json_field "$BODY_OUT" 0 version)
request POST "rpc/confirm_quantity_record" "$FULL_TOKEN" \
  "{\"p_id\":\"$NEW_FIELD_DRAFT_ID\",\"p_expected_version\":$NEW_FIELD_DRAFT_VERSION}"
ok=0; [ "$STATUS" = "200" ] && [ "$(obj_field "$BODY_OUT" status)" = "confirmed" ] && ok=1
check "full: confirm the new-fields draft" "200, status=confirmed" "$ok" "$STATUS $BODY_OUT"

request PATCH "quantity_records?id=eq.$NEW_FIELD_DRAFT_ID" "$FULL_TOKEN" '{"average_width": 6.0}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "full: average_width edit on confirmed entry matches 0 rows — append-only covers the new columns too" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Confirmation requires a witnessed version (0022). SHARED_DRAFT_ID has been
# edited once already (quantity -> 51 above), so its version has moved past
# 1 — confirming with the version from BEFORE that edit must be rejected as
# stale, not silently confirm whatever is current. Read the current version
# fresh rather than assume the exact bump arithmetic.
# =============================================================================
request GET "quantity_records?select=version&id=eq.$SHARED_DRAFT_ID" "$FULL_TOKEN"
SHARED_DRAFT_VERSION=$(json_field "$BODY_OUT" 0 version)

# Confirming with version 1 (the value read before the edit above) must fail
# — this is the exact scenario the brief describes: an edit landed between
# a read and a confirm attempt.
request POST "rpc/confirm_quantity_record" "$FULL_TOKEN" \
  "{\"p_id\":\"$SHARED_DRAFT_ID\",\"p_expected_version\":1}"
ok=0
case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
[ "$ok" = "1" ] && { printf '%s' "$BODY_OUT" | grep -q "stale-version" || ok=0; }
check "full: confirm with a stale (pre-edit) version rejected" ">=400, stale-version" "$ok" "$STATUS $BODY_OUT"

# Confirming with the CURRENT version, but by a seat lacking confirm_quantity,
# is still rejected — a correct version does not substitute for the right.
request POST "rpc/confirm_quantity_record" "$QUANTITIES_TOKEN" \
  "{\"p_id\":\"$SHARED_DRAFT_ID\",\"p_expected_version\":$SHARED_DRAFT_VERSION}"
ok=0
case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
[ "$ok" = "1" ] && { printf '%s' "$BODY_OUT" | grep -q "not-permitted" || ok=0; }
check "quantities: confirm with the correct version still rejected (no confirm_quantity)" ">=400, not-permitted" "$ok" "$STATUS $BODY_OUT"

# The current version, by a seat that DOES hold confirm_quantity, succeeds —
# this IS the version that was actually last read, so it's a witnessed
# confirmation, not a blind one.
request POST "rpc/confirm_quantity_record" "$FULL_TOKEN" \
  "{\"p_id\":\"$SHARED_DRAFT_ID\",\"p_expected_version\":$SHARED_DRAFT_VERSION}"
ok=0
if [ "$STATUS" = "200" ]; then
  st=$(obj_field "$BODY_OUT" status)
  [ "$st" = "confirmed" ] && ok=1
fi
check "full: confirm the shared draft with the current version (0022)" "200, status=confirmed" "$ok" "$STATUS $BODY_OUT"

# Confirming AGAIN — same version, now stale in a different way: the row
# isn't a draft anymore at all. Distinct diagnosis from "stale-version".
request POST "rpc/confirm_quantity_record" "$FULL_TOKEN" \
  "{\"p_id\":\"$SHARED_DRAFT_ID\",\"p_expected_version\":$SHARED_DRAFT_VERSION}"
ok=0
case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
[ "$ok" = "1" ] && { printf '%s' "$BODY_OUT" | grep -q "already-confirmed" || ok=0; }
check "full: re-confirming an already-confirmed record rejected" ">=400, already-confirmed" "$ok" "$STATUS $BODY_OUT"

# Same seat, same right, same row — now rejected purely because status
# changed underneath it. Proves the edit policy is status-gated, not a
# standing grant that enter_quantity alone would otherwise satisfy forever.
request PATCH "quantity_records?id=eq.$SHARED_DRAFT_ID" "$QUANTITIES_TOKEN" '{"quantity": 52}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: edit rejected once confirmed (enter_quantity is no longer enough)" "200, []" "$ok" "$STATUS $BODY_OUT"

# Explicit brief requirement: correct_quantity does not open this door either,
# confirmed or not.
request PATCH "quantity_records?id=eq.$SHARED_DRAFT_ID" "$CORRECT_ONLY_TOKEN" '{"quantity": 999}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "correct_only: edit rejected once confirmed (correct_quantity never opens this path)" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# THE PAIR: enter_quantity vs correct_quantity, separately gated. This is
# the check a role-shaped suite could not express at all — no old role ever
# had correct_quantity without enter_quantity.
# =============================================================================
echo
echo "=== correct_only seat: enter_quantity and correct_quantity are separate ==="

CORRECT_ONLY_ORIGINAL_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$CORRECT_ONLY_TOKEN" \
  "{\"id\":\"$CORRECT_ONLY_ORIGINAL_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":1,\"created_by\":\"$CORRECT_ONLY_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "correct_only: insert ORIGINAL entry rejected (no enter_quantity)" "403" "$ok" "$STATUS $BODY_OUT"

CORRECTION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$CORRECT_ONLY_TOKEN" \
  "{\"id\":\"$CORRECTION_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":11,\"station_from\":2090,\"station_to\":2091,\"supersedes\":\"$ENTRY_ID\",\"created_by\":\"$CORRECT_ONLY_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "201" ] && ok=1
check "correct_only: insert CORRECTION entry succeeds (correct_quantity, supersedes set)" "201" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Confirmation + append-only guards, full seat (0003, 0004) — full holds
# confirm_quantity; quantities and correct_only do not (already proven above).
# =============================================================================
echo
echo "=== Confirmation guards (full seat) ==="

# 0022: confirming goes through the RPC now, with the version last read.
# ENTRY_ID hasn't been touched since it was edited to quantity 999 above —
# read its current version fresh rather than assume the exact number.
request GET "quantity_records?select=version&id=eq.$ENTRY_ID" "$FULL_TOKEN"
ENTRY_VERSION=$(json_field "$BODY_OUT" 0 version)

request POST "rpc/confirm_quantity_record" "$FULL_TOKEN" \
  "{\"p_id\":\"$ENTRY_ID\",\"p_expected_version\":$ENTRY_VERSION}"
ok=0
if [ "$STATUS" = "200" ]; then
  cb=$(obj_field "$BODY_OUT" confirmed_by)
  ca=$(obj_field "$BODY_OUT" confirmed_at)
  st=$(obj_field "$BODY_OUT" status)
  [ "$st" = "confirmed" ] && [ "$cb" = "$FULL_ID" ] && [ -n "$ca" ] && ok=1
fi
check "full: confirm via RPC stamps confirmed_by/confirmed_at" "status=confirmed, confirmed_by=$FULL_ID" "$ok" "$STATUS $BODY_OUT"

# 0022: there's no remaining path to spoof confirmed_by/confirmed_at at
# all — the RPC's own signature is (id, expected_version), nothing else, and
# the plain PATCH path that the old spoof/backdate test exercised is gone
# (grant revoked). Confirming this now means checking the surface doesn't
# exist, not that it's overridden when reached.
request PATCH "quantity_records?id=eq.$ENTRY_ID" "$FULL_TOKEN" "{\"confirmed_by\":\"$READONLY_ID\",\"confirmed_at\":\"2020-01-01T00:00:00Z\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "full: plain PATCH to confirmed_by/confirmed_at rejected outright (0022, no such path)" "403" "$ok" "$STATUS $BODY_OUT"

# Same for un-confirming — the grant covers status too, so this fails before
# reaching guard_entry_transitions' own un-confirm guard at all now (that
# guard still exists and is exercised directly via SQL below, since this is
# no longer the layer that reaches it).
request PATCH "quantity_records?id=eq.$ENTRY_ID" "$FULL_TOKEN" '{"status": "draft"}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "full: un-confirm rejected outright (0022 grant, not the trigger)" "403" "$ok" "$STATUS $BODY_OUT"

# Re-confirming rejected — same shape proven on SHARED_DRAFT_ID above,
# repeated here since ENTRY_ID took a different path to get confirmed
# (single-shot RPC vs. the version-mismatch sequence above).
request POST "rpc/confirm_quantity_record" "$FULL_TOKEN" \
  "{\"p_id\":\"$ENTRY_ID\",\"p_expected_version\":$ENTRY_VERSION}"
ok=0
case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
[ "$ok" = "1" ] && { printf '%s' "$BODY_OUT" | grep -q "already-confirmed" || ok=0; }
check "full: re-confirming ENTRY_ID rejected" ">=400, already-confirmed" "$ok" "$STATUS $BODY_OUT"

# 0022 removed quantity_records_confirm_right entirely — a confirmed row now
# has NO applicable permissive UPDATE policy at all (quantity_records_edit_
# draft_right requires status = 'draft'), so an attempt to touch ANY column
# on it, by ANY seat, is excluded at USING and matches 0 rows — the same
# "200, []" shape this suite already uses for every other no-matching-right
# case, not a trigger-raised exception anymore. The trigger's append-only
# branch still exists and still holds — proven directly via SQL below,
# since ordinary PostgREST can no longer reach a confirmed row for UPDATE
# at all, right or no right.
request PATCH "quantity_records?id=eq.$ENTRY_ID" "$FULL_TOKEN" '{"station_from": 3000}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "full: station_from edit on confirmed entry matches 0 rows (0022 — no policy admits it)" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Company-wide rights don't leak from per-project ones. full has every
# per-project right on this project and still can't create a company-wide
# project — create_projects is a separate flag on profiles, never implied.
# =============================================================================
echo
echo "=== full seat: per-project rights don't imply company-wide ones ==="

NEW_PROJECT_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "contracts" "$FULL_TOKEN" \
  "{\"id\":\"$NEW_PROJECT_ID\",\"contract_name\":\"should not be created\",\"created_by\":\"$FULL_ID\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "full: insert project rejected (no create_projects)" "403" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# tender_price (0035) — gated the same as Rates' own edit surface (set_cost
# AND set_unit_price both), not a new right. Readable by any member
# regardless of rights (same posture as contract_no/contract_name); only the
# WRITE is rights-gated here.
# =============================================================================
echo
echo "=== tender_price (0035) ==="

request PATCH "contracts?id=eq.$PROJECT_ID" "$FULL_TOKEN" '{"tender_price":15739126.37}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" != "0" ] && ok=1
check "full: set tender_price (set_cost + set_unit_price)" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

# quantities holds neither set_cost nor set_unit_price on this project —
# USING passes on some other permissive policy for this row (is_member
# alone), so this is the same "matches 0 rows, not 403" shape as every other
# split-right column-grant check in this file, not an error.
request PATCH "contracts?id=eq.$PROJECT_ID" "$QUANTITIES_TOKEN" '{"tender_price":1}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: set tender_price rejected (no set_cost/set_unit_price)" "200, []" "$ok" "$STATUS $BODY_OUT"

# view_rates alone (viewer) isn't enough either — reading Rates and pricing
# the contract are different permissions, same split canEdit already draws
# in RatesScreen itself.
request PATCH "contracts?id=eq.$PROJECT_ID" "$VIEWER_TOKEN" '{"tender_price":1}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "viewer: set tender_price rejected (view_rates alone is not enough)" "200, []" "$ok" "$STATUS $BODY_OUT"

# Any member can still READ it regardless of rights — the column-grant
# above only restricts UPDATE, and there's no column-scoped SELECT grant to
# narrow this any further than the row-level policy already does.
request GET "contracts?id=eq.$PROJECT_ID&select=tender_price" "$QUANTITIES_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_field "$BODY_OUT" 0 tender_price)" = "15739126.37" ] && ok=1
check "quantities: read tender_price (view alone needs no rights)" "200, 15739126.37" "$ok" "$STATUS $BODY_OUT"

# Revert — this project is a shared fixture across the whole suite, and
# tender_price isn't part of its baseline seed.
request PATCH "contracts?id=eq.$PROJECT_ID" "$FULL_TOKEN" '{"tender_price":null}'
check "cleanup: tender_price reverted to null" "200, 1 row" "$([ "$STATUS" = "200" ] && echo 1 || echo 0)" "$STATUS $BODY_OUT"

# =============================================================================
# contract_state — gated on manage_members (company-wide), same right
# SeatMembers already requires to administer a contract, not a new
# decision. correct_only holds manage_members but none of full's
# per-project rights, isolating that manage_members alone is what gates
# this, not set_cost/set_unit_price/anything project-scoped. Readable by
# any member regardless of rights, same posture as tender_price above.
# =============================================================================
echo
echo "=== contract_state ==="

request PATCH "contracts?id=eq.$PROJECT_ID" "$CORRECT_ONLY_TOKEN" '{"contract_state":"warranty_period"}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" != "0" ] && ok=1
check "correct_only: set contract_state (manage_members)" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

request PATCH "contracts?id=eq.$PROJECT_ID" "$VIEWER_TOKEN" '{"contract_state":"archived"}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "viewer: set contract_state rejected (no manage_members)" "200, []" "$ok" "$STATUS $BODY_OUT"

request PATCH "contracts?id=eq.$PROJECT_ID" "$CORRECT_ONLY_TOKEN" '{"contract_state":"not_a_real_state"}'
ok=0; [ "$STATUS" -ge 400 ] && ok=1
check "correct_only: invalid contract_state value rejected" ">=400" "$ok" "$STATUS $BODY_OUT"

request GET "contracts?id=eq.$PROJECT_ID&select=contract_state" "$VIEWER_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_field "$BODY_OUT" 0 contract_state)" = "warranty_period" ] && ok=1
check "viewer: read contract_state (no rights needed to read)" "200, warranty_period" "$ok" "$STATUS $BODY_OUT"

# Revert — this project is a shared fixture across the whole suite.
request PATCH "contracts?id=eq.$PROJECT_ID" "$CORRECT_ONLY_TOKEN" '{"contract_state":"active"}'
check "cleanup: contract_state reverted to active" "200, 1 row" "$([ "$STATUS" = "200" ] && echo 1 || echo 0)" "$STATUS $BODY_OUT"

# =============================================================================
# contract_state_history — trigger-only writes, is_member()-only reads.
# Deliberately NOT gated on any right (unlike item_price_history's
# view_rates): contract_state itself has no right-gated SELECT policy
# either (contracts_select_member is is_member() alone), so its history
# reads on the same terms. quantities holds neither manage_members nor
# view_rates on PROJECT_ID — a member with no special right at all — the
# exact seat that proves membership alone is sufficient. correct_only is
# NOT seated on ADMIN_CONTRACT_ID at all (see the Admin section above,
# "sees PROBE-ADMIN contract despite no membership") — despite holding
# manage_members and being able to see that contract's row and roster via
# the OTHER, deliberately widened policies, it has no widened path into
# THIS table, which is the point: history follows membership, not a
# company-wide right.
# =============================================================================
echo
echo "=== contract_state_history ==="

# Baseline count before the real change below.
request GET "contract_state_history?select=id&contract_id=eq.$PROJECT_ID" "$QUANTITIES_TOKEN"
before_count=$(json_len "$BODY_OUT")

# A non-state update must not log anything.
request PATCH "contracts?id=eq.$PROJECT_ID" "$CORRECT_ONLY_TOKEN" '{"tender_price": 4242}'
request GET "contract_state_history?select=id&contract_id=eq.$PROJECT_ID" "$QUANTITIES_TOKEN"
ok=0; [ "$before_count" != "-1" ] && [ "$(json_len "$BODY_OUT")" = "$before_count" ] && ok=1
check "correct_only: a non-state update to contracts logs nothing" "history row count unchanged" "$ok" "before=$before_count after=$(json_len "$BODY_OUT")"
request PATCH "contracts?id=eq.$PROJECT_ID" "$CORRECT_ONLY_TOKEN" '{"tender_price": null}'

# A real state change logs old -> new.
request PATCH "contracts?id=eq.$PROJECT_ID" "$CORRECT_ONLY_TOKEN" '{"contract_state":"warranty_period"}'
request GET "contract_state_history?select=old_state,new_state&contract_id=eq.$PROJECT_ID&order=changed_at.desc&limit=1" "$QUANTITIES_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  os=$(json_field "$BODY_OUT" 0 old_state)
  ns=$(json_field "$BODY_OUT" 0 new_state)
  [ "$os" = "active" ] && [ "$ns" = "warranty_period" ] && ok=1
fi
check "quantities: contract_state_history captured old->new (membership alone, no right needed)" "200, active->warranty_period" "$ok" "$STATUS $BODY_OUT"

# Re-sending the same value must not add a second row.
request GET "contract_state_history?select=id&contract_id=eq.$PROJECT_ID" "$QUANTITIES_TOKEN"
mid_count=$(json_len "$BODY_OUT")
request PATCH "contracts?id=eq.$PROJECT_ID" "$CORRECT_ONLY_TOKEN" '{"contract_state":"warranty_period"}'
request GET "contract_state_history?select=id&contract_id=eq.$PROJECT_ID" "$QUANTITIES_TOKEN"
ok=0; [ "$mid_count" != "-1" ] && [ "$(json_len "$BODY_OUT")" = "$mid_count" ] && ok=1
check "correct_only: re-sending the same contract_state logs no new row" "history row count unchanged" "$ok" "before=$mid_count after=$(json_len "$BODY_OUT")"

# Revert, per the shared-fixture convention above.
request PATCH "contracts?id=eq.$PROJECT_ID" "$CORRECT_ONLY_TOKEN" '{"contract_state":"active"}'
check "cleanup: contract_state reverted to active (post-history probes)" "200, 1 row" "$([ "$STATUS" = "200" ] && echo 1 || echo 0)" "$STATUS $BODY_OUT"

# No direct write path exists for anyone — full holds every per-project
# right and still can't reach this table directly.
request POST "contract_state_history" "$FULL_TOKEN" \
  "{\"contract_id\":\"$PROJECT_ID\",\"old_state\":\"active\",\"new_state\":\"archived\"}"
ok=0; [ "$STATUS" -ge 400 ] 2>/dev/null && ok=1
check "full: direct insert into contract_state_history rejected (trigger-only writes)" ">=400" "$ok" "$STATUS $BODY_OUT"

# correct_only is not seated on ADMIN_CONTRACT_ID — the read gate is
# membership, not manage_members, so it sees nothing here even though the
# OTHER, deliberately widened Admin policies let it see that contract's
# row and roster.
request GET "contract_state_history?select=*&contract_id=eq.$ADMIN_CONTRACT_ID" "$CORRECT_ONLY_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "correct_only: contract_state_history invisible on a contract it isn't seated on" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Privileged-path checks — a different layer, tested separately on purpose.
# Unaffected by the rights rewrite: these exercise guard_entry_transitions()
# directly at the postgres role, below PostgREST's grant system entirely.
#
# Since 0022, a confirmed row has NO applicable UPDATE policy left via
# PostgREST at all (quantity_records_confirm_right is gone, and edit_draft_
# right requires status = 'draft'), and the plain status/confirmed_by/
# confirmed_at grant is revoked outright — so guard_entry_transitions()'s
# append-only, un-confirm, and attribution-pinning branches are no longer
# reachable from an ordinary seat by ANY route, right or no right. This
# section is now the ONLY place left that actually exercises those specific
# branches: service_role scripts, RPCs, security-definer functions, anyone
# in psql. Optional: needs SUPABASE_DB_PASSWORD and a `supabase` CLI already
# linked to this repo (`supabase link --project-ref ...`); skipped, not
# failed, without it.
# =============================================================================
echo
echo "=== Privileged-path checks (postgres role, not a seat — different layer) ==="

if [ -z "${SUPABASE_DB_PASSWORD:-}" ] || ! command -v supabase >/dev/null 2>&1; then
  echo "SKIP  privileged-path checks — set SUPABASE_DB_PASSWORD and link the supabase CLI to run these"
else
  db_query() { supabase db query --linked "$1" 2>&1; }

  # The JSON emitted by `supabase db query` is one object embedded between
  # CLI chatter (login/update-notice lines); this pulls out just that block
  # rather than assuming stdout is pure JSON.
  db_rows() {
    python3 -c "
import sys, re, json
m = re.search(r'\{.*\}', sys.argv[1], re.DOTALL)
if not m:
    print('[]'); sys.exit(0)
try:
    print(json.dumps(json.loads(m.group(0)).get('rows', [])))
except Exception:
    print('[]')
" "$1"
  }

  PRIV_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

  setup_out=$(db_query "insert into quantity_records (id, contract_id, item_id, work_date, quantity, station_from, status, confirmed_by, confirmed_at, created_by, device_id) values ('$PRIV_ID', '$PROJECT_ID', '$LINE_ITEM_ID', current_date, 1234.5, 500, 'confirmed', '$FULL_ID', now(), '$QUANTITIES_ID', 'probe-rls-privileged') returning id;")
  setup_rows=$(db_rows "$setup_out")
  ok=0; [ "$(json_len "$setup_rows")" = "1" ] && ok=1
  check "setup: seed a confirmed row as postgres" "1 row inserted" "$ok" "$setup_out"

  qty_out=$(db_query "update quantity_records set quantity = 999 where id = '$PRIV_ID';")
  ok=0; printf '%s' "$qty_out" | grep -q "append-only" && ok=1
  check "postgres: quantity UPDATE on confirmed row rejected" "P0001 append-only" "$ok" "$qty_out"

  stn_out=$(db_query "update quantity_records set station_from = 99 where id = '$PRIV_ID';")
  ok=0; printf '%s' "$stn_out" | grep -q "append-only" && ok=1
  check "postgres: station_from UPDATE on confirmed row rejected" "P0001 append-only" "$ok" "$stn_out"

  verify_out=$(db_query "select quantity, station_from from quantity_records where id = '$PRIV_ID';")
  verify_rows=$(db_rows "$verify_out")
  qv=$(json_field "$verify_rows" 0 quantity)
  sv=$(json_field "$verify_rows" 0 station_from)
  ok=0; [ "$qv" = "1234.5" ] && [ "$sv" = "500" ] && ok=1
  check "postgres: row genuinely unchanged after both rejections" "quantity=1234.5, station_from=500" "$ok" "$verify_out"

  # Un-confirm — 0022 makes this unreachable from PostgREST at all (grant
  # revoked before RLS is even reached), so this is now the only place left
  # that actually exercises guard_entry_transitions()'s own un-confirm guard.
  unconfirm_out=$(db_query "update quantity_records set status = 'draft' where id = '$PRIV_ID';")
  ok=0; printf '%s' "$unconfirm_out" | grep -q "cannot be un-confirmed" && ok=1
  check "postgres: un-confirm on confirmed row rejected" "P0001 cannot be un-confirmed" "$ok" "$unconfirm_out"

  # Attribution pinning on re-touch — same reasoning: 0022 removed the only
  # PostgREST-reachable path to this branch (the plain PATCH confirm/re-touch
  # path), so this is the one place left proving a spoofed confirmed_by/
  # confirmed_at on an already-confirmed row is still silently overridden by
  # the trigger, not merely inaccessible.
  spoof_out=$(db_query "update quantity_records set status = 'confirmed', confirmed_by = '$READONLY_ID', confirmed_at = '2020-01-01T00:00:00Z' where id = '$PRIV_ID' returning confirmed_by, confirmed_at;")
  spoof_rows=$(db_rows "$spoof_out")
  cb=$(json_field "$spoof_rows" 0 confirmed_by)
  ca=$(json_field "$spoof_rows" 0 confirmed_at)
  ok=0
  case "$ca" in 2020*) ca_spoofed=1 ;; *) ca_spoofed=0 ;; esac
  [ "$cb" = "$FULL_ID" ] && [ "$ca_spoofed" = "0" ] && ok=1
  check "postgres: confirmed_by/confirmed_at spoof on re-touch still pinned" "confirmed_by=$FULL_ID, confirmed_at=now" "$ok" "$spoof_out"
fi

echo
echo "=== Per-user view preferences — a seat cannot read or write another seat's saved layout ==="

# Upsert, not a plain insert — this table has SELECT/INSERT/UPDATE grants
# for the owner but deliberately no DELETE (a saved layout is only ever
# replaced with a fresh default, never removed as a row), so a rerun of
# this probe has no DELETE path to clean up with. on_conflict alone isn't
# enough to make PostgREST actually MERGE on a genuine conflict — needs
# Prefer: resolution=merge-duplicates too (same finding as the jobs probe
# above) — so this one raw curl call bypasses the shared request() helper.
resp=$(curl -s -w '\n%{http_code}' -X POST "$SUPABASE_URL/rest/v1/user_view_preferences?on_conflict=user_id,scope" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $QUANTITIES_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "{\"user_id\":\"$QUANTITIES_ID\",\"scope\":\"overview_dashboard\",\"preferences\":{\"marginOn\":true}}")
STATUS=$(printf '%s' "$resp" | tail -n1)
BODY_OUT=$(printf '%s' "$resp" | sed '$d')
ok=0; { [ "$STATUS" = "201" ] || [ "$STATUS" = "200" ]; } && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "quantities: save own preferences row (no right needed — per-user, not per-contract)" "201/200, 1 row" "$ok" "$STATUS $BODY_OUT"

# A seat may only ever write its OWN row — the WITH CHECK (user_id =
# auth.uid()) is what's actually being proven here, not a contract right.
request POST "user_view_preferences" "$QUANTITIES_TOKEN" \
  "{\"user_id\":\"$READONLY_ID\",\"scope\":\"overview_dashboard\",\"preferences\":{}}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: insert with someone else's user_id rejected" "403" "$ok" "$STATUS $BODY_OUT"

# readonly saves its own row under the same scope — same table, different owner.
resp=$(curl -s -w '\n%{http_code}' -X POST "$SUPABASE_URL/rest/v1/user_view_preferences?on_conflict=user_id,scope" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $READONLY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "{\"user_id\":\"$READONLY_ID\",\"scope\":\"overview_dashboard\",\"preferences\":{\"marginOn\":false}}")
STATUS=$(printf '%s' "$resp" | tail -n1)
BODY_OUT=$(printf '%s' "$resp" | sed '$d')
ok=0; { [ "$STATUS" = "201" ] || [ "$STATUS" = "200" ]; } && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "readonly: save own preferences row" "201/200, 1 row" "$ok" "$STATUS $BODY_OUT"

# The one probe this table exists to have: a seat's select must not include
# another seat's row, even under the identical scope.
request GET "user_view_preferences?select=user_id&scope=eq.overview_dashboard" "$READONLY_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  contains_others=$(python3 -c "
import json, sys
ids = [r['user_id'] for r in json.loads(sys.argv[1])]
print('1' if '$QUANTITIES_ID' in ids else '0')
" "$BODY_OUT")
  [ "$contains_others" = "0" ] && ok=1
fi
check "readonly: select does not include quantities' preferences row" "quantities' row not present" "$ok" "$STATUS $BODY_OUT"

# Update is scoped the same way — a seat can update its own row...
request PATCH "user_view_preferences?user_id=eq.$READONLY_ID&scope=eq.overview_dashboard" "$READONLY_TOKEN" \
  "{\"preferences\":{\"marginOn\":true}}"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "1" ] && ok=1
check "readonly: update own preferences row" "200, 1 row" "$ok" "$STATUS $BODY_OUT"

# ...but not someone else's — matches 0 rows, not an error (RLS filters the
# UPDATE's own target set, same shape as every other own-row-only policy in
# this suite).
request PATCH "user_view_preferences?user_id=eq.$QUANTITIES_ID&scope=eq.overview_dashboard" "$READONLY_TOKEN" \
  "{\"preferences\":{\"marginOn\":false}}"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "readonly: update on quantities' preferences row matches 0 rows" "200, []" "$ok" "$STATUS $BODY_OUT"

# TODO: nothing here tests daily_entries_effective live against the database
# — the view holding the rule that a confirmed row leaves the placed total
# only when its replacement ENTERS it (supersession takes effect on
# confirmation, not on insertion; see 0001_foundation_schema.sql's own
# comment on the view). src/lib/calculations/effectiveEntries.test.ts now
# covers the RULE itself at the TypeScript level (added when the desktop
# dashboard math was factored into pure functions), but that's a client-side
# mirror, not a check against the live view's actual SQL — a regression in
# the view itself would still pass every Vitest test and still change money
# silently without violating any RLS policy here. Still belongs as a
# SQL-level check in this script. Not fixed now — noted so it's seen next
# time this file is touched.

echo
echo "=== Summary: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -eq 0 ]; then
  exit 0
else
  exit 1
fi
