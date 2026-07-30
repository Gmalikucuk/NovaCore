#!/usr/bin/env bash
#
# NovaCore RLS acceptance probe suite.
#
# Re-runs, against the REAL linked Supabase project (never a local stub):
#   - the four price probes from 0002_foundation_rls.sql's acceptance-test
#     comment block, plus its two capability probes and three write-path
#     rejection checks
#   - the confirmation-guard checks added in 0003 (confirmed_by/confirmed_at
#     spoof + backdate, attribution pinned on re-touch, un-confirm rejected)
#   - the station append-only check added in 0004
#   - two positive controls (field sees v_line_item_progress rows, cfo sees
#     line_item_prices rows) — a suite that only ever asserts "empty" passes
#     just as well when authentication is silently broken, which is the
#     failure mode most likely to fool a human skimming curl output
#
# Meant to be re-run after every migration that touches a policy or a
# trigger on daily_entries — not read once and trusted forever.
#
# Writes real rows via the field write-path and privileged-path checks below,
# so it always targets the dedicated sandbox project (projects.is_sandbox =
# true — see 0005/0006's "PROBE — do not use" project), never a live one.
# The discovery step picks whichever sandbox project the field seat is on;
# it doesn't assume a fixed id, so re-seeding the sandbox project under a new
# id needs no change here.
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
#   FIELD_PASSWORD, PM_PASSWORD, CFO_PASSWORD, OWNER_PASSWORD
# Optional, default to the seeded test accounts:
#   FIELD_EMAIL, PM_EMAIL, CFO_EMAIL, OWNER_EMAIL
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
if [ -f .env.probe ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|'#'*) continue ;; esac
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < .env.probe
fi

: "${SUPABASE_URL:?Set SUPABASE_URL (env or .env.probe)}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY (env or .env.probe)}"
: "${FIELD_PASSWORD:?Set FIELD_PASSWORD (env or .env.probe)}"
: "${PM_PASSWORD:?Set PM_PASSWORD (env or .env.probe)}"
: "${CFO_PASSWORD:?Set CFO_PASSWORD (env or .env.probe)}"
: "${OWNER_PASSWORD:?Set OWNER_PASSWORD (env or .env.probe)}"

FIELD_EMAIL="${FIELD_EMAIL:-field@novacore.test}"
PM_EMAIL="${PM_EMAIL:-pm@novacore.test}"
CFO_EMAIL="${CFO_EMAIL:-cfo@novacore.test}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@novacore.test}"

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

PASS=0
FAIL=0

