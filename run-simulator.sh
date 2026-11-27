#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/app"
url=http://127.0.0.1:5190
vite_pid=
cleanup() {
  if [[ -n "$vite_pid" ]]; then
    kill "$vite_pid" 2>/dev/null || true
    wait "$vite_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! curl --noproxy '*' -fsS --max-time 2 "$url" | grep -q '<title>Duet</title>'; then
  log=$(mktemp /tmp/duet-vite.XXXXXX.log)
  node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5190 --strictPort >"$log" 2>&1 &
  vite_pid=$!
  ready=false
  for ((attempt=0; attempt<50; attempt++)); do
    if ! kill -0 "$vite_pid" 2>/dev/null; then
      cat "$log"
      exit 1
    fi
    if curl --noproxy '*' -fsS --max-time 1 "$url" 2>/dev/null | grep -q '<title>Duet</title>'; then
      ready=true
      break
    fi
    sleep 0.2
  done
  if [[ "$ready" != true ]]; then
    echo "Duet did not start. See $log" >&2
    exit 1
  fi
fi

echo "Opening EvenHub Simulator with Duet at $url"
./node_modules/.bin/evenhub-simulator "$url" "$@"
