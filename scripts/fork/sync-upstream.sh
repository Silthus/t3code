#!/usr/bin/env bash
# Merges upstream pingdotgg/t3code main into the fork's main and pushes it.
# Run from a clean checkout of main. Never force-pushes. On a conflict the
# merge stays in progress: resolve it, then `git commit && git push origin main`.
# The merge commit carries [skip ci] so inherited push workflows that upstream
# adds never fire before the sync workflow disables them.
# Usage: scripts/fork/sync-upstream.sh
# Exit codes: 0 synced or already up to date, 1 refused or failed,
#             2 merge conflict, 3 push refused.
set -euo pipefail

upstream_url="https://github.com/pingdotgg/t3code.git"

fail() {
  echo "sync-upstream: $1" >&2
  exit "${2:-1}"
}

[[ "$(git branch --show-current)" == "main" ]] || fail "check out main first"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "working tree has uncommitted changes"

git fetch --no-tags origin main
git fetch --no-tags "$upstream_url" +main:refs/remotes/upstream/main

git merge --ff-only --quiet origin/main || fail "local main has diverged from origin/main"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
  fail "local main has commits that are not on origin/main; push or drop them first"

upstream_sha="$(git rev-parse --short upstream/main)"
if git merge-base --is-ancestor upstream/main HEAD; then
  echo "sync-upstream: main already contains upstream $upstream_sha"
  exit 0
fi

if ! git merge --no-ff -m "Merge upstream pingdotgg/t3code main ($upstream_sha) [skip ci]" upstream/main; then
  conflicts="$(git diff --name-only --diff-filter=U)"
  [[ -n "$conflicts" ]] || fail "merge of upstream/main failed"
  echo "sync-upstream: conflicts with upstream $upstream_sha:" >&2
  echo "$conflicts" >&2
  exit 2
fi

git push origin HEAD:main || fail "push to origin main was refused" 3
echo "sync-upstream: merged upstream $upstream_sha into main"
