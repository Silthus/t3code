// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import { classifySnapshot, verifiedReplacements } from "./classifier.ts";
import type { GitHubItemSnapshot, GitHubRecord } from "./github.ts";
import { GitHubClient, getGitHubToken, githubRecord } from "./github.ts";
import { InferenceClient } from "./inference.ts";
import { readConfig } from "./config.ts";
import { TriageStorage } from "./storage.ts";
import type {
  JsonObject,
  MergePolicy,
  MonitorOptions,
  TriageBlocker,
  TriageChange,
  TriageConfig,
  TriageConfigSummary,
  TriageError,
  TriageEvidence,
  TriageExplanation,
  TriageItem,
  TriageItemError,
  TriageJudgment,
  TriageMonitor,
  TriageRelation,
  TriageReport,
  TriageUsage,
} from "./types.ts";

export { readConfig } from "./config.ts";
export type * from "./types.ts";

const isRecord = githubRecord.isRecord;
const stringAt = githubRecord.stringAt;
const numberAt = githubRecord.numberAt;

const emptyUsage = (budget: number): TriageUsage => ({
  githubRequests: 0,
  githubPages: 0,
  inferenceRequests: 0,
  inferenceCacheHits: 0,
  inferenceInputCharacters: 0,
  inferenceBudget: budget,
  inferenceBudgetRemaining: budget,
  truncatedConnections: 0,
});

const configSummary = (config: TriageConfig): TriageConfigSummary => ({
  scopes: config.scopes.map((scope) => scope.repo),
  refreshIntervalMinutes: config.refreshIntervalMinutes,
  staleAfterMinutes: config.staleAfterMinutes,
  githubPageLimit: config.githubPageLimit,
  inferenceEnabled: config.inference.enabled,
  inferenceProvider: config.inference.provider,
  inferenceModel: config.inference.model,
  mergePolicies: config.mergePolicies.map((policy) => policy.repo),
});

const emptyReport = (config: TriageConfig, now: string): TriageReport => ({
  generatedAt: now,
  lastScanAt: null,
  items: [],
  changes: [],
  errors: [],
  usage: emptyUsage(config.inference.requestBudget),
  configSummary: configSummary(config),
});

const excerpt = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 1_000);

const actor = (value: GitHubRecord) =>
  isRecord(value.user) ? stringAt(value.user, "login") : null;

const evidenceFrom = (
  source: string,
  values: ReadonlyArray<GitHubRecord>,
): ReadonlyArray<TriageEvidence> =>
  values.map((value, index) => ({
    sourceId: `${source}:${numberAt(value, "id") ?? index}`,
    url: stringAt(value, "html_url") ?? stringAt(value, "url") ?? "",
    excerpt: excerpt(
      stringAt(value, "body") ??
        stringAt(value, "name") ??
        stringAt(value, "event") ??
        stringAt(value, "state"),
    ),
    author: actor(value),
    at:
      stringAt(value, "updated_at") ??
      stringAt(value, "submitted_at") ??
      stringAt(value, "completed_at") ??
      stringAt(value, "created_at"),
  }));

const relationKind = (nearby: string): TriageRelation["kind"] => {
  if (/replaced by|superseded by/i.test(nearby)) return "replaced-by";
  if (/replaces|supersedes/i.test(nearby)) return "replaces";
  if (/depends on|blocked by/i.test(nearby)) return "depends-on";
  if (/\bblocks\b/i.test(nearby)) return "blocks";
  if (/\bparent\b/i.test(nearby)) return "parent";
  if (/\bchild\b/i.test(nearby)) return "child";
  return "references";
};

const textRelations = (
  repo: string,
  text: string,
  evidenceUrl: string,
): ReadonlyArray<TriageRelation> => {
  const relations: Array<TriageRelation> = [];
  const expression =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)|(?<![\w/])#(\d+)/g;
  for (const match of text.matchAll(expression)) {
    const number = match[2] ?? match[3];
    if (!number) continue;
    const target = `${match[1] ?? repo}#${number}`;
    const start = Math.max(0, (match.index ?? 0) - 40);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 40);
    relations.push({
      kind: relationKind(text.slice(start, end)),
      target,
      source: "text-candidate",
      evidenceUrl,
      certainty: "uncertain",
    });
  }
  return relations;
};

