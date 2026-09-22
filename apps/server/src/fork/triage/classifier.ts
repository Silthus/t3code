import { githubRecord, type GitHubItemSnapshot, type GitHubRecord } from "./github.ts";
import type {
  MergePolicy,
  TriageBlocker,
  TriageItem,
  TriageLifecycle,
  TriageRelation,
} from "./types.ts";
const { isRecord } = githubRecord;
const stateOf = (v: GitHubRecord) => String(v.conclusion ?? v.state ?? v.status ?? "unknown");
const urlOf = (v: GitHubRecord) => String(v.html_url ?? v.target_url ?? "");
export const discoveredPolicy = (
  s: GitHubItemSnapshot,
  configured?: MergePolicy,
): MergePolicy | undefined => {
  if (configured) return configured;
  if (!s.rules || s.unavailableSources.includes("branch-rules")) return undefined;
  let approvals = 0;
  const checks: string[] = [];
  const requiredCheckSources: Array<{ context: string; integrationId: number }> = [];
  for (const r of s.rules) {
    const p = isRecord(r.parameters) ? r.parameters : {};
    if (r.type === "pull_request")
      approvals = Math.max(approvals, Number(p.required_approving_review_count ?? 0));
    if (r.type === "required_status_checks" && Array.isArray(p.required_status_checks))
      for (const c of p.required_status_checks)
        if (isRecord(c) && typeof c.context === "string") {
          checks.push(c.context);
          if (typeof c.integration_id === "number" && c.integration_id > 0)
            requiredCheckSources.push({ context: c.context, integrationId: c.integration_id });
        }
  }
  return {
    repo: s.repo,
    requiredApprovals: approvals,
    requiredChecks: [...new Set(checks)],
    requiredCheckSources,
    requireMergeable: true,
    mergeQueue: s.rules.some((r) => r.type === "merge_queue") ? "required" : "optional",
    externalQueue: s.repo.toLowerCase() === "posthog/posthog" ? "maintainer" : "none",
    skippedChecks: "block",
  };
};
export const verifiedReplacements = (s: GitHubItemSnapshot): readonly TriageRelation[] => {
  const relations: TriageRelation[] = [];
  for (const t of s.linkedTargets ?? []) {
    const body = String(t.body ?? "");
    const sameRepo = String(t.targetRepo).toLowerCase() === s.repo.toLowerCase();
    const explicit =
      new RegExp(`\\b(?:supersedes|replaces)\\s+(?:\\[)?#${s.number}\\b`, "i").test(body) &&
      sameRepo;
    const full = new RegExp(
      `\\b(?:supersedes|replaces)\\s+(?:\\[[^\\]]*\\]\\()?https://github\\.com/${s.repo}/(?:pull|issues)/${s.number}(?:\\D|$)`,
      "i",
    ).test(body);
    if (!explicit && !full) continue;
    const merged = t.merged === true || typeof t.merged_at === "string";
    relations.push({
      kind: "replaced-by",
      target: `${t.targetRepo}#${t.number}`,
      source: "text-candidate",
      evidenceUrl: urlOf(t),
      certainty: "factual",
      details: {
        explicitSourceAssertion: true,
        verifiedMerged: merged,
        targetState: String(t.state),
        excerpt: body.slice(
          Math.max(0, body.search(/\b(?:supersedes|replaces)\b/i) - 100),
          Math.max(0, body.search(/\b(?:supersedes|replaces)\b/i) - 100) + 1000,
        ),
      },
    });
  }
  return relations;
};
export const classifySnapshot = (
  s: GitHubItemSnapshot,
  configured: MergePolicy | undefined,
  relations: readonly TriageRelation[],
) => {
  const p = s.pull ?? s.item;
  const merged = p.merged === true || typeof p.merged_at === "string";
  const lifecycle: TriageLifecycle = merged
    ? "merged"
    : p.state === "closed"
      ? "closed"
      : p.draft === true
        ? "draft"
        : "open";
  const blockers: TriageBlocker[] = [];
  const add = (
    code: string,
    label: string,
    actor: string | null,
    urls: readonly string[] = [urlOf(p)],
  ) => blockers.push({ code, label, actor, evidenceUrls: urls });
  const replacement = relations.some(
    (r) =>
      r.kind === "replaced-by" &&
      r.details?.verifiedMerged === true &&
      r.details.explicitSourceAssertion === true,
  );
  const staleClosure =
    s.comments.some((c) =>
      /clos(?:ed|ing).{0,100}(?:inactiv|stale)|(?:inactiv|stale).{0,100}clos(?:ed|ing)/is.test(
        String(c.body ?? ""),
      ),
    ) ||
    (Array.isArray(s.item.labels) &&
      s.item.labels.some((l) => isRecord(l) && /^(stale|inactive)$/i.test(String(l.name))));
  if (s.truncatedSources.length)
    add(
      "evidence-truncated",
      `GitHub evidence is incomplete: ${s.truncatedSources.join(", ")}.`,
      null,
    );
  if (s.unavailableSources.length)
    add(
      "evidence-unavailable",
      `GitHub evidence is unavailable: ${s.unavailableSources.join(", ")}.`,
      null,
    );
  if (lifecycle === "merged" || lifecycle === "closed")
    return {
      lifecycle,
      classification: merged
        ? ("issue" as const)
        : replacement
          ? ("replaced" as const)
          : staleClosure
            ? ("stale-closed" as const)
            : ("issue" as const),
      blockers,
      nextActors: [] as string[],
      certainty: blockers.length ? ("uncertain" as const) : ("factual" as const),
    };
  for (const dependency of s.blockedBy) {
    if (dependency.state !== "closed") {
      add(
        "dependency-open",
        `Depends on unresolved #${dependency.number}: ${String(dependency.title ?? "")}`,
        "dependency-author",
        [urlOf(dependency)],
      );
    } else if (isRecord(dependency.pull_request) && !dependency.pull_request.merged_at) {
      add(
        "dependency-shipment-unknown",
        `Dependency #${dependency.number} is closed, but shipment has not been verified.`,
        "dependency-author",
        [urlOf(dependency)],
      );
    }
  }
  for (const relation of relations.filter(
    (r) => r.kind === "depends-on" && r.source === "text-candidate",
  )) {
    const target = s.linkedTargets?.find(
      (t) => `${t.targetRepo}#${t.number}`.toLowerCase() === relation.target.toLowerCase(),
    );
    const complete =
      target &&
      (isRecord(target.pull_request)
        ? target.merged === true || typeof target.merged_at === "string"
        : target.state === "closed");
    if (!complete)
      add(
        "discussion-dependency-unknown",
        `Discussion names ${relation.target} as a dependency; confirm whether it still applies.`,
        null,
        [relation.evidenceUrl],
      );
  }
  if (s.kind === "issue")
    return {
      lifecycle,
      classification: blockers.some((b) => b.code.startsWith("evidence-"))
        ? ("unknown" as const)
        : blockers.length
          ? ("blocked" as const)
          : ("issue" as const),
      blockers,
      nextActors: [...new Set(blockers.map((b) => b.actor).filter((a): a is string => a !== null))],
      certainty: blockers.some((b) => /unknown|evidence-/.test(b.code))
        ? ("uncertain" as const)
        : ("factual" as const),
    };
  const policy = discoveredPolicy(s, configured);
  if (!policy)
    add(
      "merge-policy-missing",
      "GitHub merge policy could not be read and no policy is configured.",
      "maintainer",
    );
  const head = isRecord(p.head) ? p.head.sha : null;
  const validShas = new Set([
    head,
    ...(p.mergeable === true && p.state === "open" ? [p.merge_commit_sha] : []),
  ]);
  const reviews = new Map<string, GitHubRecord>();
  for (const r of [...s.reviews].sort((a, b) =>
    String(a.submitted_at).localeCompare(String(b.submitted_at)),
  ))
    if (
      isRecord(r.user) &&
      typeof r.user.login === "string" &&
      r.state !== "COMMENTED" &&
      r.state !== "PENDING"
    )
      reviews.set(r.user.login, r);
  const approvals = [...reviews.values()].filter(
    (r) => r.state === "APPROVED" && r.commit_id === head,
  ).length;
  if (
    s.reviewState?.reviewDecision === "CHANGES_REQUESTED" ||
    [...reviews.values()].some((r) => r.state === "CHANGES_REQUESTED")
  )
    add("changes-requested", "A reviewer requested changes.", "author");
  if (
    s.reviewState?.reviewDecision === "REVIEW_REQUIRED" ||
    (policy &&
      approvals < policy.requiredApprovals &&
      (configured !== undefined || s.reviewState?.reviewDecision !== "APPROVED"))
  )
    add("approval-required", "GitHub requires review approval.", "reviewer");
  const unresolved = (s.reviewThreads ?? []).filter((t) => t.isResolved === false);
  if (unresolved.length)
    add(
      "review-threads-unresolved",
      `${unresolved.length} review thread(s) remain unresolved.`,
      "author",
    );
  const current = (values: readonly GitHubRecord[]) =>
    values.filter((v) => validShas.has(v.head_sha ?? v.sha ?? v.observed_sha ?? head));
  const latest = (values: readonly GitHubRecord[], key: (v: GitHubRecord) => string) => {
    const map = new Map<string, GitHubRecord>();
    for (const v of [...values].sort(
      (a, b) =>
        String(a.updated_at ?? a.completed_at ?? a.created_at ?? "").localeCompare(
          String(b.updated_at ?? b.completed_at ?? b.created_at ?? ""),
        ) || Number(a.run_attempt ?? a.id ?? 0) - Number(b.run_attempt ?? b.id ?? 0),
    ))
      map.set(key(v), v);
    return [...map.values()];
  };
  const appId = (v: GitHubRecord) =>
    isRecord(v.app)
      ? v.app.id
      : isRecord(v.check_suite) && isRecord(v.check_suite.app)
        ? v.check_suite.app.id
        : null;
  const checks = latest(current(s.checks), (v) => `${String(v.name)}:${String(appId(v))}`);
  const statuses = latest(current(s.statuses ?? []), (v) => String(v.context));
  const runs = latest(current(s.runs ?? []), (v) => `${v.workflow_id ?? v.name}:${v.event ?? ""}`);
  const requirements = (policy?.requiredChecks ?? []).flatMap<{
    context: string;
    integrationId: number | null;
  }>((context) => {
    const supplied =
      policy?.requiredCheckSources?.filter((source) => source.context === context) ?? [];
    return supplied.length ? supplied : [{ context, integrationId: null }];
  });
  for (const requirement of requirements) {
    const { context: name, integrationId } = requirement;
    const c =
      checks.find(
        (v) => v.name === name && (integrationId === null || appId(v) === integrationId),
      ) ?? (integrationId === null ? statuses.find((v) => v.context === name) : undefined);
    const state = c ? stateOf(c) : "missing";
    if (state === "success" || (state === "skipped" && policy?.skippedChecks === "accept"))
      continue;
    const actor =
      state === "action_required"
        ? "maintainer"
        : ["queued", "in_progress", "pending", "waiting", "requested"].includes(state)
          ? "ci"
          : "author";
    add(
      `check-${state}`,
      `Required check ${name}${integrationId === null ? "" : ` (GitHub App #${integrationId})`}: ${state}.`,
      actor,
      c ? [urlOf(c)] : [],
    );
  }
  for (const r of runs) {
    const state = stateOf(r);
    // Required skipped checks are handled above. Conditional workflows often skip
    // because they do not apply to this PR; a skipped run alone is not a blocker.
    if (state === "success" || state === "neutral" || state === "skipped") continue;
    const action = state === "action_required";
    add(
      action ? "maintainer-approval-required" : `workflow-${state}`,
      `Workflow ${String(r.name ?? r.workflow_id)}: ${state}.`,
      action
        ? "maintainer"
        : ["queued", "in_progress", "waiting", "requested", "pending"].includes(state)
          ? "ci"
          : "author",
      [urlOf(r)],
    );
  }
  if (
    p.mergeable === false ||
    p.mergeable_state === "dirty" ||
    s.reviewState?.mergeable === "CONFLICTING"
  )
    add("merge-conflict", "GitHub reports a merge conflict.", "author");
  else if (p.mergeable !== true)
    add("mergeability-unknown", "GitHub has not computed mergeability.", null);
  for (const rule of s.rules ?? []) {
    const params = isRecord(rule.parameters) ? rule.parameters : {};
    if (rule.type === "required_deployments")
      add(
        "required-deployment-unknown",
        "Required deployment environments have not been verified.",
        "maintainer",
      );
    if (rule.type === "required_signatures")
      add(
        "commit-signatures-unknown",
        "Required commit signatures have not been independently verified.",
        "maintainer",
      );
    if (rule.type === "workflows")
      add(
        "required-workflow-unknown",
        "The required organization workflow result has not been verified.",
        "maintainer",
      );
    if (
      rule.type === "pull_request" &&
      params.require_code_owner_review === true &&
      s.reviewState?.reviewDecision !== "APPROVED"
    )
      add("codeowner-review-required", "GitHub requires code owner approval.", "reviewer");
  }
  if (policy?.externalQueue === "maintainer")
    add(
      "external-queue-required",
      "A maintainer must enqueue this pull request in the external merge queue.",
      "maintainer",
    );
  else if (policy?.mergeQueue === "required")
    add(
      "merge-queue-required",
      "A maintainer must confirm current merge queue membership.",
      "maintainer",
    );
  if (
    policy?.upstreamPermission === "viewer" &&
    !["ADMIN", "MAINTAIN", "WRITE"].includes(String(s.reviewState?.viewerPermission))
  )
    add(
      "viewer-cannot-merge",
      "The authenticated viewer cannot merge this pull request.",
      "maintainer",
    );
  if (!s.reviewState?.viewerPermission)
    add("permission-unknown", "Viewer permission could not be verified.", null);
  if (s.reviewState?.mergeStateStatus === "BEHIND")
    add("rebase-required", "GitHub requires the branch to be updated with its base.", "author");
  if (!s.reviewState?.mergeStateStatus || s.reviewState.mergeStateStatus === "UNKNOWN")
    add("merge-eligibility-unknown", "GitHub merge eligibility has not been verified.", null);
  if (s.reviewState?.mergeStateStatus === "BLOCKED")
    add("merge-eligibility-unknown", "GitHub reports blocked merge eligibility.", "maintainer");
  const unknown = blockers.some((b) => /unknown|missing|evidence-/.test(b.code));
  const review = blockers.some((b) => b.code === "approval-required");
  const classification: TriageItem["classification"] =
    lifecycle === "draft"
      ? "draft"
      : s.unavailableSources.length || s.truncatedSources.length
        ? "unknown"
        : blockers.some((blocker) =>
              [
                "merge-conflict",
                "rebase-required",
                "changes-requested",
                "dependency-open",
              ].includes(blocker.code),
            )
          ? "blocked"
          : review
            ? "review"
            : unknown
              ? "unknown"
              : blockers.some(
                    (b) =>
                      ![
                        "external-queue-required",
                        "merge-queue-required",
                        "viewer-cannot-merge",
                      ].includes(b.code),
                  )
                ? "blocked"
                : "ready-maintainer";
  return {
    lifecycle,
    classification,
    blockers,
    nextActors: [
      ...new Set([
        ...(lifecycle === "draft" ? ["author"] : []),
        ...blockers.map((b) => b.actor).filter((a): a is string => a !== null),
        ...(blockers.length ? [] : ["maintainer"]),
      ]),
    ],
    certainty: unknown ? ("uncertain" as const) : ("factual" as const),
  };
};
