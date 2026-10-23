#!/bin/bash
# Run one heavy step (TTS, stills, render) while holding one of N slots, so at most N run
# at once on this machine (several build sessions can share one laptop without running out of memory).
# Usage: <studio>/pipeline/heavy.sh <command...>   (HEAVY_SLOTS overrides N=2)
N=${HEAVY_SLOTS:-2}
L=$HOME/.cache/explainer-video/locks
mkdir -p "$L"
slot=""
while [ -z "$slot" ]; do
  for i in $(seq 1 "$N"); do
    d="$L/slot-$i"
    if mkdir "$d" 2>/dev/null; then echo $$ > "$d/pid"; slot="$d"; break; fi
    p=$(cat "$d/pid" 2>/dev/null)
    if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then rm -rf "$d"; fi
  done
  [ -z "$slot" ] && sleep 3
done
trap 'rm -rf "$slot"' EXIT
"$@"
