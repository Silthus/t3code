#!/usr/bin/env bash
# Disables every inherited workflow on the fork. Only workflows named
# .github/workflows/fork-*.yml stay active. Safe to run repeatedly.
# Usage: scripts/fork/quiet-upstream-workflows.sh [owner/repo]
set -euo pipefail

repo="${1:-${GITHUB_REPOSITORY:-Silthus/t3code}}"

gh api --paginate "repos/$repo/actions/workflows" \
  --jq '.workflows[]
    | select(.state == "active")
    | select(.path | startswith(".github/workflows/"))
    | select(.path | startswith(".github/workflows/fork-") | not)
    | "\(.id) \(.path)"' |
  while read -r id path; do
    gh api --silent -X PUT "repos/$repo/actions/workflows/$id/disable"
    echo "disabled $path"
  done