# check "<name>" "<expected>" <0|1> "<detail-on-failure>"
check() {
  local name="$1" expected="$2" ok="$3" detail="${4:-}"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-52s expected: %s\n' "$name" "$expected"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-52s expected: %-30s actual: %s\n' "$name" "$expected" "$detail"
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
FIELD_AUTH=$(sign_in "$FIELD_EMAIL" "$FIELD_PASSWORD")
PM_AUTH=$(sign_in "$PM_EMAIL" "$PM_PASSWORD")
CFO_AUTH=$(sign_in "$CFO_EMAIL" "$CFO_PASSWORD")
OWNER_AUTH=$(sign_in "$OWNER_EMAIL" "$OWNER_PASSWORD")

for seat_auth in "field $FIELD_AUTH" "pm $PM_AUTH" "cfo $CFO_AUTH" "owner $OWNER_AUTH"; do
  seat="${seat_auth%% *}"
  auth="${seat_auth#* }"
  if [ "$auth" = "SIGNIN_FAILED" ]; then
    echo "FATAL: sign-in failed for the $seat seat — check credentials in .env.probe" >&2
    exit 1
  fi
done

FIELD_TOKEN="${FIELD_AUTH%%|*}"; FIELD_ID="${FIELD_AUTH##*|}"
PM_TOKEN="${PM_AUTH%%|*}"; PM_ID="${PM_AUTH##*|}"
CFO_TOKEN="${CFO_AUTH%%|*}"
OWNER_TOKEN="${OWNER_AUTH%%|*}"; OWNER_ID="${OWNER_AUTH##*|}"
echo "Signed in: field=$FIELD_ID pm=$PM_ID"
echo

echo "=== Discovering a line item on the sandbox project ==="
# Filtered on projects.is_sandbox = true (see 0005/0006), not just "whatever
# the field seat sees first" — this suite writes confirmed daily_entries as
# part of its own checks (see the field-write-path and privileged-path
# sections below), and those rows must never land on a real, non-sandbox
# project. field is seated on Hwy 5 too, so an unfiltered discovery query
# would be one seed-data reorder away from silently writing fabricated
# quantity/margin into a live project again.
request GET "line_items?select=id,project_id,projects!inner(is_sandbox)&projects.is_sandbox=eq.true&limit=1" "$FIELD_TOKEN"
PROJECT_ID=$(json_field "$BODY_OUT" 0 project_id)
LINE_ITEM_ID=$(json_field "$BODY_OUT" 0 id)
if [ -z "$PROJECT_ID" ] || [ -z "$LINE_ITEM_ID" ]; then
  echo "FATAL: field seat sees no line_items on a sandbox project — seed data missing, cannot run probes" >&2
  echo "  ($STATUS $BODY_OUT)" >&2
  exit 1
fi
echo "Using project $PROJECT_ID / line item $LINE_ITEM_ID"
echo

# =============================================================================
# Finance wall — the four price probes, field seat (0002 comment block)
# =============================================================================
echo "=== Finance wall (field seat) ==="

request GET "line_item_prices?select=*" "$FIELD_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "field: line_item_prices direct select" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "line_items?select=*,line_item_prices(*)" "$FIELD_TOKEN"
ok=0
if [ "$STATUS" = "200" ]; then
  all_empty=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('1' if d and all(not r.get('line_item_prices') for r in d) else '0')
" "$BODY_OUT")
  [ "$all_empty" = "1" ] && ok=1
fi
check "field: line_items embed line_item_prices" "200, prices empty every row" "$ok" "$STATUS $BODY_OUT"

request GET "v_line_item_finance?select=*" "$FIELD_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "field: v_line_item_finance" "200, []" "$ok" "$STATUS $BODY_OUT"

request GET "line_item_prices?select=cost_price,sell_price&limit=1000" "$FIELD_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "field: line_item_prices unfiltered/unlimited" "200, []" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Positive controls — prove the seats can still do their jobs. An all-empty
# suite passes just as well when auth is silently broken; this is the check
# that would actually catch that.
# =============================================================================
echo
echo "=== Positive controls ==="

request GET "v_line_item_progress?select=*" "$FIELD_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "field: v_line_item_progress returns rows" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

request GET "line_item_prices?select=*&limit=1" "$CFO_TOKEN"
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" -ge 1 ] 2>/dev/null && ok=1
check "cfo: line_item_prices returns rows" "200, >=1 row" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Field write path
# =============================================================================
echo
echo "=== Field write path ==="

ENTRY_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "daily_entries" "$FIELD_TOKEN" \
  "{\"id\":\"$ENTRY_ID\",\"project_id\":\"$PROJECT_ID\",\"line_item_id\":\"$LINE_ITEM_ID\",\"entry_date\":\"2026-07-30\",\"quantity\":10,\"station_from\":2090,\"station_to\":2091,\"created_by\":\"$FIELD_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "201" ] && ok=1
check "field: insert daily_entry (with stations)" "201" "$ok" "$STATUS $BODY_OUT"

request PATCH "daily_entries?id=eq.$ENTRY_ID" "$FIELD_TOKEN" '{"quantity": 999}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "field: quantity update rejected" "403" "$ok" "$STATUS $BODY_OUT"

request PATCH "daily_entries?id=eq.$ENTRY_ID" "$FIELD_TOKEN" '{"status": "confirmed"}'
ok=0; [ "$STATUS" = "200" ] && [ "$(json_len "$BODY_OUT")" = "0" ] && ok=1
check "field: status update rejected (0 rows matched)" "200, []" "$ok" "$STATUS $BODY_OUT"

OTHER_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
request POST "daily_entries" "$FIELD_TOKEN" \
  "{\"id\":\"$OTHER_ID\",\"project_id\":\"$PROJECT_ID\",\"line_item_id\":\"$LINE_ITEM_ID\",\"entry_date\":\"2026-07-30\",\"quantity\":5,\"created_by\":\"$PM_ID\",\"device_id\":\"probe-rls\"}"
ok=0; [ "$STATUS" = "403" ] && ok=1
check "field: insert with wrong created_by rejected" "403" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Confirmation + append-only guards, PM seat (0003, 0004)
# =============================================================================
echo
echo "=== Confirmation guards (PM seat) ==="

request PATCH "daily_entries?id=eq.$ENTRY_ID" "$PM_TOKEN" \
  "{\"status\":\"confirmed\",\"confirmed_by\":\"$OWNER_ID\",\"confirmed_at\":\"2020-01-01T00:00:00Z\"}"
ok=0
if [ "$STATUS" = "200" ]; then
  cb=$(json_field "$BODY_OUT" 0 confirmed_by)
  ca=$(json_field "$BODY_OUT" 0 confirmed_at)
  case "$ca" in 2020*) ca_spoofed=1 ;; *) ca_spoofed=0 ;; esac
  [ "$cb" = "$PM_ID" ] && [ "$ca_spoofed" = "0" ] && ok=1
