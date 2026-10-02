#!/usr/bin/env bash
# Disables every inherited workflow on the fork and cancels its pending runs.
# Only workflows named .github/workflows/fork-*.yml stay active.
# Usage: scripts/fork/quiet-upstream-workflows.sh [owner/repo]
set -euo pipefail

repo="${1:-${GITHUB_REPOSITORY:-Silthus/t3code}}"
fork_prefix=".github/workflows/fork-"

gh api --paginate "repos/$repo/actions/workflows" \
  --jq ".workflows[]
    | select(.state == \"active\")
    | select(.path | startswith(\".github/workflows/\"))
    | select(.path | startswith(\"$fork_prefix\") | not)
    | \"\(.id) \(.path)\"" |
  while read -r id path; do
    gh api --silent -X PUT "repos/$repo/actions/workflows/$id/disable"
    echo "disabled $path"
  done

for status in queued in_progress waiting; do
  gh api --paginate "repos/$repo/actions/runs?status=$status" \
    --jq ".workflow_runs[]
      | select(.path | startswith(\"$fork_prefix\") | not)
      | \"\(.id) \(.path)\"" |
    while read -r id path; do
      gh api --silent -X POST "repos/$repo/actions/runs/$id/cancel" || true
      echo "cancelled run $id of $path"
    done
done
