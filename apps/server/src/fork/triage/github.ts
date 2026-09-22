// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import type { RepoScope, TriageItemKind } from "./types.ts";
export interface GitHubRecord {
  readonly [key: string]: unknown;
}
export interface GitHubItemSnapshot {
  readonly repo: string;
  readonly number: number;
  readonly kind: TriageItemKind;
  readonly item: GitHubRecord;
  readonly pull: GitHubRecord | null;
  readonly comments: readonly GitHubRecord[];
  readonly reviewComments: readonly GitHubRecord[];
  readonly reviews: readonly GitHubRecord[];
  readonly checks: readonly GitHubRecord[];
  readonly timeline: readonly GitHubRecord[];
  readonly parent: GitHubRecord | null;
  readonly children: readonly GitHubRecord[];
  readonly blockedBy: readonly GitHubRecord[];
  readonly blocking: readonly GitHubRecord[];
  readonly truncatedSources: readonly string[];
  readonly unavailableSources: readonly string[];
  readonly statuses?: readonly GitHubRecord[];
  readonly runs?: readonly GitHubRecord[];
  readonly rules?: readonly GitHubRecord[];
  readonly reviewState?: GitHubRecord | null;
  readonly reviewThreads?: readonly GitHubRecord[];
  readonly linkedTargets?: readonly GitHubRecord[];
}
export interface GitHubUsage {
  requests: number;
  pages: number;
  truncatedConnections: number;
}
const isRecord = (v: unknown): v is GitHubRecord =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const records = (v: unknown): readonly GitHubRecord[] =>
  Array.isArray(v) ? v.filter(isRecord) : [];
const stringAt = (v: GitHubRecord, k: string) => (typeof v[k] === "string" ? v[k] : null);
const numberAt = (v: GitHubRecord, k: string) => (typeof v[k] === "number" ? v[k] : null);
export const githubRecord = { isRecord, stringAt, numberAt };
export const getGitHubToken = () =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "gh",
      ["auth", "token"],
      { encoding: "utf8", timeout: 15000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error || !stdout.trim())
          reject(new Error("GitHub authentication is unavailable. Run `gh auth login`."));
        else resolve(stdout.trim());
      },
    );
  });
