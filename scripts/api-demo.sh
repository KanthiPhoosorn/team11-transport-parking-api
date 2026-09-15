#!/usr/bin/env bash
# Assignment 3 — exercise every /v1 endpoint against the DEPLOYED worker and
# record real requests + responses for the report. Also pulls DB-level proof
# (migration state, table list, row counts) from the remote D1 database.
set -euo pipefail
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
cd "$(dirname "$0")/.."

BASE="https://team11-transport-parking.kanthiphs.workers.dev"
DB="team11-transport-parking"
OUT="evidence"; mkdir -p "$OUT"
OP=$(grep '^OPERATOR_TOKEN=' .dev.vars | cut -d= -f2-)
DP=$(grep '^DISPATCHER_TOKEN=' .dev.vars | cut -d= -f2-)
RUN=$(date -u +%Y%m%dT%H%M%SZ)
J='Content-Type: application/json'

ts()  { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
hr()  { printf '\n%s\n%s\n' "== $1" "$(printf '=%.0s' {1..72})"; }
sql() { npx wrangler d1 execute "$DB" --remote --json --command "$1" 2>/dev/null | python -c 'import json,sys
rows=json.load(sys.stdin)[-1]["results"]
if not rows: print("(no rows)"); sys.exit()
cols=list(rows[0].keys()); print(" | ".join(cols)); print("-"*72)
for r in rows: print(" | ".join(str(r[c]) if r[c] is not None else "NULL" for c in cols))'; }
req() { # METHOD PATH [curl args]
  local m=$1 p=$2; shift 2
  echo; echo "[$(ts)] $m $p"
  for a in "$@"; do case "$a" in -d) ;; -H) ;; Authorization:*) echo "  ${a%% *} <${a#* }" | sed -E 's/<Bearer .*/<Bearer …>/';; Content-Type*) ;; *) [[ "$a" == \{* ]] && echo "  body: $a";; esac; done
  curl -sS -X "$m" "$BASE$p" "$@" -o "$OUT/.body" -w '  -> HTTP %{http_code}\n'
  python -c 'import json;print("\n".join("  "+l for l in json.dumps(json.load(open("evidence/.body")),indent=2,ensure_ascii=False).splitlines()))' 2>/dev/null || sed 's/^/  /' "$OUT/.body"
}

