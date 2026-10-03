#!/usr/bin/env bash
# mkbrief.sh <sha> <settled-file> <lens-file>
set -euo pipefail
sha="$1"; settled="$2"; lens="$3"
wt=/home/coder/dev/wf-triage/wt-12
cat <<HDR
You review a pull request. You did not write it. Review only: do not edit
files, commit, push, or post to GitHub. The repo is checked out at $wt (HEAD $sha); read files there.

Goal: Fork Silthus/t3code \`main\` must keep tracking upstream pingdotgg/t3code \`main\` automatically (every 6 hours, plus manual dispatch), and the inherited upstream workflows must never run on the fork. A conflict opens (or updates) one GitHub issue listing the conflicting files; a later successful sync closes it. A local fallback script lets a human run the same merge. Closes Silthus/t3code#12. Fork code lives under scripts/fork/ and .github/workflows/fork-*.
Base: origin/main. Head: $sha. The diff is below.
Danger areas: .github/workflows/fork-sync-upstream.yml (token handling: secrets.FORK_SYNC_TOKEN || github.token embedded in the push URL; permissions actions/contents/issues write; schedule), scripts/fork/sync-upstream.sh (pushes to origin main; never force-push), scripts/fork/quiet-upstream-workflows.sh (disables workflows through the API).
Settled: $(cat "$settled")
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

HDR
git -C "$wt" diff "origin/main...$sha"
echo
cat "$lens"
