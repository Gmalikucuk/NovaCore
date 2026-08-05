#!/usr/bin/env bash
#
# ARCHIVED — moved out of scripts/ on 2026-08-05. Targets crew_members,
# reconstruction_runs, road_segments, companies, and projects: tables from
# the pre-rebuild prototype, none of which exist in the current v1 schema
# (contracts/contract_members/items/item_prices/quantity_records). Every
# query in this file would fail immediately if run. Kept here for reference
# only — a copy that looked live in scripts/ was a trap for whoever read the
# repo next.
#
# End-to-end regression test for the magic-link auth + role-gating scheme
# introduced in migrations 20260705090000-20260705090400.
#
# What this proves, against the REAL linked Supabase project (not a local
# stub):
#   1. A real magic-link sign-in creates a crew_members row via the
#      on_auth_user_created trigger, with role=field_staff / active=true /
#      company_id=Keywest Asphalt / auth_user_id linked.
#   2. The crew_members_restrict_update trigger blocks a field_staff user
#      from self-promoting to coordinator.
#   3. The reconstruction_runs role gate blocks a field_staff user from
#      accepting a run, and allows a coordinator to.
#
# Why part of this is manual: step 1 requires actually clicking the emailed
# magic link. There is no way to automate that without the service_role key
# (e.g. via the Admin API's generate_link), which this project deliberately
# keeps out of client code and out of this repo. Steps 2-3 use a synthetic
# second account created directly via SQL (no email needed), so they run
# fully unattended.
#
# The script cleans up everything it creates (the synthetic account, the
# throwaway project/job/segment/runs) and restores TEST_EMAIL's role to
# whatever it was before the run, so it's safe to re-run repeatedly — e.g.
# after any future RLS/trigger/auth change — without leaving residue in the
# live project.
#
# Usage:
#   TEST_EMAIL=you@example.com ./scripts/test-role-gating.sh
#
# Requirements:
#   - supabase CLI installed, logged in, and linked to the target project
#     (supabase link --project-ref <ref>)
#   - .env.local in the repo root with VITE_SUPABASE_URL and
#     VITE_SUPABASE_ANON_KEY set (used only to call the public /auth/v1/otp
#     endpoint — no service_role key is used anywhere in this script)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

TEST_EMAIL="${TEST_EMAIL:?Set TEST_EMAIL to the real inbox you will click the magic link from, e.g. TEST_EMAIL=you@example.com ./scripts/test-role-gating.sh}"

if [ ! -f .env.local ]; then
  echo "Missing .env.local (needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)" >&2
  exit 1
fi
set -a
source .env.local
set +a

RUN_TAG="ROLE-GATE-TEST-$(date +%s)"
SYNTHETIC_EMAIL="role-gate-test-$(date +%s)@keywestasphalt.com"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Runs a SQL statement via the CLI's linked (admin) connection. Prints the
# raw output; the caller decides pass/fail based on exit code / content.
db() {
  supabase db query --linked "$1" 2>&1
}

# Runs a query and extracts rows[0][<field>] from the JSON response. The CLI
# mixes log lines ("Initialising login role...", update notices) into the
# same stream as the JSON, so this filters down to just the {...} block first.
db_field() {
  supabase db query --linked "$1" 2>&1 | sed -n '/^{/,/^}/p' | python3 -c "import sys, json; print(json.load(sys.stdin)['rows'][0]['$2'])"
}

echo "=== Step 1: send a real magic-link email to $TEST_EMAIL ==="
curl -s -X POST "$VITE_SUPABASE_URL/auth/v1/otp" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"create_user\":true}" > /dev/null
echo "Email sent. Go click the magic link now."
read -r -p "Press Enter once you've clicked it and are signed in... " _

echo ""
echo "=== Step 2: confirm the signup trigger created a crew_members row ==="
SIGNUP_ROW=$(db "select id, role, active, auth_user_id, (select name from companies where id = company_id) as company from crew_members where name = '$TEST_EMAIL';")
echo "$SIGNUP_ROW"
if echo "$SIGNUP_ROW" | grep -q '"role": *"field_staff"' && echo "$SIGNUP_ROW" | grep -q '"active": *true'; then
  pass "crew_members row auto-created with role=field_staff, active=true"
else
  fail "expected role=field_staff, active=true in crew_members row — got the output above"
fi

TEST_AUTH_USER_ID=$(db_field "select auth_user_id from crew_members where name = '$TEST_EMAIL';" auth_user_id)
ORIGINAL_ROLE=$(db_field "select role from crew_members where auth_user_id = '$TEST_AUTH_USER_ID';" role)

echo ""
echo "=== Step 3: promote $TEST_EMAIL to coordinator (bootstrap bypass) ==="
db "update crew_members set role = 'coordinator' where auth_user_id = '$TEST_AUTH_USER_ID';" > /dev/null
PROMOTED_ROLE=$(db_field "select role from crew_members where auth_user_id = '$TEST_AUTH_USER_ID';" role)
if [ "$PROMOTED_ROLE" = "coordinator" ]; then
  pass "promoted via trusted direct-DB bypass"
