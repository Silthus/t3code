Lens: Adversary

Assume the change is wrong and find how it breaks:
- Malformed, huge, empty, or malicious input (upstream content, branch state, issue state).
- A slow dependency, or one that returns garbage (GitHub API, git fetch, gh CLI).
- Concurrent runs and retries (schedule plus manual dispatch, a human pushing to main mid-run).
- The next upstream change: upstream adds or edits workflows, renames main, rewrites history.
- The next developer who extends the code in the obvious, wrong way.
