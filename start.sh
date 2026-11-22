#!/usr/bin/env bash
# Start Fabbrico: installs dependencies if needed, runs the dev server and opens
# the browser. Stop with Ctrl+C.
set -euo pipefail

cd "$(dirname "$0")"
PORT="${PORT:-5173}"
URL="http://localhost:${PORT}"

open_browser() {
  if command -v open >/dev/null; then open "$URL"        # macOS
  elif command -v xdg-open >/dev/null; then xdg-open "$URL" # Linux
  else echo "Open $URL in your browser"; fi
}

if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Get it from https://nodejs.org (version 20 or newer)." >&2
  exit 1
fi

# Install or refresh dependencies when missing or out of date.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies…"
  npm install
fi

# Already running? Just open it.
if curl -s -o /dev/null "$URL"; then
  echo "Fabbrico is already running at $URL"
  open_browser
  exit 0
fi

# Open the browser as soon as the server answers.
(
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$URL"; then open_browser; break; fi
    sleep 0.5
  done
) &

cat <<EOF

  Fabbrico → $URL
  AI with your Claude subscription: in another terminal, run  claude  in this folder.
  Stop the app with Ctrl+C.

EOF

exec npx vite --port "$PORT" --strictPort