fi
check "pm: confirmed_by/confirmed_at spoof+backdate overridden" "confirmed_by=$PM_ID, confirmed_at=now" "$ok" "$STATUS $BODY_OUT"

request PATCH "daily_entries?id=eq.$ENTRY_ID" "$PM_TOKEN" "{\"status\":\"confirmed\",\"confirmed_by\":\"$OWNER_ID\"}"
ok=0
if [ "$STATUS" = "200" ]; then
  cb=$(json_field "$BODY_OUT" 0 confirmed_by)
  [ "$cb" = "$PM_ID" ] && ok=1
fi
check "pm: attribution pinned on re-touch" "confirmed_by stays $PM_ID" "$ok" "$STATUS $BODY_OUT"

request PATCH "daily_entries?id=eq.$ENTRY_ID" "$PM_TOKEN" '{"status": "draft"}'
ok=0
case "$STATUS" in [4-5][0-9][0-9]) ok=1 ;; esac
check "pm: un-confirm rejected" ">=400" "$ok" "$STATUS $BODY_OUT"

request PATCH "daily_entries?id=eq.$ENTRY_ID" "$PM_TOKEN" '{"station_from": 3000}'
ok=0; [ "$STATUS" = "403" ] && ok=1
check "pm: station_from edit on confirmed entry rejected" "403" "$ok" "$STATUS $BODY_OUT"

# =============================================================================
# Privileged-path checks — a different layer, tested separately on purpose.
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

  setup_out=$(db_query "insert into daily_entries (id, project_id, line_item_id, entry_date, quantity, station_from, status, confirmed_by, confirmed_at, created_by, device_id) values ('$PRIV_ID', '$PROJECT_ID', '$LINE_ITEM_ID', current_date, 1234.5, 500, 'confirmed', '$PM_ID', now(), '$FIELD_ID', 'probe-rls-privileged') returning id;")
  setup_rows=$(db_rows "$setup_out")
  ok=0; [ "$(json_len "$setup_rows")" = "1" ] && ok=1
  check "setup: seed a confirmed row as postgres" "1 row inserted" "$ok" "$setup_out"

  qty_out=$(db_query "update daily_entries set quantity = 999 where id = '$PRIV_ID';")
  ok=0; printf '%s' "$qty_out" | grep -q "append-only" && ok=1
  check "postgres: quantity UPDATE on confirmed row rejected" "P0001 append-only" "$ok" "$qty_out"

  stn_out=$(db_query "update daily_entries set station_from = 99 where id = '$PRIV_ID';")
  ok=0; printf '%s' "$stn_out" | grep -q "append-only" && ok=1
  check "postgres: station_from UPDATE on confirmed row rejected" "P0001 append-only" "$ok" "$stn_out"

  verify_out=$(db_query "select quantity, station_from from daily_entries where id = '$PRIV_ID';")
  verify_rows=$(db_rows "$verify_out")
  qv=$(json_field "$verify_rows" 0 quantity)
  sv=$(json_field "$verify_rows" 0 station_from)
  ok=0; [ "$qv" = "1234.5" ] && [ "$sv" = "500" ] && ok=1
  check "postgres: row genuinely unchanged after both rejections" "quantity=1234.5, station_from=500" "$ok" "$verify_out"
fi

# TODO: nothing tests daily_entries_effective — the view holding the rule
# that a confirmed row leaves the placed total only when its replacement
# ENTERS it (supersession takes effect on confirmation, not on insertion; see
# 0001_foundation_schema.sql's own comment on the view). A regression there
# changes money silently without violating any RLS policy, so it wouldn't
# show up as a failure anywhere in this script. Belongs in a SQL-level test
# here, or in Vitest once the dashboard math (§8 step 5) is factored into
# pure functions like the rest of this codebase's calculation logic. Not
# fixed now — noted so it's seen next time this file is touched.

echo
echo "=== Summary: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -eq 0 ]; then
  exit 0
else
  exit 1
fi
