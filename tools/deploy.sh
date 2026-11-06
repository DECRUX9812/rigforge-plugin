#!/usr/bin/env bash
# Deploy the shipped plugin to both app directories — from a clean worktree, and
# only from code whose CI is green.
#
# Why this exists: the running app was found 4 merges behind once, and ~30 commits
# behind again two hours later. Deploying by hand from the working checkout is
# also unsafe here — another agent keeps uncommitted work in that tree, so a
# local build can ship half-finished code into the app.
#
#   tools/deploy.sh            # deploy origin/master if its CI is green
#   tools/deploy.sh --force    # deploy regardless
set -euo pipefail

cd "$(dirname "$0")/.."
FORCE="${1:-}"

git fetch origin --quiet
SHA=$(git rev-parse origin/master)
SHORT=${SHA:0:7}

if [ "$FORCE" != "--force" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh not installed — cannot check CI. Re-run with --force to override." >&2
    exit 1
  fi
  # A queued or in-progress run reports null conclusions. Calling that "red"
  # would refuse a perfectly good commit for the minute it takes CI to start;
  # it is "pending", and the answer is to wait rather than to override.
  STATUS=$(gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" \
    --jq '[.check_runs[] | select(.name=="engine claims (no browser)" or .name=="browser gates") | .conclusion] | if length == 0 then "pending" elif any(. == null) then "pending" elif all(. == "success") then "green" else "red" end' 2>/dev/null || echo unknown)

  case "$STATUS" in
    green) echo "CI on $SHORT is green" ;;
    red) echo "CI on $SHORT is red — refusing to deploy a red commit (--force to override)." >&2; exit 1 ;;
    *) echo "CI on $SHORT is still running or has not started. Wait a minute, or --force." >&2; exit 1 ;;
  esac
fi

WORK=$(mktemp -d)
cleanup() { git worktree remove --force "$WORK" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git worktree add --quiet --detach "$WORK" "$SHA"
ln -s "$PWD/node_modules" "$WORK/node_modules"
node "$WORK/build.mjs"
BUILT=$(sha256sum "$WORK/desktop/plugin.js" | cut -c1-12)

for dest in "$HOME/.hermes/desktop-plugins/rigforge" "$HOME/.hermes-webapp/desktop-plugins/rigforge"; do
  mkdir -p "$dest"
  cp "$WORK/desktop/plugin.js" "$dest/plugin.js"
  echo "deployed $SHORT ($BUILT) -> $dest"
done

echo "restart the app, or reload the web UI, to pick it up"
