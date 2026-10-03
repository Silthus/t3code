Lens: Production

Does the change hold up at real scale and through a deploy?
- Reliability: timeouts, retries without a cap, missing idempotency on side effects, swallowed errors, cleanup of resources.
- Rollout: manual deploy steps, safe behaviour when the optional secret is absent.
- Observability: enough signal to see the change fail in production (failed runs, issues, logs).
