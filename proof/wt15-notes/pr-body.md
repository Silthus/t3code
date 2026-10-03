## Context

The triage view needs one rule core that turns a PR's GitHub facts into a status, a group ("whose move"), a next action, and the signals behind it. Every later slice (GitHub read, judgement, UI) renders this output, so the names have to match the [spec's contract sketch](https://github.com/Silthus/t3code/blob/spec/triage/spec/triage.md#contracts) exactly. Closes #15.

## Change

- `packages/contracts/src/forkTriage.ts`: the schemas from the spec sketch (`TRIAGE_STATUSES`, `TriageGroup`, `TriagePullRequest`, `TriageReport`, `TriageJudgementState`, …), exported by one line in `index.ts`. No HTTP group yet; the GitHub-read slice adds it with its handler.
- `apps/server/src/fork/triage/facts.types.ts`: the server-internal `TriageFacts`, audit-prs `PrFacts` trimmed to the bulk read. Threads include resolved ones.
- `apps/server/src/fork/triage/classify.ts`: `classifyTriage(facts, viewer, now)` in three steps that read like the spec tables:
  1. **Status** S1 to S9, ported from audit-prs `classify(pr, null)`, with its reasons and open questions.
  2. **Group overlay** G1 to G10 from Postpile's own-PR rules, with the `answerThreads`, `reReview`, and `waitingOn` wording. The file keeps Postpile's MIT notice.
  3. **Refinement** L1 to L4.

  Plus blockers, audit-prs `signals()` (14-day stale), and the three counts.

## Test seams

One seam: `classifyTriage` with plain fixtures in `classify.test.ts`. The ported audit-prs `classify.test.ts` cases without Jev, one test per overlay row G1 to G10 and refinement row L1 to L4, then blockers, signals, and counts.

## Danger areas

- **Public contract.** `forkTriage.ts` names bind the next eight tickets. They match the spec sketch; `TriageCounts` is the one extra named export (the counts struct, so the classifier can return it typed).
- Rule order in `statusStep` and `turnOf`. First match wins, so a reorder silently changes groups.

## Calls made

- **`answerThreads` names the thread's last commenter**, the person you owe a reply, not the first comment's author. A thread you opened and Ada answered reads "Answer 1 thread from ada", not "from silthus". This matches Postpile's source. Alt: the first comment's author, as the spec glossary defines a thread's author.
- **`reReview` names up to two people, `waitingOn` one.** That is what the spec's examples say ("ada and sol to re-review", "Waiting on sol and 1 more"). Alt: one shared name list for both.
- **Drafts still list hard and thread blockers**, without the change-request entry, which the spec reserves for S2. A draft with conflicts can't merge either. Alt: no blockers on drafts.
- **`behindBy` is left out of `TriageFacts`** instead of a field that is always `null`. The stale and conflict signals read exactly as audit-prs does with `null`. Alt: keep the field for a later per-PR compare.
- **`now` is epoch milliseconds**, as in audit-prs. Alt: an Effect `DateTime`.

## How to verify

```sh
cd apps/server && vp test run src/fork/triage/classify.test.ts
```

Expect `Tests  31 passed (31)`.

## Proof

Local gate (the fork has no CI):

- **Red** against a throwing stub: `Test Files  1 failed (1)`, `Tests  30 failed (30)`.
- **Green**: `vp test run src/fork/triage/classify.test.ts` → `Tests  31 passed (31)`.
- `tsc --noEmit` in `packages/contracts` and `apps/server`: exit 0, no errors.
- `vp lint --report-unused-disable-directives` and `vp fmt --check` on the five changed files: exit 0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
