#!/usr/bin/env bash
# Build Duet and pack the .ehpk for Even Hub with YOUR server baked in.
#   DUET_URL=https://my-server.example/duet  [DUET_TOKEN=...]  scripts/pack.sh
# The repo's app.json keeps a placeholder host; the real one only goes into the build.
set -euo pipefail
: "${DUET_URL:?set DUET_URL to your Duet server, e.g. https://my-server.example/duet}"
cd "$(dirname "$0")/../app"
origin=$(node -e 'const u=new URL(process.argv[1]); console.log(u.origin)' "$DUET_URL")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
node -e '
  const fs=require("fs"); const m=JSON.parse(fs.readFileSync("app.json","utf8"));
  for (const p of m.permissions) if (p.name==="network") p.whitelist=[process.argv[1]];
  fs.writeFileSync(process.argv[2], JSON.stringify(m,null,2));' "$origin" "$work/app.json"
VITE_DUET_URL="$DUET_URL" VITE_DUET_TOKEN="${DUET_TOKEN:-}" npm run check
version=$(node -p 'require("./app.json").version')
npx evenhub pack "$work/app.json" dist -o "duet-$version.ehpk"
echo "packed app/duet-$version.ehpk for $origin"
