#!/usr/bin/env bash
# Disables every inherited workflow on the fork. Only the fork's own
# .github/workflows/fork-*.yml and GitHub's dynamic workflows stay active.
# Safe to run repeatedly.
# Usage: scripts/fork/quiet-upstream-workflows.sh [owner/repo]
set -euo pipefail
shopt -s lastpipe

repo="${1:-${GITHUB_REPOSITORY:-Silthus/t3code}}"
failed=0

gh api --paginate "repos/$repo/actions/workflows" \
  --jq '.workflows[]
    | select(.state == "active")
    | select(.path | startswith(".github/workflows/"))
    | select(.path | startswith(".github/workflows/fork-") | not)
    | "\(.id) \(.path)"' |
  while read -r id path; do
    if gh api --silent -X PUT "repos/$repo/actions/workflows/$id/disable"; then
      echo "disabled $path"
    else
      echo "could not disable $path" >&2
      failed=1
    fi
  done

exit "$failed"
