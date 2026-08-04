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
# convenient bundle of rights happened to work:
#   quantities     enter_quantity + correct_quantity only      (old field)
#   full           every per-project right, no company-wide    (old pm)
#   viewer         view_rates + extract_report only            (old cfo)
#   readonly       seated, zero rights                         (old owner,
#                                                                repurposed)
#   correct_only   correct_quantity only, NOT enter_quantity   (new — no old
#                                                                role could
#                                                                express this)
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
#     spoof + backdate, attribution pinned on re-touch, un-confirm rejected)
#   - the station append-only check from 0004
#   - positive controls throughout — a suite that only ever asserts "empty"
#     or "rejected" passes just as well when authentication is silently
#     broken, which is the failure mode most likely to fool a human skimming
#     curl output
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
VIEWER_TOKEN="${VIEWER_AUTH%%|*}"
READONLY_TOKEN="${READONLY_AUTH%%|*}"; READONLY_ID="${READONLY_AUTH##*|}"
CORRECT_ONLY_TOKEN="${CORRECT_ONLY_AUTH%%|*}"; CORRECT_ONLY_ID="${CORRECT_ONLY_AUTH##*|}"
echo "Signed in: quantities=$QUANTITIES_ID full=$FULL_ID correct_only=$CORRECT_ONLY_ID"
echo

echo "=== Discovering a line item on the sandbox project ==="
# Filtered on contracts.is_sandbox = true (see 0005/0006), not just "whatever
# the quantities seat sees first" — this suite writes confirmed quantity_records
# as part of its own checks, and those rows must never land on a real,
# non-sandbox project.
request GET "items?select=id,contract_id,contracts!inner(is_sandbox)&contracts.is_sandbox=eq.true&limit=1" "$QUANTITIES_TOKEN"
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

request PATCH "quantity_records?id=eq.$ENTRY_ID" "$QUANTITIES_TOKEN" '{"quantity": 999}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: quantity update rejected (append-only grant)" "403" "$ok" "$STATUS $BODY_OUT"

request PATCH "quantity_records?id=eq.$ENTRY_ID" "$QUANTITIES_TOKEN" '{"status": "confirmed"}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "quantities: status update rejected (no confirm_quantity, 0 rows)" "200, []" "$ok" "$STATUS $BODY_OUT"

OTHER_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "quantity_records" "$QUANTITIES_TOKEN" \
  "{\"id\":\"$OTHER_ID\",\"contract_id\":\"$PROJECT_ID\",\"item_id\":\"$LINE_ITEM_ID\",\"work_date\":\"2026-08-02\",\"quantity\":5,\"created_by\":\"$FULL_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "quantities: insert with wrong created_by rejected" "403" "$ok" "$STATUS $BODY_OUT"

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

request PATCH "quantity_records?id=eq.$ENTRY_ID" "$FULL_TOKEN" \
  "{\"status\":\"confirmed\",\"confirmed_by\":\"$READONLY_ID\",\"confirmed_at\":\"2020-01-01T00:00:00Z\"}"
ok=0
if [ "$STATUS" = "200" ]; then
  cb=$(json_field "$BODY_OUT" 0 confirmed_by)
  ca=$(json_field "$BODY_OUT" 0 confirmed_at)
  case "$ca" in 2020*) ca_spoofed=1 ;; *) ca_spoofed=0 ;; esac
  [ "$cb" = "$FULL_ID" ] && [ "$ca_spoofed" = "0" ] && ok=1
fi
check "full: confirmed_by/confirmed_at spoof+backdate overridden" "confirmed_by=$FULL_ID, confirmed_at=now" "$ok" "$STATUS $BODY_OUT"

request PATCH "quantity_records?id=eq.$ENTRY_ID" "$FULL_TOKEN" "{\"status\":\"confirmed\",\"confirmed_by\":\"$READONLY_ID\"}"
ok=0
if [ "$STATUS" = "200" ]; then
  cb=$(json_field "$BODY_OUT" 0 confirmed_by)
  [ "$cb" = "$FULL_ID" ] && ok=1
fi
check "full: attribution pinned on re-touch" "confirmed_by stays $FULL_ID" "$ok" "$STATUS $BODY_OUT"

request PATCH "quantity_records?id=eq.$ENTRY_ID" "$FULL_TOKEN" '{"status": "draft"}'
ok=0
case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
check "full: un-confirm rejected" ">=400" "$ok" "$STATUS $BODY_OUT"

request PATCH "quantity_records?id=eq.$ENTRY_ID" "$FULL_TOKEN" '{"station_from": 3000}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "full: station_from edit on confirmed entry rejected" "403" "$ok" "$STATUS $BODY_OUT"

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
# Privileged-path checks — a different layer, tested separately on purpose.
# Unaffected by the rights rewrite: these exercise guard_entry_transitions()
# directly at the postgres role, below PostgREST's grant system entirely.
#
# Every seat-level edit check above returns 403 at the GRANT level (quantity
# and station_from/station_to were never granted UPDATE to `authenticated` at
# all) — which means guard_entry_transitions()'s append-only branch, the
# `row(...) is distinct from row(...)` comparison enumerating every immutable
# column, has never actually executed in this suite. The grant stops the
# request before the trigger is reached, every time. That branch is the
# backstop for paths that don't go through PostgREST's grant system at all:
# service_role scripts, RPCs, security-definer functions, anyone in psql —
# exactly the paths this app grows into next. Optional: needs
# SUPABASE_DB_PASSWORD and a `supabase` CLI already linked to this repo
# (`supabase link --project-ref ...`); skipped, not failed, without it.
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
fi

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
