#!/usr/bin/env bash
# Release helper for obsidian-chat.
#
# Usage:
#   scripts/release.sh <version> [notes-file]
#   scripts/release.sh 1.3.0
#   scripts/release.sh 1.3.0 release-notes.md
#
# Steps:
#   1. Validate version (X.Y.Z) and clean working tree
#   2. Bump manifest.json, package.json, versions.json
#   3. Build production bundle (main.js)
#   4. Commit, tag, push main + tag
#   5. Create GitHub release with main.js, manifest.json, styles.css

set -euo pipefail

VERSION="${1:-}"
NOTES_FILE="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "error: version required. usage: $0 <version> [notes-file]" >&2
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be X.Y.Z (got '$VERSION')" >&2
  exit 1
fi

# Repo root
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty. commit or stash first." >&2
  git status --short >&2
  exit 1
fi

if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "error: tag $VERSION already exists." >&2
  exit 1
fi

echo "==> Bumping to $VERSION"

MIN_APP_VERSION="$(node -p "require('./manifest.json').minAppVersion")"

node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('manifest.json','utf8'));
  m.version = '$VERSION';
  fs.writeFileSync('manifest.json', JSON.stringify(m) + '\n');
  const p = JSON.parse(fs.readFileSync('package.json','utf8'));
  p.version = '$VERSION';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  const v = JSON.parse(fs.readFileSync('versions.json','utf8'));
  v['$VERSION'] = '$MIN_APP_VERSION';
  fs.writeFileSync('versions.json', JSON.stringify(v, null, 2) + '\n');
"

echo "==> Building"
npm run build >/dev/null

for f in main.js manifest.json styles.css; do
  [[ -f "$f" ]] || { echo "error: missing release asset $f" >&2; exit 1; }
done

echo "==> Committing & tagging"
git add manifest.json package.json versions.json
git commit -m "Release $VERSION"
git tag -a "$VERSION" -m "Release $VERSION"

echo "==> Pushing"
git push origin main
git push origin "$VERSION"

echo "==> Creating GitHub release"
if [[ -n "$NOTES_FILE" && -f "$NOTES_FILE" ]]; then
  gh release create "$VERSION" main.js manifest.json styles.css \
    --title "$VERSION" --notes-file "$NOTES_FILE"
else
  gh release create "$VERSION" main.js manifest.json styles.css \
    --title "$VERSION" --generate-notes
fi

echo "==> Done: https://github.com/omarshahine/obsidian-chat/releases/tag/$VERSION"