export class GitHubClient {
  readonly usage: GitHubUsage = { requests: 0, pages: 0, truncatedConnections: 0 };
  readonly #options: {
    fetch: typeof globalThis.fetch;
    pageLimit: number;
    token: string;
    lookbackDays?: number;
    now?: Date;
    timeoutMs?: number;
    retries?: number;
    concurrency?: number;
  };
  #active = 0;
  readonly #waiting: Array<() => void> = [];
  readonly #rules = new Map<string, Promise<unknown>>();
  readonly #itemReads = new Map<string, Promise<unknown>>();
  constructor(options: GitHubClient["options"]) {
    this.#options = options;
  }
  // Public option type keeps the constructor usable without a runtime dependency.
  declare readonly options: {
    fetch: typeof globalThis.fetch;
    pageLimit: number;
    token: string;
    lookbackDays?: number;
    now?: Date;
    timeoutMs?: number;
    retries?: number;
    concurrency?: number;
  };
  async #request(path: string, body?: GitHubRecord): Promise<Response> {
    if (this.#active >= (this.#options.concurrency ?? 4))
      await new Promise<void>((r) => this.#waiting.push(r));
    else this.#active++;
    try {
      for (let attempt = 0; ; attempt++) {
        this.usage.requests++;
        let response: Response;
        try {
          response = await this.#options.fetch(`https://api.github.com${path}`, {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${this.#options.token}`,
              "user-agent": "t3-fork-triage",
              "x-github-api-version": "2026-03-10",
              ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(this.#options.timeoutMs ?? 15000),
          });
        } catch {
          if (attempt >= (this.#options.retries ?? 2))
            throw new Error(`GitHub request timed out or failed: ${path}`);
          await NodeTimersPromises.setTimeout(250 * 2 ** attempt);
          continue;
        }
        if (response.ok) return response;
        const retry =
          response.status === 429 ||
          response.status >= 500 ||
          (response.status === 403 &&
            (response.headers.has("retry-after") ||
              response.headers.get("x-ratelimit-remaining") === "0"));
        if (!retry || attempt >= (this.#options.retries ?? 2))
          throw new Error(`GitHub ${path} returned HTTP ${response.status}`);
        const retryAfter = response.headers.get("retry-after");
        const wait = retryAfter
          ? /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now()
          : response.headers.get("x-ratelimit-remaining") === "0"
            ? Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now()
            : 250 * 2 ** attempt;
        if (wait > 30000)
          throw new Error(
            `GitHub rate limit requires retry after ${Math.ceil(wait / 1000)} seconds`,
          );
        await NodeTimersPromises.setTimeout(Math.max(0, wait));
      }
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
  async #get(path: string): Promise<unknown> {
    let pending = this.#itemReads.get(path);
    if (!pending) {
      pending = this.#request(path).then((response) => response.json());
      this.#itemReads.set(path, pending);
    }
    return pending;
  }
  async #pages(path: string, key?: string, search = false, oldestUpdatedAt?: string) {
    const result: GitHubRecord[] = [];
    let truncated = false;
    for (let page = 1; page <= Math.min(this.#options.pageLimit, search ? 10 : Infinity); page++) {
      const response = await this.#request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      this.usage.pages++;
      const body: unknown = await response.json();
      result.push(...records(key && isRecord(body) ? body[key] : body));
      const next = response.headers.get("link")?.includes('rel="next"') ?? false;
      truncated =
        next ||
        (search &&
          isRecord(body) &&
          (body.incomplete_results === true || Number(body.total_count) > 1000));
      // Search date qualifiers can lag item state. Bound the descending history
      // by the returned timestamps, then apply the closure lookback in code.
      if (
        oldestUpdatedAt &&
        result.at(-1)?.updated_at &&
        String(result.at(-1)?.updated_at) < oldestUpdatedAt
      ) {
        truncated = false;
        break;
      }
      if (!next) break;
    }
    if (truncated) this.usage.truncatedConnections++;
    return { records: result, truncated };
  }
  async scanScope(
    scope: RepoScope,
    tracked: readonly { number: number; kind: TriageItemKind }[] = [],
  ): Promise<readonly GitHubItemSnapshot[]> {
    const cutoff = new Date(
      (this.#options.now ?? new Date()).getTime() - (this.#options.lookbackDays ?? 30) * 86400000,
    ).toISOString();
    const listings: Array<{ records: readonly GitHubRecord[]; truncated: boolean }> = [];
    if (scope.authors?.length) {
      for (const author of scope.authors) {
        for (const state of scope.includeClosed === false
          ? ["is:open"]
          : ["is:open", "is:closed"]) {
          const query = `repo:${scope.repo} author:${author} ${state}${scope.kinds?.length === 1 ? (scope.kinds[0] === "pull-request" ? " is:pr" : " is:issue") : ""}`;
          listings.push(
            await this.#pages(
              `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc`,
              "items",
              true,
              state === "is:closed" ? cutoff : undefined,
            ),
          );
        }
      }
    } else {
      listings.push(
        await this.#pages(`/repos/${scope.repo}/issues?state=open&sort=updated&direction=desc`),
      );
      if (scope.includeClosed !== false)
        listings.push(
          await this.#pages(
            `/repos/${scope.repo}/issues?state=closed&since=${cutoff}&sort=updated&direction=desc`,
          ),
        );
    }
    const listed = new Map<number, GitHubRecord>();
    for (const listing of listings)
      for (const item of listing.records) {
        const n = numberAt(item, "number");
        const kind = isRecord(item.pull_request) ? "pull-request" : "issue";
        if (
          n !== null &&
          (!scope.kinds || scope.kinds.includes(kind)) &&
          (item.state !== "closed" || String(item.closed_at ?? item.updated_at) >= cutoff)
        )
          listed.set(n, item);
      }
    for (const item of tracked)
      if (!listed.has(item.number))
        listed.set(item.number, {
          number: item.number,
          ...(item.kind === "pull-request" ? { pull_request: {} } : {}),
        });
    const results: GitHubItemSnapshot[] = [];
    // Item batches bound memory and requests. A failed source stays local to its item.
    const values = [...listed.values()];
    for (let i = 0; i < values.length; i += 4) {
      const batch = await Promise.all(
        values.slice(i, i + 4).map((item) =>
          this.loadItem(
            scope.repo,
            Number(item.number),
            isRecord(item.pull_request) ? "pull-request" : "issue",
            item,
            listings.some((x) => x.truncated),
          ),
        ),
      );
      results.push(...batch);
    }
    return results;
  }
  async loadItem(
    repo: string,
    number: number,
    kind: TriageItemKind,
    listed: GitHubRecord = {},
    listingTruncated = false,
  ): Promise<GitHubItemSnapshot> {
    const unavailable: string[] = [],
      truncated: string[] = listingTruncated ? ["scope-items"] : [];
    const get = async (path: string, source: string, absent = false): Promise<unknown> => {
      try {
        return await this.#get(path);
      } catch (error) {
        if (!(absent && String(error).includes("HTTP 404"))) unavailable.push(source);
        return null;
      }
    };
    const pages = async (path: string, source: string, key?: string) => {
      try {
        const p = await this.#pages(path, key);
        if (p.truncated) truncated.push(source);
        return p.records;
      } catch {
        unavailable.push(source);
        return [];
      }
    };
    const prefix = `/repos/${repo}`;
    const value = await get(`${prefix}/issues/${number}`, "item");
    const item = isRecord(value) ? value : listed;
    const [comments, timeline] = await Promise.all([
      pages(`${prefix}/issues/${number}/comments`, "comments"),
      pages(`${prefix}/issues/${number}/timeline`, "timeline"),
    ]);
    const parentValue = await get(`${prefix}/issues/${number}/parent`, "parent", true);
    const [children, blockedBy, blocking] = await Promise.all([
      pages(`${prefix}/issues/${number}/sub_issues`, "children"),
      pages(`${prefix}/issues/${number}/dependencies/blocked_by`, "blocked-by"),
      pages(`${prefix}/issues/${number}/dependencies/blocking`, "blocking"),
    ]);
    const p =
      kind === "pull-request" ? await get(`${prefix}/pulls/${number}`, "pull-request") : null;
    const pull = isRecord(p) ? p : null;
    let reviews: readonly GitHubRecord[] = [],
      reviewComments: readonly GitHubRecord[] = [],
      checks: GitHubRecord[] = [],
      statuses: GitHubRecord[] = [],
      runs: GitHubRecord[] = [],
      rules: readonly GitHubRecord[] = [],
      reviewState: GitHubRecord | null = null;
    const reviewThreads: GitHubRecord[] = [];
    if (pull) {
      const head = isRecord(pull.head) ? stringAt(pull.head, "sha") : null;
      [reviews, reviewComments] = await Promise.all([
        pages(`${prefix}/pulls/${number}/reviews`, "reviews"),
        pages(`${prefix}/pulls/${number}/comments`, "review-comments"),
      ]);
      if (head) {
        const shas = [
          head,
          ...(pull.state === "open" &&
          typeof pull.merge_commit_sha === "string" &&
          pull.mergeable === true
            ? [pull.merge_commit_sha]
            : []),
        ];
        for (const sha of shas) {
          const [c, s, r] = await Promise.all([
            pages(`${prefix}/commits/${sha}/check-runs`, "checks", "check_runs"),
            pages(`${prefix}/commits/${sha}/statuses`, "statuses"),
            pages(`${prefix}/actions/runs?head_sha=${sha}`, "actions", "workflow_runs"),
          ]);
          checks.push(...c.map((v) => ({ ...v, observed_sha: sha })));
          statuses.push(...s.map((v) => ({ ...v, observed_sha: sha })));
          runs.push(...r);
        }
      } else unavailable.push("head");
      const base = isRecord(pull.base) ? stringAt(pull.base, "ref") : null;
      if (base) {
        const path = `${prefix}/rules/branches/${encodeURIComponent(base)}`;
        try {
          let pending = this.#rules.get(path);
          if (!pending) {
            pending = this.#get(path);
            this.#rules.set(path, pending);
          }
          rules = records(await pending);
        } catch {
          unavailable.push("branch-rules");
        }
      } else unavailable.push("branch-rules");
      try {
        let cursor: string | null = null;
        const [owner, name] = repo.split("/");
        for (let page = 0; page < this.#options.pageLimit; page++) {
          const response = await this.#request("/graphql", {
            query: `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){viewerPermission pullRequest(number:$number){reviewDecision mergeStateStatus mergeable baseRef{branchProtectionRule{requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews dismissesStaleReviews requiresStatusChecks requiredStatusCheckContexts requiredStatusChecks{context app{databaseId}} requiresCommitSignatures requiresDeployments}} reviewRequests(first:100){nodes{requestedReviewer{__typename ... on User{login} ... on Team{name}}} pageInfo{hasNextPage}} closingIssuesReferences(first:100){nodes{number url state} pageInfo{hasNextPage}} reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path} pageInfo{hasNextPage endCursor}}}}}`,
            variables: { owner, name, number, cursor },
          });
          const data: unknown = await response.json();
          if (
            !isRecord(data) ||
            data.errors ||
            !isRecord(data.data) ||
            !isRecord(data.data.repository)
          )
            throw new Error("GraphQL evidence unavailable");
          const repository = data.data.repository;
          if (!isRecord(repository.pullRequest)) throw new Error("Pull request inaccessible");
          reviewState = {
            ...repository.pullRequest,
            viewerPermission: repository.viewerPermission,
          };
          if (page === 0) {
            const ref = reviewState.baseRef;
            if (!isRecord(ref) || !("branchProtectionRule" in ref)) {
              if (pull.state === "open") unavailable.push("classic-branch-protection");
            } else if (isRecord(ref.branchProtectionRule)) {
              const legacy = ref.branchProtectionRule;
              const additional: GitHubRecord[] = [];
              if (legacy.requiresApprovingReviews === true)
                additional.push({
                  type: "pull_request",
                  parameters: {
                    required_approving_review_count: legacy.requiredApprovingReviewCount,
                    require_code_owner_review: legacy.requiresCodeOwnerReviews,
                    dismiss_stale_reviews_on_push: legacy.dismissesStaleReviews,
                  },
                });
              if (legacy.requiresStatusChecks === true)
                additional.push({
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: Array.isArray(legacy.requiredStatusChecks)
                      ? legacy.requiredStatusChecks.filter(isRecord).map((check) => ({
                          context: check.context,
                          integration_id: isRecord(check.app) ? check.app.databaseId : null,
                        }))
                      : Array.isArray(legacy.requiredStatusCheckContexts)
                        ? legacy.requiredStatusCheckContexts.map((context) => ({ context }))
                        : [],
                  },
                });
              if (legacy.requiresCommitSignatures === true)
                additional.push({ type: "required_signatures" });
              if (legacy.requiresDeployments === true)
                additional.push({ type: "required_deployments" });
              rules = [...rules, ...additional];
            }
          }
          for (const connection of ["reviewRequests", "closingIssuesReferences"]) {
            const c = reviewState[connection];
            if (isRecord(c) && isRecord(c.pageInfo) && c.pageInfo.hasNextPage === true)
              truncated.push(connection);
          }
          const threads = reviewState.reviewThreads;
          if (!isRecord(threads) || !isRecord(threads.pageInfo))
            throw new Error("Review threads unavailable");
          reviewThreads.push(...records(threads.nodes));
          if (!threads.pageInfo.hasNextPage) break;
          cursor = stringAt(threads.pageInfo, "endCursor");
          if (!cursor || page + 1 === this.#options.pageLimit) {
            truncated.push("review-threads");
            this.usage.truncatedConnections++;
            break;
          }
        }
      } catch {
        unavailable.push("review-state");
      }
    }
    const linkedTargets: GitHubRecord[] = [];
    const urls = new Set<string>();
    for (const event of timeline)
      if (
        isRecord(event.source) &&
        isRecord(event.source.issue) &&
        typeof event.source.issue.html_url === "string"
      )
        urls.add(event.source.issue.html_url);
    const body = `${String(pull?.body ?? item.body ?? "")}\n${comments.map((c) => String(c.body ?? "")).join("\n")}`;
    for (const match of body.matchAll(
      /https:\/\/github.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)|(?<![\w/])#(\d+)/g,
    ))
      urls.add(`https://github.com/${match[1] ?? repo}/issues/${match[2] ?? match[3]}`);
    if (urls.size > 20) truncated.push("linked-targets");
    for (const url of [...urls].slice(0, 20)) {
      const m = url.match(/github.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
      if (!m || `${m[1]}#${m[2]}` === `${repo}#${number}`) continue;
      const target = await get(`/repos/${m[1]}/issues/${m[2]}`, "linked-target");
      if (!isRecord(target)) continue;
      const targetPull = isRecord(target.pull_request)
        ? await get(`/repos/${m[1]}/pulls/${m[2]}`, "linked-target-pull")
        : null;
      linkedTargets.push({
        ...target,
        ...(isRecord(targetPull) ? targetPull : {}),
        targetRepo: m[1],
      });
    }
    return {
      repo,
      number,
      kind,
      item,
      pull,
      comments,
      timeline,
      parent: isRecord(parentValue) ? parentValue : null,
      children,
      blockedBy,
      blocking,
      reviews,
      reviewComments,
      checks,
      statuses,
      runs,
      rules,
      reviewState,
      reviewThreads,
      linkedTargets,
      unavailableSources: [...new Set(unavailable)],
      truncatedSources: [...new Set(truncated)],
    };
  }
}