const nativeRelations = (snapshot: GitHubItemSnapshot): ReadonlyArray<TriageRelation> => {
  const relations: Array<TriageRelation> = [];
  const add = (kind: TriageRelation["kind"], value: GitHubRecord) => {
    const targetUrl = stringAt(value, "html_url");
    const targetNumber = numberAt(value, "number");
    const match = targetUrl?.match(/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
    if (!targetUrl || targetNumber === null) return;
    relations.push({
      kind,
      target: `${match?.[1] ?? snapshot.repo}#${targetNumber}`,
      source: "github-native",
      evidenceUrl: targetUrl,
      certainty: "factual",
    });
  };
  if (snapshot.parent) add("parent", snapshot.parent);
  const linked = snapshot.reviewState?.closingIssuesReferences;
  if (isRecord(linked) && Array.isArray(linked.nodes))
    for (const node of linked.nodes)
      if (isRecord(node)) add("references", { ...node, html_url: node.url });
  for (const child of snapshot.children) add("child", child);
  for (const blocker of snapshot.blockedBy) add("depends-on", blocker);
  for (const blocked of snapshot.blocking) add("blocks", blocked);
  for (const event of snapshot.timeline) {
    const source = isRecord(event.source) ? event.source : null;
    const issue = source && isRecord(source.issue) ? source.issue : null;
    const targetUrl = issue ? stringAt(issue, "html_url") : null;
    const targetNumber = issue ? numberAt(issue, "number") : null;
    const targetRepo =
      issue && isRecord(issue.repository) ? stringAt(issue.repository, "full_name") : null;
    if (!targetUrl || targetNumber === null) continue;
    relations.push({
      kind: "references",
      target: `${targetRepo ?? snapshot.repo}#${targetNumber}`,
      source: "github-native",
      evidenceUrl: targetUrl,
      certainty: "factual",
    });
  }
  return relations;
};

const deduplicateRelations = (relations: ReadonlyArray<TriageRelation>) => {
  const unique = new Map<string, TriageRelation>();
  for (const relation of relations) {
    const key = `${relation.kind}:${relation.target}:${relation.source}`;
    if (!unique.has(key)) unique.set(key, relation);
  }
  return [...unique.values()];
};

const makeItem = async (
  snapshot: GitHubItemSnapshot,
  policy: MergePolicy | undefined,
  inference: InferenceClient,
  at: string,
): Promise<{ readonly item: TriageItem; readonly errors: ReadonlyArray<TriageError> }> => {
  const source = snapshot.pull ?? snapshot.item;
  const url =
    stringAt(source, "html_url") ?? `https://github.com/${snapshot.repo}/issues/${snapshot.number}`;
  const body = stringAt(source, "body") ?? stringAt(snapshot.item, "body") ?? "";
  const evidence = [
    {
      sourceId: "item",
      url,
      excerpt: excerpt(body || stringAt(source, "title")),
      author: actor(source),
      at: stringAt(source, "updated_at"),
    },
    ...evidenceFrom("comment", snapshot.comments),
    ...evidenceFrom("review-comment", snapshot.reviewComments),
    ...evidenceFrom("review", snapshot.reviews),
    ...evidenceFrom("check", snapshot.checks),
    ...evidenceFrom("workflow", snapshot.runs ?? []),
    ...evidenceFrom("status", snapshot.statuses ?? []),
  ];
  const relationTexts = [
    { text: body, url },
    ...snapshot.comments.map((comment) => ({
      text: stringAt(comment, "body") ?? "",
      url: stringAt(comment, "html_url") ?? url,
    })),
    ...snapshot.reviewComments.map((comment) => ({
      text: stringAt(comment, "body") ?? "",
      url: stringAt(comment, "html_url") ?? url,
    })),
  ];
  const relations = deduplicateRelations([
    ...verifiedReplacements(snapshot),
    ...nativeRelations(snapshot),
    ...relationTexts.flatMap((entry) => textRelations(snapshot.repo, entry.text, entry.url)),
  ]);
  for (const relation of relations)
    if (relation.details?.explicitSourceAssertion === true)
      evidence.push({
        sourceId: `replacement:${relation.target}`,
        url: relation.evidenceUrl,
        excerpt: String(relation.details.excerpt ?? ""),
        author: null,
        at: null,
      });
  const result = classifySnapshot(snapshot, policy, relations);
  const itemKey = `${snapshot.repo}#${snapshot.number}`;
  const inferenceState: JsonObject = {
    item: itemKey,
    title: stringAt(source, "title") ?? "",
    suppliedLinks: relations
      .filter((r) => r.source === "text-candidate")
      .map((r) => ({ target: r.target, kind: r.kind, evidenceUrl: r.evidenceUrl })),
    evidence: [
      { sourceId: "item", url, excerpt: body, author: actor(source), at: null },
      ...(
        [
          ["comment", snapshot.comments],
          ["review-comment", snapshot.reviewComments],
          ["review", snapshot.reviews],
        ] as const
      ).flatMap(([kind, values]) =>
        values.map((v, index) => ({
          sourceId: `${kind}:${numberAt(v, "id") ?? index}`,
          url: stringAt(v, "html_url") ?? url,
          excerpt: stringAt(v, "body") ?? "",
          author: actor(v),
          at: stringAt(v, "updated_at") ?? stringAt(v, "submitted_at") ?? stringAt(v, "created_at"),
        })),
      ),
    ],
  };
  const inferred = await inference.judge(itemKey, inferenceState, at);
  const judgments: Array<TriageJudgment> = inferred.judgments
    ? [...inferred.judgments]
    : inferred.judgment
      ? [inferred.judgment]
      : [];
  const discussionBlockers: TriageBlocker[] = (
    result.lifecycle === "closed" || result.lifecycle === "merged" ? [] : judgments
  )
    .filter(
      (j) =>
        j.certainty === "inferred" &&
        (((j.id === "manualValidation" || j.id === "authorAction") && j.value === "required") ||
          (j.id === "unresolvedBlocker" && j.value === "present")),
    )
    .map((j) => ({
      code: `discussion-${j.id}`,
      label: `${j.label} remains unresolved according to discussion.`,
      actor: j.id === "manualValidation" ? "validator" : j.id === "authorAction" ? "author" : null,
      evidenceUrls: j.evidenceUrls,
      details: { certainty: "inferred", confidence: j.confidence },
    }));
  const itemErrors: Array<TriageItemError> = [
    ...snapshot.unavailableSources.map((source) => ({
      code: "evidence-unavailable",
      message: `GitHub evidence source ${source} could not be read.`,
      source,
      at,
      retryable: true,
    })),
    ...snapshot.truncatedSources.map((source) => ({
      code: "evidence-truncated",
      message: `GitHub evidence source ${source} exceeded githubPageLimit.`,
      source,
      at,
      retryable: false,
    })),
  ];
  return {
    item: {
      repo: snapshot.repo,
      number: snapshot.number,
      url,
      title: stringAt(source, "title") ?? `#${snapshot.number}`,
      kind: snapshot.kind,
      lifecycle: result.lifecycle,
      classification:
        result.classification === "ready-maintainer" && discussionBlockers.length
          ? "blocked"
          : result.classification,
      blockers: [...result.blockers, ...discussionBlockers],
      nextActors: [
        ...new Set([
          ...result.nextActors,
          ...discussionBlockers.map((b) => b.actor).filter((a): a is string => a !== null),
        ]),
      ],
      evidence,
      lastSuccessfulRefresh: snapshot.unavailableSources.length ? null : at,
      errors: itemErrors,
      certainty: result.certainty,
      relations,
      judgments,
      details: {
        updatedAt: stringAt(source, "updated_at"),
        shipped:
          result.lifecycle === "merged" ||
          relations.some((r) => r.kind === "replaced-by" && r.details?.verifiedMerged === true),
        childProgress: {
          total: snapshot.children.length,
          closed: snapshot.children.filter((c) => c.state === "closed").length,
          complete:
            !snapshot.truncatedSources.includes("children") &&
            !snapshot.unavailableSources.includes("children"),
        },
        nextUnresolvedDependency:
          (snapshot.blockedBy.find((c) => c.state !== "closed")?.html_url as string) ??
          (snapshot.children.find((c) => c.state !== "closed")?.html_url as string) ??
          null,
        workerExecution: "No execution telemetry. Discussion claims are not proof of active work.",
        reviewDecision: (snapshot.reviewState?.reviewDecision as string) ?? null,
        viewerPermission: (snapshot.reviewState?.viewerPermission as string) ?? null,
        checkStates: [
          ...snapshot.checks,
          ...(snapshot.runs ?? []),
          ...(snapshot.statuses ?? []),
        ].map((c) => ({
          id: String(c.id ?? c.context ?? c.name),
          head: String(c.head_sha ?? c.sha ?? c.observed_sha ?? ""),
          state: String(c.status ?? c.state ?? ""),
          conclusion: String(c.conclusion ?? ""),
          attempt: Number(c.run_attempt ?? 1),
        })),
        headSha:
          snapshot.pull && isRecord(snapshot.pull.head)
            ? stringAt(snapshot.pull.head, "sha")
            : null,
      },
    },
    errors: inferred.error ? [inferred.error] : [],
  };
};

const comparison = (item: TriageItem): JsonObject => ({
  repo: item.repo,
  number: item.number,
  certainty: item.certainty,
  errors: item.errors.map((e) => ({ code: e.code, source: e.source })),
  headSha: item.details?.headSha ?? null,
  reviewDecision: item.details?.reviewDecision ?? null,
  checkStates: item.details?.checkStates ?? [],
  childProgress: item.details?.childProgress ?? null,
  title: item.title,
  kind: item.kind,
  lifecycle: item.lifecycle,
  classification: item.classification,
  blockers: item.blockers.map((blocker) => ({ code: blocker.code, label: blocker.label })),
  nextActors: item.nextActors,
  relations: item.relations.map((relation) => ({
    kind: relation.kind,
    target: relation.target,
    source: relation.source,
  })),
  judgments: item.judgments.map((judgment) => ({
    id: judgment.id,
    value: judgment.value,
    confidence: judgment.confidence,
  })),
});

const calculateChanges = (
  before: ReadonlyArray<TriageItem>,
  after: ReadonlyArray<TriageItem>,
  at: string,
): ReadonlyArray<TriageChange> => {
  const previous = new Map(before.map((item) => [`${item.repo}#${item.number}`, item]));
  const current = new Map(after.map((item) => [`${item.repo}#${item.number}`, item]));
  const changes: Array<TriageChange> = [];
  for (const [key, item] of current) {
    const old = previous.get(key);
    if (!old) {
      changes.push({
        item: key,
        detectedAt: at,
        kind: "added",
        fields: ["item"],
        after: comparison(item),
      });
      continue;
    }
    const oldValue = comparison(old);
    const newValue = comparison(item);
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      const fields = Object.keys(newValue).filter(
        (field) => JSON.stringify(oldValue[field]) !== JSON.stringify(newValue[field]),
      );
      changes.push({
        item: key,
        detectedAt: at,
        kind: "changed",
        fields,
        before: oldValue,
        after: newValue,
      });
    }
  }
  for (const [key, item] of previous) {
    if (!current.has(key)) {
      changes.push({
        item: key,
        detectedAt: at,
        kind: "removed",
        fields: ["item"],
        before: comparison(item),
      });
    }
  }
  return changes;
};

