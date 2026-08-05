#!/usr/bin/env bash
#
# One-command backup of item_prices — raw unit_price and cost_price, per
# contract, to CSV.
#
# WHY THIS EXISTS: once a real bid rate is entered it lives in exactly two
# places — Keywest's own tender/estimating file, and this database. The
# Tracker export (src/lib/export/trackerExport.ts) is NOT a substitute: it
# exports unit_price raw, but cost only as "Est. Cost to Date" (quantity to
# date x cost_price). On a contract with zero confirmed quantity — Hwy 5's
# own state the day real rates go in — every row of that column reads $0.00
# regardless of the true cost_price. This script exports the two raw numbers
# themselves, nothing derived.
#
# AUTHENTICATION — read this before running it against a contract that
# matters:
#
# This signs in as a REAL user via Supabase Auth (POST /auth/v1/token, the
# same endpoint the app itself and scripts/probe-rls.sh use), exactly the
# way the app authenticates a person at the keyboard. It never uses the
# service_role key, and the anon key it does use grants nothing by itself
# (RLS is what governs every request either way). The signed-in user's own
# access token is what every request below carries, so item_prices'
# existing finance-wall policy (item_prices_select_right, gated on
# view_rates) applies to this script exactly as it applies to the app —
# a seat lacking view_rates on the target contract gets zero rows here, the
# same as they would in the UI. This script is not a second path into
# item_prices; it is the same one path everything else already uses,
# pointed at a CSV instead of a browser.
#
# Credentials are never read from or written to any file — EXPORT_EMAIL and
# EXPORT_PASSWORD are read from the environment only, and if
# EXPORT_PASSWORD isn't set, this prompts for it (hidden input, not echoed,
# never touches shell history).
#
# Usage:
#   SUPABASE_URL=... SUPABASE_ANON_KEY=... EXPORT_EMAIL=you@keywest.com \
#     ./scripts/export-item-prices.sh 26607-0000 > hwy5-rates-2026-08-04.csv
#
# SUPABASE_URL / SUPABASE_ANON_KEY are not secret (same values already in
# .env.local as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, or in
# .env.probe) — only EXPORT_EMAIL/EXPORT_PASSWORD identify who is asking,
# and RLS is what actually decides what they get back.
#
# Exit code: 0 on success (including a legitimately empty export — no rates
# entered yet is not a failure), 1 on sign-in failure, missing contract, or
# missing required environment.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

: "${SUPABASE_URL:?Set SUPABASE_URL (see .env.local's VITE_SUPABASE_URL, or .env.probe)}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY (see .env.local's VITE_SUPABASE_ANON_KEY, or .env.probe)}"
: "${EXPORT_EMAIL:?Set EXPORT_EMAIL to your own NovaCore sign-in — this exports under YOUR rights, not a shared account}"

CONTRACT_NO="${1:-}"
if [ -z "$CONTRACT_NO" ]; then
  echo "Usage: $0 <contract_no> [> output.csv]" >&2
  echo "Example: $0 26607-0000 > hwy5-rates-$(date +%F 2>/dev/null || echo today).csv" >&2
  exit 1
fi

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

if [ -z "${EXPORT_PASSWORD:-}" ]; then
  read -r -s -p "Password for $EXPORT_EMAIL: " EXPORT_PASSWORD
  echo >&2
fi

# sign_in EMAIL PASSWORD -> prints "access_token|user_id", or "SIGNIN_FAILED"
# — same shape and same endpoint as probe-rls.sh's own sign_in().
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

AUTH=$(sign_in "$EXPORT_EMAIL" "$EXPORT_PASSWORD")
if [ "$AUTH" = "SIGNIN_FAILED" ]; then
  echo "FATAL: sign-in failed for $EXPORT_EMAIL — check the password" >&2
  exit 1
fi
TOKEN="${AUTH%%|*}"
USER_ID="${AUTH##*|}"

# request METHOD PATH -> sets $STATUS and $BODY_OUT (same shape as
# probe-rls.sh's own request(), narrowed to GET-with-token since that's all
# this needs).
request() {
  local path="$1" resp
  resp=$(curl -s -w '\n%{http_code}' -X GET "$SUPABASE_URL/rest/v1/$path" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOKEN")
  STATUS=$(printf '%s' "$resp" | tail -n1)
  BODY_OUT=$(printf '%s' "$resp" | sed '$d')
}

request "contracts?select=id&contract_no=eq.$CONTRACT_NO"
CONTRACT_ID=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1] or '[]')
print(d[0]['id'] if d else '')
" "$BODY_OUT")

if [ -z "$CONTRACT_ID" ]; then
  echo "FATAL: no contract found for contract_no=$CONTRACT_NO, or $EXPORT_EMAIL is not seated on it" >&2
  echo "  (contracts_select_member requires membership — this can't tell the two cases apart" >&2
  echo "  any more than the API itself can, by design)" >&2
  exit 1
fi

# Checked separately from the item_prices query below so a seat lacking
# view_rates gets an honest, specific message instead of a silently empty
# CSV that reads exactly like "no rates entered yet."
request "contract_members?select=view_rates&contract_id=eq.$CONTRACT_ID&user_id=eq.$USER_ID"
HAS_VIEW_RATES=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1] or '[]')
print('1' if d and d[0].get('view_rates') else '0')
" "$BODY_OUT")

if [ "$HAS_VIEW_RATES" = "0" ]; then
  echo "FATAL: $EXPORT_EMAIL does not hold view_rates on contract_no=$CONTRACT_NO" >&2
  echo "  The export would come back empty either way — RLS returns zero rows for" >&2
  echo "  a seat lacking the right, same as a genuinely unpriced contract would. This" >&2
  echo "  script refuses to guess which case that silence would have meant." >&2
  exit 1
fi

request "item_prices?select=cost_price,unit_price,item_id,items(item_number,description,unit)&contract_id=eq.$CONTRACT_ID&order=items(item_number)"

python3 -c "
import json, sys, csv

rows = json.loads(sys.argv[1] or '[]')
w = csv.writer(sys.stdout)
w.writerow(['item_number', 'description', 'unit', 'unit_price', 'cost_price', 'item_id'])
for r in rows:
    item = r.get('items') or {}
    w.writerow([
        item.get('item_number', ''),
        item.get('description', ''),
        item.get('unit', ''),
        r.get('unit_price', ''),
        r.get('cost_price', ''),
        r.get('item_id', ''),
    ])
print(f'{len(rows)} rows exported for contract_no=$CONTRACT_NO', file=sys.stderr)
" "$BODY_OUT"
