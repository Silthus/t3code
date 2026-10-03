Lens: Tests

Do the tests prove the goal? This change is shell plus YAML and ships no committed tests; it was proven with an out-of-repo sandbox harness at /home/coder/dev/wf-triage/sync-test/run.sh (local bare repos for origin and upstream, a url.insteadOf rewrite of the upstream URL, a stub gh in sync-test/bin/gh, and workflows.json fixture). Read the harness and its last output in sync-test/run.log.
- Does the harness exercise every behaviour the goal adds (clean merge+push, up to date, refusals, conflict create/update/close, refused push with and without workflow files, quiet step)?
- Assertions that prove nothing, stubs that differ from real gh behaviour (flags, output shapes, exit codes) in a way that hides a real bug.
- Behaviour that only the real GitHub runner can show, which the harness cannot prove: name it.
- Whether a committed test is warranted under the repo's rules, or the harness is the right proof.