const staleItem = (item: TriageItem, error: TriageItemError): TriageItem => ({
  ...item,
  certainty: "stale",
  errors: [...item.errors.filter((e) => e.code !== error.code || e.source !== error.source), error],
});

const explanation = (itemKey: string, item: TriageItem | undefined): TriageExplanation =>
  item
    ? {
        item: itemKey,
        found: true,
        summary: `${item.repo}#${item.number} is ${item.classification} with ${item.blockers.length} blocker(s).`,
        classification: item.classification,
        blockers: item.blockers,
        nextActors: item.nextActors,
        evidence: item.evidence,
        judgments: item.judgments,
        errors: item.errors,
      }
    : {
        item: itemKey,
        found: false,
        summary: `No tracked item matches ${itemKey}.`,
        classification: null,
        blockers: [],
        nextActors: [],
        evidence: [],
        judgments: [],
        errors: [],
      };

const normalizeItemKey = (value: string) => {
  const url = value.match(/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  return url ? `${url[1]}#${url[2]}` : value;
};

const refreshElapsed = (report: TriageReport, config: TriageConfig, now: Date): TriageReport => ({
  ...report,
  generatedAt: now.toISOString(),
  items: report.items.map((item) => {
    const stale =
      !item.lastSuccessfulRefresh ||
      now.getTime() - Date.parse(item.lastSuccessfulRefresh) > config.staleAfterMinutes * 60000;
    const updated = item.details?.updatedAt;
    const stalled =
      (item.lifecycle === "open" || item.lifecycle === "draft") &&
      typeof updated === "string" &&
      now.getTime() - Date.parse(updated) > (config.stalledAfterDays ?? 14) * 86400000;
    return {
      ...item,
      ...(stale ? { certainty: "stale" as const } : {}),
      ...(stalled ? { details: { ...item.details, stalled: true } } : {}),
    };
  }),
});

/** Creates a durable, read-only GitHub triage monitor. */
export const createMonitor = (options: MonitorOptions): TriageMonitor => {
  const config = readConfig(options.configPath);
  const storage = new TriageStorage(options.dataDir);
  const now = options.dependencies?.now ?? (() => new Date());
  const fetchImplementation = options.dependencies?.fetch ?? globalThis.fetch.bind(globalThis);
  const environment = options.dependencies?.environment ?? process.env;
  const tokenProvider = options.dependencies?.getGitHubToken ?? getGitHubToken;
  let closed = false;
  let current = storage.latestReport() ?? emptyReport(config, now().toISOString());
  const owner = NodeCrypto.randomUUID();
  let scanning = false;

  return {
    async scan() {
      if (closed) throw new Error("Triage monitor is closed");
      const startedAt = now();
      const at = startedAt.toISOString();
      if (scanning || !storage.acquireLease(owner, startedAt.getTime(), config.leaseSeconds)) {
        return {
          ...current,
          generatedAt: at,
          changes: [],
          errors: [
            ...current.errors,
            {
              code: "scan-lease-held",
              message: "Another process is scanning this data directory.",
              source: "monitor",
              at,
              retryable: true,
            },
          ],
        };
      }

      scanning = true;
      let leaseLost = false;
      const assertLease = () => {
        if (leaseLost || !storage.renewLease(owner, now().getTime(), config.leaseSeconds))
          throw new Error("Scan lease expired or changed owner. Retry this scan.");
      };
      const heartbeat = setInterval(
        () => {
          if (!storage.renewLease(owner, now().getTime(), config.leaseSeconds)) leaseLost = true;
        },
        Math.max(500, (config.leaseSeconds * 1000) / 3),
      );
      try {
        const errors: Array<TriageError> = [];
        const inference = new InferenceClient({
          apiKey: environment.AI_GATEWAY_API_KEY,
          config: config.inference,
          fetch: fetchImplementation,
          storage,
        });
        const availabilityError = inference.availabilityError(at);
        if (availabilityError) errors.push(availabilityError);

        let token: string;
        try {
          token = await tokenProvider();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "GitHub authentication failed.";
          errors.push({
            code: "github-auth-failed",
            message,
            source: "github",
            at,
            retryable: true,
          });
          const staleError: TriageItemError = {
            code: "github-auth-failed",
            message,
            source: "github",
            at,
            retryable: true,
          };
          const items = current.items.map((item) => staleItem(item, staleError));
          const report: TriageReport = {
            generatedAt: at,
            lastScanAt: at,
            items,
            changes: calculateChanges(current.items, items, at),
            errors,
            usage: emptyUsage(config.inference.requestBudget),
            configSummary: configSummary(config),
          };
          assertLease();
          storage.saveReport(report);
          current = report;
          return report;
        }

        const github = new GitHubClient({
          fetch: fetchImplementation,
          pageLimit: config.githubPageLimit,
          token,
          lookbackDays: config.lookbackDays ?? 30,
          now: startedAt,
          timeoutMs: config.githubTimeoutMs ?? 15000,
          retries: config.githubRetries ?? 2,
          concurrency: config.githubConcurrency ?? 4,
        });
        const items: Array<TriageItem> = [];
        for (const scope of config.scopes) {
          try {
            const snapshots = await github.scanScope(
              scope,
              current.items
                .filter(
                  (i) =>
                    i.repo === scope.repo && (i.lifecycle === "open" || i.lifecycle === "draft"),
                )
                .map((i) => ({ number: i.number, kind: i.kind })),
            );
            for (const snapshot of snapshots) {
              assertLease();
              const built = await makeItem(
                snapshot,
                config.mergePolicies.find((policy) => policy.repo === snapshot.repo),
                inference,
                at,
              );
              const previous = current.items.find(
                (i) => i.repo === snapshot.repo && i.number === snapshot.number,
              );
              if (previous && snapshot.unavailableSources.length > 0) {
                items.push({
                  ...built.item,
                  certainty: "stale",
                  lastSuccessfulRefresh: previous.lastSuccessfulRefresh,
                  ...(snapshot.unavailableSources.includes("item") ||
                  snapshot.unavailableSources.includes("pull-request")
                    ? { lifecycle: previous.lifecycle, title: previous.title, url: previous.url }
                    : {}),
                  blockers: [
                    ...built.item.blockers,
                    ...previous.blockers.filter(
                      (b) =>
                        !built.item.blockers.some((n) => n.code === b.code && n.label === b.label),
                    ),
                  ],
                  evidence: [
                    ...built.item.evidence,
                    ...previous.evidence.filter(
                      (e) => !built.item.evidence.some((n) => n.sourceId === e.sourceId),
                    ),
                  ],
                });
              } else items.push(built.item);
              errors.push(...built.errors);
            }
          } catch (cause) {
            const message =
              cause instanceof Error ? cause.message : `Failed to refresh ${scope.repo}.`;
            errors.push({
              code: "github-refresh-failed",
              message,
              source: "github",
              at,
              retryable: true,
              details: { repo: scope.repo },
            });
            const staleError: TriageItemError = {
              code: "github-refresh-failed",
              message,
              source: "github",
              at,
              retryable: true,
            };
            items.push(
              ...current.items
                .filter((item) => item.repo === scope.repo)
                .map((item) => staleItem(item, staleError)),
            );
          }
        }
        items.sort((left, right) =>
          left.repo === right.repo
            ? left.number - right.number
            : left.repo.localeCompare(right.repo),
        );
        if (github.usage.truncatedConnections > 0) {
          errors.push({
            code: "github-pagination-truncated",
            message: `${github.usage.truncatedConnections} GitHub collection(s) exceeded githubPageLimit.`,
            source: "github",
            at,
            retryable: false,
          });
        }
        const changes = calculateChanges(current.items, items, at);
        const report: TriageReport = {
          generatedAt: at,
          lastScanAt: at,
          items,
          changes,
          errors,
          usage: {
            githubRequests: github.usage.requests,
            githubPages: github.usage.pages,
            inferenceRequests: inference.usage.requests,
            inferenceCacheHits: inference.usage.cacheHits,
            inferenceInputCharacters: inference.usage.inputCharacters,
            inferenceBudget: config.inference.requestBudget,
            inferenceBudgetRemaining: inference.usage.remaining,
            truncatedConnections: github.usage.truncatedConnections,
            details: storage.usageSummary(at),
          },
          configSummary: configSummary(config),
        };
        assertLease();
        storage.saveReport(report);
        current = report;
        return report;
      } finally {
        clearInterval(heartbeat);
        scanning = false;
        storage.releaseLease(owner);
        if (closed) storage.close();
      }
    },
    status: () => refreshElapsed(current, config, now()),
    changes: () => current.changes,
    explain(item) {
      const key = normalizeItemKey(item);
      return explanation(
        key,
        refreshElapsed(current, config, now()).items.find(
          (candidate) => `${candidate.repo}#${candidate.number}` === key,
        ),
      );
    },
    close() {
      if (closed) return;
      closed = true;
      if (!scanning) storage.close();
    },
  };
};
