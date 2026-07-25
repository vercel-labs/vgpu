#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/node22/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; PORT="${PORT:-3004}"; SESSION="ort-init-device-$BASHPID"
ART="$ROOT/artifacts"; mkdir -p "$ART"
# agent-browser 0.33 can leave its daemon holding the CLI pipe after the requested
# operation finishes. Bound every invocation; later artifact assertions fail closed.
ab(){
  local output rc
  output="$(mktemp)"
  set +e
  timeout --signal=TERM --kill-after=1s 10s agent-browser "$@" >"$output" 2>&1
  rc=$?
  set -e
  cat "$output"
  rm -f "$output"
  [[ $rc -eq 0 || $rc -eq 124 ]]
}
ab doctor --webgpu --headed | tee "$ART/browser-doctor.log"
node "$ROOT/scripts/serve.mjs" --host 127.0.0.1 --port "$PORT" >"$ART/browser-server.log" 2>&1 & SERVER=$!
cleanup(){ timeout --kill-after=1s 5s agent-browser --session "$SESSION" close >/dev/null 2>&1 || true; kill "$SERVER" >/dev/null 2>&1 || true; wait "$SERVER" 2>/dev/null || true; }; trap cleanup EXIT
for _ in $(seq 1 40); do grep -q READY "$ART/browser-server.log" && break; sleep .25; done
grep -q READY "$ART/browser-server.log"
ab --session "$SESSION" --webgpu --headed open "http://127.0.0.1:$PORT"
ab --session "$SESSION" --webgpu --headed wait 6000
ab --session "$SESSION" --webgpu --headed eval 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'
ab --session "$SESSION" --webgpu --headed eval 'JSON.stringify({status:document.documentElement.dataset.probeStatus,text:document.body.innerText,canvas:Boolean(document.querySelector("canvas"))})' | tee "$ART/browser-dom.json"
ab --session "$SESSION" --webgpu --headed console | tee "$ART/browser-console.log"
ab --session "$SESSION" --webgpu --headed screenshot "$ART/browser.png"
grep -q PROBE_PASS "$ART/browser-dom.json" || sed 's/\\"/"/g' "$ART/browser-dom.json" | grep -q '"status":"PASS"'
grep -F '"status": "PASS"' "$ART/browser.json"
identify -format '%[fx:standard_deviation]\n' "$ART/browser.png" | tee "$ART/browser-pixel-stddev.txt" | awk '$1 > 0.01'
echo 0 >"$ART/browser.rc"
trap - EXIT
timeout --kill-after=1s 5s agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
kill "$SERVER" >/dev/null 2>&1 || true
