#!/bin/sh
# Publish a release: tools/release.sh 0.1.1
# Bumps module.json (version + download URL), commits, tags vX.Y.Z, builds module.zip via git archive
# (files marked export-ignore in .gitattributes are left out), and creates a GitHub release with module.zip + module.json.
set -e
VER="$1"
[ -n "$VER" ] || { echo "usage: tools/release.sh <version>"; exit 1; }
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit first"; exit 1; }
node -e '
const fs = require("fs"); const v = process.argv[1];
const m = JSON.parse(fs.readFileSync("module.json", "utf8"));
m.version = v;
m.download = `https://github.com/evanwapowell/claude-gm-tools/releases/download/v${v}/module.zip`;
fs.writeFileSync("module.json", JSON.stringify(m, null, 2) + "\n");
' "$VER"
git add module.json
git diff --cached --quiet || git commit -q -m "Release v$VER"
git tag "v$VER"
git push -q origin main "v$VER"
mkdir -p dist
git archive --format=zip -o dist/module.zip "v$VER"
cp module.json dist/module.json
gh release create "v$VER" dist/module.zip dist/module.json --title "v$VER" --notes "Claude GM Tools v$VER"
echo "released v$VER"
