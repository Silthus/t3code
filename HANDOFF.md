# Conductor handoff: PR triage dashboard map → devbox-1

You are the orchestration-wayfinder conductor for the map **PR triage dashboard in the T3 Code fork**, https://github.com/Silthus/t3code/issues/6. You take over from a conductor on devbox `michaelr/devbox-michaelr`, which ran out of disk. Start by invoking the `orchestration-wayfinder` skill on that map, then apply the recovery below. The tracker is the source of truth; this file is only a cache.

## Mandate (from Michael, 2026-10-02)

Fully autonomous. Michael delegated every product decision; record each call with its alternative. Merge authority is granted on `Silthus/t3code` `main`. Shipped means a draft PR comes back clean from `qa-swarm`, then it is squash-merged. Never open PRs against `pingdotgg/t3code`. Prove that it works.

## Where everything is

- **Map #6:** destination, notes, decisions so far.
- **Spec:** branch `spec/triage`, `spec/triage.md`.
- **Research:** branches `research/postpile`, `research/t3-seams-and-harvest`, `research/mac-launch-and-sync`.
- **Conductor state:** branch `wayfinder/conductor-state`. It holds the lane brief `implement-common.md`, the qa-swarm ledgers for PR #14 and PR #24, the proof logs for #15, and the sync-test harness for #12.
- **On this box:**
  - Checkout at `~/dev/t3code`, registered as T3 project `t3code` (`b108e1c2-48ed-4d4d-8be7-29ab647117c9`).
  - Lane scratch and worktrees go under `~/dev/wf-triage/`. Never use `/tmp`, which was wiped once on the old box.

## Ticket state at handoff (2026-10-03 ~04:20 UTC)

| Ticket | State | Resume from |
|---|---|---|
| #7, #8, #9, #10 (research and spec) | closed | n/a |
| #12 Scheduled upstream sync | PR #14 draft, qa-swarm round 1 fixes pushed (`c2261afda`) | Branch `fork/upstream-sync`. Copy `ledgers/pr14.md` into the worktree's `$(git rev-parse --git-dir)/qa-swarm/14.md`. Continue the rounds, merge, then prove with `gh workflow run fork-sync-upstream.yml -R Silthus/t3code --ref main`. |
| #15 Triage contracts and classifier | PR #24 draft, built; qa-swarm not yet run (`f29ae9d06`, the last commit is WIP test edits) | Branch `fork/triage-classifier`. Copy `ledgers/pr24.md`. Verify the WIP test edits, run the gate, then qa-swarm. |
| #11 Fork desktop identity | open, claimed, no code (prior attempts lost) | Start fresh on branch `fork/desktop-identity`. |
| #16 generateJudgement for Claude and Codex | open, unblocked, unclaimed | Next free slot. |
| #13, #17–#23 | blocked | Dispatch as their blockers merge. |

Fork `main` is still upstream `6c8fed35d`. All 18 inherited upstream workflows are disabled on the fork, intentionally.

## Lessons from the old box (follow them)

- Workers die when the conductor session ends. Workers push WIP at least every 30 minutes. On resume, reconcile from pushed branches.
- A worker must never spawn background sub-agents and then go idle. Its worktree gets reaped.
- `t3-kickoff` fails against T3 0.0.46-nightly on this box: `/api/orchestration/shell` returns 400, and the WebSocket connect fails with CLI-issued sessions. Dispatch lanes as Claude Code background `Agent` workers, not T3 threads. A patched copy with a project fallback is at `~/dev/wf-triage/kickoff/`. The WebSocket still fails with it.
- Run up to three implementation lanes in parallel; disk is fine here (143 GB free).

## First actions

1. Copy `implement-common.md` from the conductor-state branch to `~/dev/wf-triage/implement-common.md`. Its paths already point at `~/dev/wf-triage`.
2. Post a comment on #12, #15, and #11: "Conductor moved to devbox-1; successor lane dispatched."
3. Dispatch successors for #12 and #15, and a fresh lane for #11, with the brief plus the row above.
4. Continue the conductor loop until the map's done criteria hold.
