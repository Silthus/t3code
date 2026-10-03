# Conductor state: PR triage dashboard map (Silthus/t3code#6)

Snapshot taken 2026-10-03, when the conductor moved from devbox (coder) to devbox-1.

- `implement-common.md`: the implementation lane brief. Copy it to `~/dev/wf-triage/` on the new host.
- `ledgers/pr14.md`, `ledgers/pr24.md`: the qa-swarm ledgers for PR #14 (upstream sync) and PR #24 (classifier). Copy them into `$(git rev-parse --git-dir)/qa-swarm/` in each lane's worktree.
- `proof/`: the red, green, and typecheck logs for #15.
- `sync-test/`: the sandbox harness for #12 (stub gh plus local bare repos).