{
echo "A3 API demo run $RUN   worker=$BASE   db=$DB"

hr "DB proof — migrations applied to the REMOTE database"
npx wrangler d1 migrations list "$DB" --remote 2>&1 | grep -E 'No migrations|schema|seed' | sed 's/^/  /'
hr "DB proof — tables (note: NO journeys table — journeys are computed, PRD 3.2)"
sql "SELECT name AS table_name, (SELECT COUNT(*) FROM sqlite_master m2 WHERE m2.tbl_name = m.name AND m2.type='trigger') AS triggers FROM sqlite_master m WHERE type='table' AND name NOT LIKE '\_cf%' ESCAPE '\' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name"
sql "SELECT (SELECT COUNT(*) FROM routes) routes,(SELECT COUNT(*) FROM stops) stops,(SELECT COUNT(*) FROM route_stops) route_stops,(SELECT COUNT(*) FROM vehicles) vehicles,(SELECT COUNT(*) FROM parking_zones) zones,(SELECT COUNT(*) FROM zone_permit_types) zone_permit_types,(SELECT COUNT(*) FROM availability) availability,(SELECT COUNT(*) FROM alerts) alerts"

hr "API-1 / API-2 — routes (public)"
req GET "/v1/routes"
req GET "/v1/routes/R1/stops"
hr "API-3 — vehicles on a route (public)"
req GET "/v1/vehicles?routeId=R1"
hr "API-4 — parking filtered by permit (public)"
req GET "/v1/parking?permitType=staff"
req GET "/v1/parking/Z-LIB"
hr "API-7 — journey planner (computed per request, never stored)"
req GET "/v1/journeys?origin=S-GATE&dest=S-DORM&permitType=student"
req GET "/v1/journeys?origin=S-DORM&dest=S-LIB"

hr "Trust boundary — the PRD error model"
req PATCH "/v1/parking/Z-GATE" -H "$J" -d '{"free":40,"version":1}'
req PATCH "/v1/parking/Z-GATE" -H "Authorization: Bearer $DP" -H "$J" -d '{"free":40,"version":1}'
req GET "/v1/parking/not%20valid"
req GET "/v1/parking/Z-NOPE"

hr "API-5 — operator updates availability with optimistic concurrency"
V=$(curl -sS "$BASE/v1/parking/Z-GATE" | python -c 'import json,sys;print(json.load(sys.stdin)["version"])')
echo "  current version read from GET: $V"
echo "  -- two operators send PATCH carrying the SAME version (a real race, sent concurrently)"
curl -sS -X PATCH "$BASE/v1/parking/Z-GATE" -H "Authorization: Bearer $OP" -H "$J" -d "{\"free\":44,\"version\":$V}" -o "$OUT/.race1" -w "  operator A -> HTTP %{http_code}\n" &
curl -sS -X PATCH "$BASE/v1/parking/Z-GATE" -H "Authorization: Bearer $OP" -H "$J" -d "{\"free\":43,\"version\":$V}" -o "$OUT/.race2" -w "  operator B -> HTTP %{http_code}\n" &
wait
echo "  operator A body: $(cat "$OUT/.race1")"
echo "  operator B body: $(cat "$OUT/.race2")"
req GET "/v1/parking/Z-GATE"

hr "Invariant 0 <= free <= capacity — enforced by the DATABASE trigger, not only the API"
V=$(curl -sS "$BASE/v1/parking/Z-E1" | python -c 'import json,sys;print(json.load(sys.stdin)["version"])')
req PATCH "/v1/parking/Z-E1" -H "Authorization: Bearer $OP" -H "$J" -d "{\"free\":999,\"version\":$V}"
hr "Edge-triggered event — free goes >0 -> 0 raises parking.full (PRD 4.4)"
req PATCH "/v1/parking/Z-E1" -H "Authorization: Bearer $OP" -H "$J" -d "{\"free\":0,\"version\":$V}"

hr "CRUD — parking zones (operator)"
req POST "/v1/parking" -H "Authorization: Bearer $OP" -H "$J" -d "{\"id\":\"Z-DEMO-$RUN\",\"name\":\"Demo Overflow Lot\",\"capacity\":30,\"lat\":20.0430,\"lng\":99.8960,\"permitTypes\":[\"visitor\",\"student\"],\"free\":30}"
req PUT "/v1/parking/Z-DEMO-$RUN" -H "Authorization: Bearer $OP" -H "$J" -d '{"name":"Demo Overflow Lot (resized)","capacity":20,"lat":20.0430,"lng":99.8960,"permitTypes":["visitor"]}'
req DELETE "/v1/parking/Z-DEMO-$RUN" -H "Authorization: Bearer $OP"
req GET "/v1/parking/Z-DEMO-$RUN"

hr "CRUD — routes & stops (dispatcher); route + ordered stops written in one D1 batch (transaction)"
req POST "/v1/stops" -H "Authorization: Bearer $DP" -H "$J" -d "{\"id\":\"S-DEMO-$RUN\",\"name\":\"Demo Stop\",\"lat\":20.0440,\"lng\":99.8920}"
req POST "/v1/routes" -H "Authorization: Bearer $DP" -H "$J" -d "{\"id\":\"R-DEMO-$RUN\",\"name\":\"Demo Shuttle\",\"stops\":[\"S-GATE\",\"S-DEMO-$RUN\",\"S-LIB\"]}"
req PUT "/v1/routes/R-DEMO-$RUN" -H "Authorization: Bearer $DP" -H "$J" -d "{\"name\":\"Demo Shuttle (rerouted)\",\"active\":true,\"stops\":[\"S-GATE\",\"S-LIB\"]}"
echo; echo "  -- ON DELETE RESTRICT: a stop still on a route cannot be deleted"
req DELETE "/v1/stops/S-LIB" -H "Authorization: Bearer $DP"
req DELETE "/v1/stops/S-DEMO-$RUN" -H "Authorization: Bearer $DP"
req DELETE "/v1/routes/R-DEMO-$RUN" -H "Authorization: Bearer $DP"

hr "CRUD — vehicles (dispatcher); delaySec >= 300 raises route.delayed"
req POST "/v1/vehicles" -H "Authorization: Bearer $DP" -H "$J" -d "{\"id\":\"V-DEMO-$RUN\",\"routeId\":\"R2\",\"lastStopId\":\"S-DORM\",\"etaNextStopSec\":120}"
req PATCH "/v1/vehicles/V-DEMO-$RUN" -H "Authorization: Bearer $DP" -H "$J" -d '{"lastStopId":"S-E1","etaNextStopSec":30,"delaySec":360}'
req DELETE "/v1/vehicles/V-DEMO-$RUN" -H "Authorization: Bearer $DP"

hr "API-6 — alerts (operator/dispatcher) + the system-raised events above"
req POST "/v1/alerts" -H "Authorization: Bearer $DP" -H "$J" -d '{"message":"Campus Loop diverted via C5 until 16:00","routeId":"R1"}'
req GET "/v1/alerts"

hr "Restore seed state so the run is repeatable"
V=$(curl -sS "$BASE/v1/parking/Z-E1" | python -c 'import json,sys;print(json.load(sys.stdin)["version"])')
curl -sS -X PATCH "$BASE/v1/parking/Z-E1" -H "Authorization: Bearer $OP" -H "$J" -d "{\"free\":12,\"version\":$V}" -o /dev/null -w "  Z-E1 free=12 -> HTTP %{http_code}\n"
V=$(curl -sS "$BASE/v1/parking/Z-GATE" | python -c 'import json,sys;print(json.load(sys.stdin)["version"])')
curl -sS -X PATCH "$BASE/v1/parking/Z-GATE" -H "Authorization: Bearer $OP" -H "$J" -d "{\"free\":45,\"version\":$V}" -o /dev/null -w "  Z-GATE free=45 -> HTTP %{http_code}\n"

echo; echo "run complete $(ts)"
} 2>&1 | tee "$OUT/api-demo-$RUN.txt"
rm -f "$OUT/.race1" "$OUT/.race2"
echo "wrote $OUT/api-demo-$RUN.txt"
