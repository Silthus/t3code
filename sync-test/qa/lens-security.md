Lens: Security

Is the change safe against a hostile caller? A finding names the source, the sink, the missing control, an exploit request, and why it is reachable. Drop a finding that misses one of them.
- Access control, permissions that allow by default.
- Injection: shell, template injection (including GitHub Actions expression injection), path traversal.
- Secrets and personal data in code, logs, error reports, or URLs.
- CI and dependencies: pull_request_target with the PR head, loose pins, new install scripts.
Defense in depth, missing headers, or rate limits without an exploit chain are not findings.
