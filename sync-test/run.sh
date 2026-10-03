#!/usr/bin/env bash
# Sandbox harness for scripts/fork/{sync-upstream,report-sync-outcome,quiet-upstream-workflows}.sh
# Usage: run.sh <scripts-dir>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(cd "${1:?scripts dir}" && pwd)"
W="$here/work"; rm -rf "$W"; mkdir -p "$W"
export PATH="$here/bin:$PATH" GH_LOG="$W/gh.log" GH_BODY="$W/gh.body" STUB_WORKFLOWS="$here/workflows.json"
export GITHUB_REPOSITORY=Silthus/t3code RUN_URL=https://example.test/run/1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL="$W/gitconfig"
git config --global url."file://$W/upstream.git".insteadOf https://github.com/pingdotgg/t3code.git
git config --global init.defaultBranch main
git config --global advice.detachedHead false
pass=0; fail=0
check() { if eval "$2"; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }
q() { "$@" >/dev/null 2>&1; }

git init -q --bare "$W/upstream.git"
git clone -q "$W/upstream.git" "$W/up"
( cd "$W/up" && mkdir -p .github/workflows && echo base >shared.txt && echo ci >.github/workflows/ci.yml && git add -A && git commit -qm base && git push -q origin main )
git clone -q --bare "$W/upstream.git" "$W/origin.git"
git clone -q "$W/origin.git" "$W/fork"
cd "$W/fork"

up_commit() { ( cd "$W/up" && mkdir -p "$(dirname "$1")" && echo "$2" >"$1" && git add -A && git commit -qm "$3" && git push -q origin main ); }
origin_commit() { ( rm -rf "$W/o2" && git clone -q "$W/origin.git" "$W/o2" && cd "$W/o2" && echo "$2" >"$1" && git add -A && git commit -qm "$3" && git push -q origin main ); }
sync() { : >"$GH_LOG"; rm -f "$GH_BODY"; "$SCRIPTS/sync-upstream.sh" >"$W/out" 2>&1; echo $?; }
report() { "$SCRIPTS/report-sync-outcome.sh" "$1" >>"$W/out" 2>&1; echo $?; }
show() { sed 's/^/    | /' "$W/out"; sed 's/^/    | /' "$GH_LOG"; }

echo "== A: already up to date"
s=$(sync); r=$(report "$s"); show
check "exit 0" '[[ $s == 0 && $r == 0 ]]'
check "no issue writes" '! grep -qE "issue (create|edit|close)" "$GH_LOG"'

echo "== B: dirty tree refused"
echo dirty >>shared.txt; s=$(sync); show; git checkout -q shared.txt
check "exit 1" '[[ $s == 1 ]]'

echo "== C: not on main refused"
git checkout -qb other; s=$(sync); show; git checkout -q main; git branch -qD other
check "exit 1" '[[ $s == 1 ]]'

echo "== D: clean upstream change merges and pushes"
up_commit up.txt one "upstream one"
s=$(sync); show
check "exit 0" '[[ $s == 0 ]]'
check "origin main contains upstream" 'git -C "$W/origin.git" merge-base --is-ancestor "$(git -C "$W/upstream.git" rev-parse main)" main'
check "merge commit, not fast-forward" '[[ $(git -C "$W/origin.git" rev-list --parents -n1 main | wc -w) == 3 ]]'
echo "    merge subject: $(git -C "$W/origin.git" log -1 --format=%s main)"

echo "== E: local commit not on origin refused"
echo local >local.txt; git add local.txt; git commit -qm local
s=$(sync); show; git reset -q --hard origin/main
check "exit 1" '[[ $s == 1 ]]'

echo "== E2: stale local main fast-forwards, then merges"
origin_commit fork.txt fork "fork work"; up_commit up.txt two "upstream two"
s=$(sync); show
check "exit 0" '[[ $s == 0 ]]'
check "origin keeps fork work" 'git -C "$W/origin.git" show main:fork.txt >/dev/null 2>&1'
check "origin has upstream two" '[[ $(git -C "$W/origin.git" show main:up.txt) == two ]]'

