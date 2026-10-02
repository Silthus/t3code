#!/usr/bin/env bash
# Merges upstream pingdotgg/t3code main into the fork's main and pushes it.
# Run from a checkout of main. Never force-pushes.
# Usage: scripts/fork/sync-upstream.sh [--no-push]
# Exit codes: 0 synced or already up to date, 1 refused or failed,
#             2 merge conflict (merge left in progress), 3 push refused.
set -euo pipefail

upstream_url="https://github.com/pingdotgg/t3code.git"

fail() {
  echo "sync-upstream: $1" >&2
  exit "${2:-1}"
}

case "${1:-}" in
  "") push=true ;;
  --no-push) push=false ;;
  *) fail "usage: $0 [--no-push]" ;;
esac

[[ "$(git branch --show-current)" == "main" ]] || fail "check out main first"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "working tree has uncommitted changes"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$upstream_url"
fi

git fetch --no-tags origin main
git fetch --no-tags upstream main

git merge --ff-only --quiet origin/main || fail "local main has diverged from origin/main"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
  fail "local main has commits that are not on origin/main; push or drop them first"

if git merge-base --is-ancestor upstream/main HEAD; then
  echo "sync-upstream: main already contains upstream $(git rev-parse --short upstream/main)"
  exit 0
fi

if ! git merge --no-edit upstream/main; then
  conflicts="$(git diff --name-only --diff-filter=U)"
  [[ -n "$conflicts" ]] || fail "merge of upstream/main failed"
  echo "sync-upstream: conflicts with upstream $(git rev-parse --short upstream/main):" >&2
  echo "$conflicts" >&2
  exit 2
fi

if [[ "$push" == true ]]; then
  git push origin HEAD:main || fail "push to origin main was refused" 3
fi
echo "sync-upstream: merged upstream $(git rev-parse --short upstream/main) into main"
