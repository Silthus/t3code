#!/usr/bin/env bash
# Keeps one open fork-build-broken issue in step with the fork Mac build.
# A broken build opens the issue or adds its run to the open one; the next
# green build closes it. Broken builds never publish, so fork-desktop-latest
# keeps the last good app.
# Called by .github/workflows/fork-desktop-mac.yml.
# Usage: scripts/fork/report-build-outcome.sh <success|failure>
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, RUN_URL
set -euo pipefail

outcome="$1"
label="fork-build-broken"
commit="${GITHUB_SHA:0:7}"
open_issue="$(gh issue list -R "$GITHUB_REPOSITORY" --label "$label" --state open \
  --json number --jq '.[0].number // empty')"

broken_body() {
  cat <<EOF
The fork Mac build of \`main\` at \`$commit\` failed. Run: $RUN_URL

\`fork-desktop-latest\` still serves the last good build, so the installer keeps working. A green build of \`main\` closes this issue.
EOF
}

case "$outcome" in
  failure)
    if [[ -n "$open_issue" ]]; then
      gh issue comment "$open_issue" -R "$GITHUB_REPOSITORY" \
        --body "Still broken at \`$commit\`. Run: $RUN_URL"
    else
      gh label create "$label" -R "$GITHUB_REPOSITORY" --color d93f0b \
        --description "The fork Mac build of main is failing" --force >/dev/null
      gh issue create -R "$GITHUB_REPOSITORY" --title "Fork Mac build is broken" \
        --label "$label" --body "$(broken_body)"
    fi
    ;;
  success)
    if [[ -n "$open_issue" ]]; then
      gh issue close "$open_issue" -R "$GITHUB_REPOSITORY" \
        --comment "Green again at \`$commit\`, and \`fork-desktop-latest\` serves it. Run: $RUN_URL"
    fi
    ;;
  *)
    echo "report-build-outcome: expected success or failure, got '$outcome'" >&2
    exit 1
    ;;
esac
