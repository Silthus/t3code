#!/usr/bin/env bash
# Keeps one open upstream-sync-conflict issue in step with the last sync run.
# Called by .github/workflows/fork-sync-upstream.yml with the exit status of
# scripts/fork/sync-upstream.sh, from the checkout that script left behind.
# Usage: scripts/fork/report-sync-outcome.sh <sync-exit-status>
# Env: GH_TOKEN, GITHUB_REPOSITORY, RUN_URL
set -euo pipefail

status="$1"
label="upstream-sync-conflict"
open_issue="$(gh issue list -R "$GITHUB_REPOSITORY" --label "$label" --state open \
  --json number --jq '.[0].number // empty')"
upstream_sha="$(git rev-parse --short upstream/main 2>/dev/null || echo unknown)"
fork_sha="$(git rev-parse --short origin/main)"

as_list() {
  sed "s/.*/- \`&\`/"
}

conflict_body() {
  cat <<EOF
Upstream \`pingdotgg/t3code\` main (\`$upstream_sha\`) does not merge cleanly into fork \`main\` (\`$fork_sha\`).

Conflicting files:

$(git diff --name-only --diff-filter=U | as_list)

Resolve it locally from a clean checkout of \`main\`:

\`\`\`sh
scripts/fork/sync-upstream.sh   # stops with the merge in progress
# resolve the files above, then
git commit --no-edit && git push origin main
\`\`\`

The next scheduled sync closes this issue. Run: $RUN_URL
EOF
}

push_refused_body() {
  local workflow_files
  workflow_files="$(git diff --name-only origin/main HEAD -- .github/workflows)"
  echo "Upstream \`pingdotgg/t3code\` main (\`$upstream_sha\`) merged cleanly, but the push to fork \`main\` was refused."
  echo
  if [[ -n "$workflow_files" ]]; then
    cat <<EOF
Upstream changed workflow files, which only a token with Workflows write can push:

$(echo "$workflow_files" | as_list)

Add or renew the \`FORK_SYNC_TOKEN\` secret: a fine-grained PAT for \`$GITHUB_REPOSITORY\` with Contents and Workflows read/write. Or run \`scripts/fork/sync-upstream.sh\` locally.
EOF
  else
    echo "Fork \`main\` moved during the run, or a rule or an expired \`FORK_SYNC_TOKEN\` refused the push. The run log has git's reason."
  fi
  echo
  echo "Run: $RUN_URL"
}

report_blocked() {
  local body="$1"
  gh label create "$label" -R "$GITHUB_REPOSITORY" --color d93f0b \
    --description "Scheduled upstream merge into main needs a human" --force >/dev/null
  if [[ -n "$open_issue" ]]; then
    gh issue edit "$open_issue" -R "$GITHUB_REPOSITORY" --body "$body" >/dev/null
    echo "updated issue #$open_issue"
  else
    gh issue create -R "$GITHUB_REPOSITORY" --title "Upstream sync is blocked" \
      --label "$label" --body "$body"
  fi
}

case "$status" in
  0)
    if [[ -n "$open_issue" ]]; then
      gh issue close "$open_issue" -R "$GITHUB_REPOSITORY" \
        --comment "Fork \`main\` contains upstream \`$upstream_sha\` again. Run: $RUN_URL"
    fi
    ;;
  2) report_blocked "$(conflict_body)" ;;
  3) report_blocked "$(push_refused_body)" ;;
esac

exit "$status"