else
  fail "expected role=coordinator after promotion, got: $PROMOTED_ROLE"
fi

echo ""
echo "=== Step 4: create a synthetic field_staff account (no email needed) ==="
SYNTH_AUTH_ID=$(db_field "insert into auth.users (id, email, instance_id, aud, role) values (gen_random_uuid(), '$SYNTHETIC_EMAIL', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated') returning id;" id)
echo "synthetic auth_user_id: $SYNTH_AUTH_ID"

echo ""
echo "=== Step 5: set up a throwaway project/job/segment/two draft runs ==="
db "
insert into projects (contract_number, name, company_id) values ('$RUN_TAG', 'Role Gate Regression Test', (select id from companies where name = 'Keywest Asphalt'));
insert into jobs (project_id, job_code) select id, 'A' from projects where contract_number = '$RUN_TAG';
insert into road_segments (job_id, highway, direction, from_station, to_station) select id, 'Hwy 1', 'NB', 0, 100 from jobs where project_id = (select id from projects where contract_number = '$RUN_TAG');
insert into reconstruction_runs (road_segment_id, paving_date, direction, run_number, input_snapshot, status)
select id, current_date, 'NB', 1, '{}', 'draft' from road_segments where job_id = (select id from jobs where project_id = (select id from projects where contract_number = '$RUN_TAG'));
insert into reconstruction_runs (road_segment_id, paving_date, direction, run_number, input_snapshot, status)
select id, current_date, 'NB', 2, '{}', 'draft' from road_segments where job_id = (select id from jobs where project_id = (select id from projects where contract_number = '$RUN_TAG'));
" > /dev/null

RUN1=$(db_field "select id from reconstruction_runs where run_number = 1 and road_segment_id = (select id from road_segments where job_id = (select id from jobs where project_id = (select id from projects where contract_number = '$RUN_TAG')));" id)
RUN2=$(db_field "select id from reconstruction_runs where run_number = 2 and road_segment_id = (select id from road_segments where job_id = (select id from jobs where project_id = (select id from projects where contract_number = '$RUN_TAG')));" id)

echo ""
echo "=== Step 6: field_staff self-promotion attempt (must FAIL) ==="
if OUT=$(db "select set_config('request.jwt.claims', json_build_object('sub','$SYNTH_AUTH_ID')::text, false); set role authenticated; update crew_members set role = 'coordinator' where auth_user_id = '$SYNTH_AUTH_ID';" 2>&1); then
  fail "self-promotion should have been rejected but succeeded"
else
  if echo "$OUT" | grep -q "only a coordinator may change role or active"; then
    pass "self-promotion correctly rejected"
  else
    fail "rejected, but with an unexpected error: $OUT"
  fi
fi

echo ""
echo "=== Step 7: field_staff attempts to accept a reconstruction_run (must FAIL) ==="
if OUT=$(db "select set_config('request.jwt.claims', json_build_object('sub','$SYNTH_AUTH_ID')::text, false); set role authenticated; update reconstruction_runs set status = 'accepted' where id = '$RUN1';" 2>&1); then
  fail "field_staff acceptance should have been rejected but succeeded"
else
  if echo "$OUT" | grep -q "only a coordinator may accept a reconstruction_run"; then
    pass "field_staff acceptance correctly rejected"
  else
    fail "rejected, but with an unexpected error: $OUT"
  fi
fi

echo ""
echo "=== Step 8: coordinator ($TEST_EMAIL) accepts a reconstruction_run (must SUCCEED) ==="
OUT=$(db "select set_config('request.jwt.claims', json_build_object('sub','$TEST_AUTH_USER_ID')::text, false); set role authenticated; update reconstruction_runs set status = 'accepted' where id = '$RUN2'; select status from reconstruction_runs where id = '$RUN2';") || true
if echo "$OUT" | grep -q '"status": *"accepted"'; then
  pass "coordinator acceptance succeeded"
else
  fail "expected status=accepted — got: $OUT"
fi

echo ""
echo "=== Cleanup: removing everything this script created ==="
db "
delete from reconstruction_runs where id in ('$RUN1','$RUN2');
delete from road_segments where job_id in (select id from jobs where project_id in (select id from projects where contract_number = '$RUN_TAG'));
delete from jobs where project_id in (select id from projects where contract_number = '$RUN_TAG');
delete from projects where contract_number = '$RUN_TAG';
delete from crew_members where auth_user_id = '$SYNTH_AUTH_ID';
delete from auth.users where id = '$SYNTH_AUTH_ID';
update crew_members set role = '$ORIGINAL_ROLE' where auth_user_id = '$TEST_AUTH_USER_ID';
" > /dev/null
echo "Done — throwaway project, synthetic account, and test runs removed."
echo "$TEST_EMAIL's role restored to its pre-test value: $ORIGINAL_ROLE"
echo "(Its crew_members/auth.users rows are left in place — they're your real account, not test data.)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
