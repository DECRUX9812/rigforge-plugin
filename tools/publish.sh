#!/usr/bin/env bash
# Publish the submission: push the plugin repo, pin the catalog entry to the
# exact SHA that was pushed, and print the two remaining commands.
#
# Dry run by default — it prints every command it would run and changes nothing.
#   tools/publish.sh            # show the plan
#   tools/publish.sh --apply    # do the pushes
#
# Why a script: the catalog entry pins a commit SHA. Pinning before pushing, or
# pushing without pinning, both ship a marketplace page that installs a version
# nobody tested — the exact failure this repo spent a dozen passes removing.
set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK_DIR="${FORK_DIR:-$HOME/Code/hermes-agent-contrib}"
FORK_BRANCH="rigforge-catalog"
CATALOG_PATH="plugin-catalog/rigforge.yaml"

run() {
  if [ "$APPLY" = "1" ]; then
    echo "+ $*"
    eval "$@"
  else
    echo "  would run: $*"
  fi
}

cd "$PLUGIN_DIR"

if [ -n "$(git status --porcelain)" ]; then
  echo "! working tree is dirty — commit first, the pin must match a real commit" >&2
  git status --short | head -10 >&2
  exit 1
fi

AHEAD=$(git rev-list --count origin/master..HEAD 2>/dev/null || echo "?")
echo "• local commits ahead of origin/master: $AHEAD"
echo "• head: $(git rev-parse --short HEAD)  $(git log -1 --pretty=%s | cut -c1-60)"

echo
echo "1) push the plugin repo"
run "git push origin master"

SHA=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)
echo "• catalog will pin: $SHA"

echo
echo "2) update the catalog entry to that SHA"
if [ ! -d "$FORK_DIR" ]; then
  run "git clone --depth 50 -b $FORK_BRANCH https://github.com/DECRUX9812/hermes-agent-contrib.git $FORK_DIR"
fi
if [ -d "$FORK_DIR" ]; then
  # render the whole entry from the template: sha, version, screenshots, tools.
  # A regex that only swapped the sha left the description advertising five
  # archetypes and two tools, which is what a marketplace browser reads first.
  run "python3 - '$FORK_DIR/$CATALOG_PATH' '$SHA' <<'PY'
import sys
path, sha = sys.argv[1], sys.argv[2]
tpl = open('$PLUGIN_DIR/tools/catalog-entry.yaml.tpl').read()
open(path, 'w').write(tpl.replace('__SHA__', sha))
print('catalog pinned to', sha[:7])
PY"
  run "cd $FORK_DIR && git add $CATALOG_PATH && git -c user.name=decrux -c user.email=decrux@local commit -m 'catalog: rigforge $SHORT — ten archetypes, board track, audit/compare, live prices'" >/dev/null
  echo
  echo "3) push the fork so the PR updates"
  run "cd $FORK_DIR && git push origin $FORK_BRANCH"
else
  echo "! $FORK_DIR missing — clone the fork first:" >&2
  echo "  git clone -b $FORK_BRANCH https://github.com/DECRUX9812/hermes-agent-contrib.git $FORK_DIR" >&2
fi

echo
echo "4) refresh the PR text (the body predates the board track, audit and compare)"
echo "  gh pr edit 149127 --repo NousResearch/hermes-agent --body-file docs/pr-body.md"
echo
echo "5) the entry itself"
echo "  post the demo video on X, tag @NousResearch, then submit:"
echo "  https://form.typeform.com/to/FwJLvOln   (PR 149127 + the post)"
