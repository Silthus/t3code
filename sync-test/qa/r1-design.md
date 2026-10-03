You review a pull request. You did not write it. Review only: do not edit
files, commit, push, or post to GitHub. The repo is checked out at /home/coder/dev/wf-triage/wt-12 (HEAD 6d4a23fb7); read files there.

Goal: Fork Silthus/t3code `main` must keep tracking upstream pingdotgg/t3code `main` automatically (every 6 hours, plus manual dispatch), and the inherited upstream workflows must never run on the fork. A conflict opens (or updates) one GitHub issue listing the conflicting files; a later successful sync closes it. A local fallback script lets a human run the same merge. Closes Silthus/t3code#12. Fork code lives under scripts/fork/ and .github/workflows/fork-*.
Base: origin/main. Head: 6d4a23fb7. The diff is below.
Danger areas: .github/workflows/fork-sync-upstream.yml (token handling: secrets.FORK_SYNC_TOKEN || github.token embedded in the push URL; permissions actions/contents/issues write; schedule), scripts/fork/sync-upstream.sh (pushes to origin main; never force-push), scripts/fork/quiet-upstream-workflows.sh (disables workflows through the API).
Settled: (none yet; this is round 1 of a new ledger)
Known and out of scope: a push made with GITHUB_TOKEN does not trigger other workflows (so a future fork Mac build, ticket #13, will not fire from a sync push). That is a documented follow-up for #13; do not raise it.

Read each changed hunk with its surrounding code, callers, and types before
you judge it. Report a finding only when you can name its concrete trigger and
its concrete consequence under intended use. When one cause breaks the same
rule at more than one site, report it once and list every site.

Style counts when it breaks a named standard: the repo's documented rules
(AGENTS.md at the repo root) or these Coding preferences: keep it simple
(YAGNI), clean self-explaining code, no comment noise, tests focused and
outside-in. Taste without a standard is not a finding.

End with:

FINDINGS:
- <file>:<line> | <blocker|major|minor|nit> | <lens> | <trigger> -> <consequence> | <fix> | sites: <file:line, ...>
(or "(none)")
COVERED: <every changed file you cleared or flagged>

You are done when every changed file is cleared or flagged against every
hunting ground of your lens.

diff --git a/.github/workflows/fork-sync-upstream.yml b/.github/workflows/fork-sync-upstream.yml
new file mode 100644
index 000000000..f55c77107
--- /dev/null
+++ b/.github/workflows/fork-sync-upstream.yml
@@ -0,0 +1,59 @@
+name: Fork Sync Upstream
+
+on:
+  schedule:
+    - cron: "23 */6 * * *"
+  workflow_dispatch:
+
+permissions:
+  actions: write
+  contents: write
+  issues: write
+
+concurrency:
+  group: fork-sync-upstream
+  cancel-in-progress: false
+
+jobs:
+  sync:
+    name: Merge upstream main
+    runs-on: ubuntu-24.04
+    env:
+      GH_TOKEN: ${{ github.token }}
+    steps:
+      - name: Checkout main
+        uses: actions/checkout@v6
+        with:
+          ref: main
+          fetch-depth: 0
+          persist-credentials: false
+
+      # The scripts run from a pre-merge copy, so the merge never rewrites the
+      # code that is executing. GITHUB_TOKEN cannot push upstream changes to
+      # .github/workflows; the optional FORK_SYNC_TOKEN PAT (Contents and
+      # Workflows write) can. Only the push uses the token.
+      - name: Prepare sync
+        env:
+          PUSH_TOKEN: ${{ secrets.FORK_SYNC_TOKEN || github.token }}
+        run: |
+          echo "SCRIPTS=$RUNNER_TEMP/fork-scripts" >> "$GITHUB_ENV"
+          cp -R scripts/fork "$RUNNER_TEMP/fork-scripts"
+          git config user.name "github-actions[bot]"
+          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
+          git remote set-url --push origin "https://x-access-token:${PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
+
+      - id: sync
+        name: Merge and push
+        run: |
+          status=0
+          $SCRIPTS/sync-upstream.sh || status=$?
+          echo "status=$status" >> "$GITHUB_OUTPUT"
+
+      - name: Report outcome
+        env:
+          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
+        run: $SCRIPTS/report-sync-outcome.sh ${{ steps.sync.outputs.status }}
+
+      - name: Keep inherited workflows disabled
+        if: always()
+        run: $SCRIPTS/quiet-upstream-workflows.sh
diff --git a/scripts/fork/quiet-upstream-workflows.sh b/scripts/fork/quiet-upstream-workflows.sh
new file mode 100755
index 000000000..45ea99e44
--- /dev/null
+++ b/scripts/fork/quiet-upstream-workflows.sh
@@ -0,0 +1,18 @@
+#!/usr/bin/env bash
+# Disables every inherited workflow on the fork. Only workflows named
+# .github/workflows/fork-*.yml stay active. Safe to run repeatedly.
+# Usage: scripts/fork/quiet-upstream-workflows.sh [owner/repo]
+set -euo pipefail
+
+repo="${1:-${GITHUB_REPOSITORY:-Silthus/t3code}}"
+
+gh api --paginate "repos/$repo/actions/workflows" \
+  --jq '.workflows[]
+    | select(.state == "active")
+    | select(.path | startswith(".github/workflows/"))
+    | select(.path | startswith(".github/workflows/fork-") | not)
+    | "\(.id) \(.path)"' |
+  while read -r id path; do
+    gh api --silent -X PUT "repos/$repo/actions/workflows/$id/disable"
+    echo "disabled $path"
+  done
diff --git a/scripts/fork/report-sync-outcome.sh b/scripts/fork/report-sync-outcome.sh
new file mode 100755
index 000000000..b5c0da823
--- /dev/null
+++ b/scripts/fork/report-sync-outcome.sh
@@ -0,0 +1,84 @@
+#!/usr/bin/env bash
+# Keeps one open upstream-sync-conflict issue in step with the last sync run.
+# Called by .github/workflows/fork-sync-upstream.yml with the exit status of
+# scripts/fork/sync-upstream.sh, from the checkout that script left behind.
+# Usage: scripts/fork/report-sync-outcome.sh <sync-exit-status>
+# Env: GH_TOKEN, GITHUB_REPOSITORY, RUN_URL
+set -euo pipefail
+
+status="$1"
+label="upstream-sync-conflict"
+open_issue="$(gh issue list -R "$GITHUB_REPOSITORY" --label "$label" --state open \
+  --json number --jq '.[0].number // empty')"
+upstream_sha="$(git rev-parse --short upstream/main 2>/dev/null || echo unknown)"
+fork_sha="$(git rev-parse --short origin/main)"
+
+as_list() {
+  sed "s/.*/- \`&\`/"
+}
+
+conflict_body() {
+  cat <<EOF
+Upstream \`pingdotgg/t3code\` main (\`$upstream_sha\`) does not merge cleanly into fork \`main\` (\`$fork_sha\`).
+
+Conflicting files:
+
+$(git diff --name-only --diff-filter=U | as_list)
+
+Resolve it locally from a clean checkout of \`main\`:
+
+\`\`\`sh
+scripts/fork/sync-upstream.sh   # stops with the merge in progress
+# resolve the files above, then
+git commit --no-edit && git push origin main
+\`\`\`
+
+The next scheduled sync closes this issue. Run: $RUN_URL
+EOF
+}
+
+push_refused_body() {
+  local workflow_files
+  workflow_files="$(git diff --name-only origin/main HEAD -- .github/workflows)"
+  echo "Upstream \`pingdotgg/t3code\` main (\`$upstream_sha\`) merged cleanly, but the push to fork \`main\` was refused."
+  echo
+  if [[ -n "$workflow_files" ]]; then
+    cat <<EOF
+Upstream changed workflow files, which only a token with Workflows write can push:
+
+$(echo "$workflow_files" | as_list)
+
+Add or renew the \`FORK_SYNC_TOKEN\` secret: a fine-grained PAT for \`$GITHUB_REPOSITORY\` with Contents and Workflows read/write. Or run \`scripts/fork/sync-upstream.sh\` locally.
+EOF
+  else
+    echo "Fork \`main\` moved during the run, or a rule or an expired \`FORK_SYNC_TOKEN\` refused the push. The run log has git's reason."
+  fi
+  echo
+  echo "Run: $RUN_URL"
+}
+
+report_blocked() {
+  local body="$1"
+  gh label create "$label" -R "$GITHUB_REPOSITORY" --color d93f0b \
+    --description "Scheduled upstream merge into main needs a human" --force >/dev/null
+  if [[ -n "$open_issue" ]]; then
+    gh issue edit "$open_issue" -R "$GITHUB_REPOSITORY" --body "$body" >/dev/null
+    echo "updated issue #$open_issue"
+  else
+    gh issue create -R "$GITHUB_REPOSITORY" --title "Upstream sync is blocked" \
+      --label "$label" --body "$body"
+  fi
+}
+
+case "$status" in
+  0)
+    if [[ -n "$open_issue" ]]; then
+      gh issue close "$open_issue" -R "$GITHUB_REPOSITORY" \
+        --comment "Fork \`main\` contains upstream \`$upstream_sha\` again. Run: $RUN_URL"
+    fi
+    ;;
+  2) report_blocked "$(conflict_body)" ;;
+  3) report_blocked "$(push_refused_body)" ;;
+esac
+
+exit "$status"
diff --git a/scripts/fork/sync-upstream.sh b/scripts/fork/sync-upstream.sh
new file mode 100755
index 000000000..d68b9005c
--- /dev/null
+++ b/scripts/fork/sync-upstream.sh
@@ -0,0 +1,44 @@
+#!/usr/bin/env bash
+# Merges upstream pingdotgg/t3code main into the fork's main and pushes it.
+# Run from a clean checkout of main. Never force-pushes. On a conflict the
+# merge stays in progress: resolve it, then `git commit && git push origin main`.
+# The merge commit carries [skip ci] so inherited push workflows that upstream
+# adds never fire before the sync workflow disables them.
+# Usage: scripts/fork/sync-upstream.sh
+# Exit codes: 0 synced or already up to date, 1 refused or failed,
+#             2 merge conflict, 3 push refused.
+set -euo pipefail
+
+upstream_url="https://github.com/pingdotgg/t3code.git"
+
+fail() {
+  echo "sync-upstream: $1" >&2
+  exit "${2:-1}"
+}
+
+[[ "$(git branch --show-current)" == "main" ]] || fail "check out main first"
+[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "working tree has uncommitted changes"
+
+git fetch --no-tags origin main
+git fetch --no-tags "$upstream_url" +main:refs/remotes/upstream/main
+
+git merge --ff-only --quiet origin/main || fail "local main has diverged from origin/main"
+[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
+  fail "local main has commits that are not on origin/main; push or drop them first"
+
+upstream_sha="$(git rev-parse --short upstream/main)"
+if git merge-base --is-ancestor upstream/main HEAD; then
+  echo "sync-upstream: main already contains upstream $upstream_sha"
+  exit 0
+fi
+
+if ! git merge --no-ff -m "Merge upstream pingdotgg/t3code main ($upstream_sha) [skip ci]" upstream/main; then
+  conflicts="$(git diff --name-only --diff-filter=U)"
+  [[ -n "$conflicts" ]] || fail "merge of upstream/main failed"
+  echo "sync-upstream: conflicts with upstream $upstream_sha:" >&2
+  echo "$conflicts" >&2
+  exit 2
+fi
+
+git push origin HEAD:main || fail "push to origin main was refused" 3
+echo "sync-upstream: merged upstream $upstream_sha into main"

Lens: Design

Is this the simplest code that meets the goal, and is it clean?
- Simple design, in order: it passes the tests, reveals its intent, says each thing once, and has no superfluous parts.
- Removal first: every new branch, flag, fallback, alias, mode, or parameter that the goal does not need. The fix is to delete it.
- Names and small functions that explain the code instead of comments, YAGNI.
- Naming: names that hide what a thing holds or does, stale copied names.
- Fit: the idioms and patterns of the surrounding code (other workflows in .github/workflows, other scripts).
Leave untouched lines alone, and leave short, clear code unextracted.
