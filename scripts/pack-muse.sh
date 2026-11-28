#!/usr/bin/env bash
# Build Hey Muse (the Muse build of the same app: VITE_DUET_BRAIN=muse) and pack its .ehpk with YOUR server baked in.
#   DUET_MUSE_URL=https://my-server.example/duet-muse  [DUET_MUSE_TOKEN=...]  scripts/pack-muse.sh
# app.muse.json keeps a placeholder host; the real one only goes into the build. Duet (Claude) is packed by pack.sh.
set -euo pipefail
: "${DUET_MUSE_URL:?set DUET_MUSE_URL to your Hey Muse server, e.g. https://my-server.example/duet-muse}"
cd "$(dirname "$0")/../app"
origin=$(node -e 'const u=new URL(process.argv[1]); console.log(u.origin)' "$DUET_MUSE_URL")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
node -e '
  const fs=require("fs"); const m=JSON.parse(fs.readFileSync("app.muse.json","utf8"));
  for (const p of m.permissions) if (p.name==="network") p.whitelist=[process.argv[1]];
  fs.writeFileSync(process.argv[2], JSON.stringify(m,null,2));' "$origin" "$work/app.json"
VITE_DUET_URL="$DUET_MUSE_URL" VITE_DUET_TOKEN="${DUET_MUSE_TOKEN:-}" npm run check:muse
version=$(node -p 'require("./app.muse.json").version')
npx evenhub pack "$work/app.json" dist-muse -o "duetmuse-$version.ehpk"
echo "packed app/duetmuse-$version.ehpk for $origin"
