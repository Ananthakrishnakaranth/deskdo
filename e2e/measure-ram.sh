#!/usr/bin/env bash
# Starts the built widget without any test instrumentation, waits until idle, and reports
# PSS (proportional set size: shared pages split between processes, so no double counting) and
# USS (private memory, the closest Linux equivalent of Task Manager's "Memory" column).
#   xvfb-run -a bash e2e/measure-ram.sh      (as root in a container: EXTRA_FLAGS=--no-sandbox)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export XDG_CONFIG_HOME="$(mktemp -d)"
"$ROOT/node_modules/electron/dist/electron" ${EXTRA_FLAGS:-} "$ROOT/packages/desktop" >/dev/null 2>&1 &
APP=$!
sleep "${IDLE_SECONDS:-20}"
pids=$(pgrep -P $APP; echo $APP; for p in $(pgrep -P $APP); do pgrep -P $p || true; done)
pss=0; uss=0
for p in $(echo "$pids" | sort -u); do
  [ -r /proc/$p/smaps_rollup ] || continue
  P=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup)
  U=$(awk '/^Private_(Clean|Dirty):/{s+=$2} END{print s}' /proc/$p/smaps_rollup)
  T=$(tr '\0' ' ' < /proc/$p/cmdline | grep -oE -- '--type=[a-z-]+' || echo "--type=browser")
  printf "  %-22s PSS %6d MB   USS %6d MB\n" "${T#--type=}" $((P/1024)) $((U/1024))
  pss=$((pss+P)); uss=$((uss+U))
done
echo "TOTAL PSS $((pss/1024)) MB, USS $((uss/1024)) MB"
kill $APP 2>/dev/null || true
