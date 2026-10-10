#!/usr/bin/env bash
# Release helper for obsidian-chat. Main is only ever changed through a PR.
#
# Usage:
#   scripts/release.sh prepare <version> [--dry-run]
#   scripts/release.sh tag <version> [notes-file] [--dry-run]
#
# prepare: from a clean, current main, bump manifest.json, package.json,
#          package-lock.json and versions.json on a release/<version> branch,
#          push it and open a PR. Merge that PR on green CI.
# tag:     once the bump is merged, verify main has it, the checkout is clean
#          and current, and main CI is green on HEAD. Then build, create a
#          signed annotated tag <version> (no "v" prefix), push it, and create
#          the GitHub release with main.js, manifest.json and styles.css.
#
# --dry-run runs every check and prints the commands that would change
# anything, without running them.

set -euo pipefail

REPO="omarshahine/obsidian-chat"
ASSETS=(main.js manifest.json styles.css)

DRY_RUN=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then DRY_RUN=1; else ARGS+=("$arg"); fi
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

COMMAND="${1:-}"
VERSION="${2:-}"

die() { echo "error: $*" >&2; exit 1; }

# Run a command that changes state, or just print it on a dry run.
run() {
  if (( DRY_RUN )); then
    echo "    [dry-run] $*"
  else
    "$@"
  fi
}

usage() {
  sed -n '4,6p' "$0" | sed 's/^# //' >&2
  exit 1
}

[[ "$COMMAND" == "prepare" || "$COMMAND" == "tag" ]] || usage
[[ -n "$VERSION" ]] || usage
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z (got '$VERSION')"

# Repo root
cd "$(dirname "$0")/.."

require_clean_current_main() {
  [[ -z "$(git status --porcelain)" ]] || { git status --short >&2; die "working tree is dirty."; }
  [[ "$(git branch --show-current)" == "main" ]] || die "not on main."
  git fetch -q origin main --tags
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
    || die "main is not at origin/main. Run: git pull --ff-only"
}

require_tag_absent() {
  if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null \
    || git ls-remote --exit-code --tags origin "refs/tags/$VERSION" >/dev/null 2>&1; then
    die "tag $VERSION already exists."
  fi
}

# Every version file must say $VERSION, and versions.json must list it.
check_versions() {
  node -e "
    const fs = require('fs');
    const v = process.argv[1];
    const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    const m = read('manifest.json'), p = read('package.json'), l = read('package-lock.json');
    const vs = read('versions.json');
    const bad = [];
    if (m.version !== v) bad.push('manifest.json=' + m.version);
    if (p.version !== v) bad.push('package.json=' + p.version);
    if (l.version !== v || l.packages[''].version !== v) bad.push('package-lock.json=' + l.version);
    if (vs[v] !== m.minAppVersion) bad.push('versions.json[' + v + ']=' + vs[v]);
    if (bad.length) { console.error('version mismatch: ' + bad.join(', ')); process.exit(1); }
  " "$VERSION"
}

# manifest.json and versions.json; npm version handles package.json and its lockfile.
bump_manifest_and_versions() {
  node -e "
    const fs = require('fs');
    const v = process.argv[1];
    const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    m.version = v;
    fs.writeFileSync('manifest.json', JSON.stringify(m) + '\\n');
    const vs = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
    vs[v] = m.minAppVersion;
    fs.writeFileSync('versions.json', JSON.stringify(vs, null, 2) + '\\n');
  " "$VERSION"
}

prepare() {
  require_clean_current_main
  require_tag_absent
  local branch="release/$VERSION"
  if git rev-parse -q --verify "refs/heads/$branch" >/dev/null \
    || git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    die "branch $branch already exists."
  fi

  echo "==> Bumping to $VERSION on $branch"
  run git switch -c "$branch"
  # npm version keeps package.json and package-lock.json in step.
  run npm version "$VERSION" --no-git-tag-version
  run bump_manifest_and_versions
  (( DRY_RUN )) || check_versions

  echo "==> Building (sanity check)"
  run npm run build

  echo "==> Committing and opening PR"
  run git add manifest.json package.json package-lock.json versions.json
  run git commit -m "Release $VERSION"
  run git push -u origin "$branch"
  run gh pr create --repo "$REPO" --base main --head "$branch" \
    --title "Release $VERSION" \
    --body "Bumps manifest.json, package.json, package-lock.json and versions.json to $VERSION. After this merges on green CI, run \`scripts/release.sh tag $VERSION\`."

  echo "==> Next: merge the PR on green CI, then: git switch main && git pull --ff-only && scripts/release.sh tag $VERSION [notes-file]"
}

tag() {
  local notes="${3:-}"
  [[ -z "$notes" || -f "$notes" ]] || die "notes file not found: $notes"

  require_clean_current_main
  require_tag_absent
  check_versions || die "main does not have the $VERSION bump. Merge the release PR first."

  local sha
  sha="$(git rev-parse HEAD)"
  echo "==> Checking main CI on ${sha:0:7}"
  local ci
  ci="$(gh run list --repo "$REPO" --branch main --commit "$sha" --workflow CI \
    --json status,conclusion --jq '.[0] | "\(.status) \(.conclusion)"')"
  [[ "$ci" == "completed success" ]] || die "main CI on ${sha:0:7} is '${ci:-not found}', not 'completed success'."

  echo "==> Building"
  # The build overwrites main.js, so a dry run only prints it and skips the
  # checks on its output.
  run npm run build
  if (( ! DRY_RUN )); then
    for f in "${ASSETS[@]}"; do
      [[ -f "$f" ]] || die "missing release asset $f"
    done
    [[ -z "$(git status --porcelain)" ]] || die "build changed tracked files."
  fi

  echo "==> Tagging $VERSION at ${sha:0:7}"
  # Signed and annotated, no "v" prefix, matching earlier releases.
  run git tag -s -a "$VERSION" -m "Release $VERSION" "$sha"
  run git push origin "refs/tags/$VERSION"

  echo "==> Creating GitHub release"
  if [[ -n "$notes" ]]; then
    run gh release create "$VERSION" "${ASSETS[@]}" --repo "$REPO" \
      --title "$VERSION" --notes-file "$notes" --verify-tag
  else
    run gh release create "$VERSION" "${ASSETS[@]}" --repo "$REPO" \
      --title "$VERSION" --generate-notes --verify-tag
  fi

  if (( ! DRY_RUN )); then
    local got
    got="$(gh release view "$VERSION" --repo "$REPO" --json assets --jq '[.assets[].name] | sort | join(",")')"
    [[ "$got" == "main.js,manifest.json,styles.css" ]] || die "release assets are '$got'."
  fi

  echo "==> Done: https://github.com/$REPO/releases/tag/$VERSION"
}

"$COMMAND" "$@"