echo "== F: conflict leaves merge in progress and reports"
origin_commit shared.txt fork-side "fork edits shared"; up_commit shared.txt upstream-side "upstream edits shared"
q git pull -q --ff-only
s=$(sync); r=$(report "$s"); show; echo "    body:"; sed 's/^/    > /' "$GH_BODY"
check "exit 2, report 2" '[[ $s == 2 && $r == 2 ]]'
check "merge in progress" '[[ -f .git/MERGE_HEAD ]]'
check "issue created" 'grep -q "issue create" "$GH_LOG"'
check "body lists shared.txt" 'grep -q "shared.txt" "$GH_BODY"'
check "body stages before committing" 'grep -q "git add -u && git commit --no-edit" "$GH_BODY"'
check "body ends the manual path by dispatching the sync" 'grep -q "gh workflow run fork-sync-upstream.yml" "$GH_BODY"'
git merge --abort

echo "== G: conflict again with an open issue updates it"
export STUB_OPEN_ISSUE=42
s=$(sync); r=$(report "$s"); show
check "exit 2" '[[ $s == 2 && $r == 2 ]]'
check "issue 42 edited, none created" 'grep -q "issue edit 42" "$GH_LOG" && ! grep -q "issue create" "$GH_LOG"'

echo "== H: resolved by hand, next sync closes the issue"
echo resolved >shared.txt; git add -u && git commit -q --no-edit && git push -q origin main
s=$(sync); r=$(report "$s"); show
check "exit 0" '[[ $s == 0 && $r == 0 ]]'
check "issue 42 closed" 'grep -q "issue close 42" "$GH_LOG"'
unset STUB_OPEN_ISSUE

echo "== I: refused push of an upstream workflow change names the token"
cat >"$W/origin.git/hooks/pre-receive" <<'HOOK'
#!/usr/bin/env bash
while read -r old new ref; do
  if git diff --name-only "$old" "$new" -- .github/workflows | grep -q .; then
    echo "refusing to allow a GitHub App to create or update workflow without workflows permission" >&2; exit 1
  fi
done
HOOK
chmod +x "$W/origin.git/hooks/pre-receive"
up_commit .github/workflows/new.yml new "upstream adds workflow"
s=$(sync); r=$(report "$s"); show; echo "    body:"; sed 's/^/    > /' "$GH_BODY"
check "exit 3" '[[ $s == 3 && $r == 3 ]]'
check "body names the workflow file and FORK_SYNC_TOKEN" 'grep -q "new.yml" "$GH_BODY" && grep -q FORK_SYNC_TOKEN "$GH_BODY"'
check "body points to git's reason" 'grep -q "run log has git" "$GH_BODY"'
check "origin main unchanged" '! git -C "$W/origin.git" show main:.github/workflows/new.yml >/dev/null 2>&1'

echo "== J: refused push without workflow changes gets the generic reason"
git reset -q --hard origin/main
printf '#!/usr/bin/env bash\necho "protected branch" >&2; exit 1\n' >"$W/origin.git/hooks/pre-receive"
( cd "$W/up" && git rm -q .github/workflows/new.yml && git commit -qm "upstream drops workflow" && git push -q origin main )
up_commit up.txt three "upstream three"
s=$(sync); r=$(report "$s"); show; echo "    body:"; sed 's/^/    > /' "$GH_BODY"
check "exit 3" '[[ $s == 3 && $r == 3 ]]'
check "generic body" 'grep -q "moved during the run" "$GH_BODY"'
rm "$W/origin.git/hooks/pre-receive"; git reset -q --hard origin/main

echo "== L: failure status passes through without issue writes"
: >"$GH_LOG"; : >"$W/out"; r=$(report 1); show
check "exit 1" '[[ $r == 1 ]]'
check "no issue writes" '! grep -qE "issue (create|edit|close)|label create" "$GH_LOG"'

echo "== K: quiet disables active non-fork workflows only"
: >"$GH_LOG"; "$SCRIPTS/quiet-upstream-workflows.sh" >"$W/out" 2>&1; k=$?; show
check "exit 0" '[[ $k == 0 ]]'
check "disables 1 and 5 only" '[[ "$(grep -o "workflows/[0-9]*/disable" "$GH_LOG" | tr "\n" " ")" == "workflows/1/disable workflows/5/disable " ]]'

echo "== K2: a failed disable does not stop the sweep, and fails it"
: >"$GH_LOG"; STUB_FAIL_DISABLE=1 "$SCRIPTS/quiet-upstream-workflows.sh" >"$W/out" 2>&1; k=$?; show
check "exit non-zero" '[[ $k != 0 ]]'
check "still disables 5" 'grep -q "workflows/5/disable" "$GH_LOG"'

echo "== $pass passed, $fail failed"
[[ $fail == 0 ]]
