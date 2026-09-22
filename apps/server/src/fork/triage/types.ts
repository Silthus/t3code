export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>;
export type JsonObject = { readonly [key: string]: JsonValue };

export type TriageItemKind = "issue" | "pull-request";
export type TriageLifecycle = "open" | "draft" | "closed" | "merged";
export type TriageClassification =
  | "ready-maintainer"
  | "review"
  | "draft"
  | "blocked"
  | "unknown"
  | "issue"
  | "stale-closed"
  | "replaced";
export type TriageCertainty = "factual" | "inferred" | "uncertain" | "stale";

export interface TriageBlocker {
  readonly code: string;
  readonly label: string;
  readonly actor: string | null;
  readonly evidenceUrls: ReadonlyArray<string>;
  readonly details?: JsonObject;
}

export interface TriageEvidence {
  readonly sourceId: string;
  readonly url: string;
  readonly excerpt: string;
  readonly author: string | null;
  readonly at: string | null;
  readonly details?: JsonObject;
}

export interface TriageRelation {
  readonly kind:
    | "parent"
    | "child"
    | "depends-on"
    | "blocks"
    | "replaces"
    | "replaced-by"
    | "references";
  readonly target: string;
  readonly source: "github-native" | "text-candidate";
  readonly evidenceUrl: string;
  readonly certainty: TriageCertainty;
  readonly details?: JsonObject;
}

export interface TriageJudgment {
  readonly id: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly certainty: TriageCertainty;
  readonly confidence: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly evidenceUrls: ReadonlyArray<string>;
  readonly details?: JsonObject;
}

export interface TriageItemError {
  readonly code: string;
  readonly message: string;
  readonly source: string;
  readonly at: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export interface TriageItem {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly kind: TriageItemKind;
  readonly lifecycle: TriageLifecycle;
  readonly classification: TriageClassification;
  readonly blockers: ReadonlyArray<TriageBlocker>;
  readonly nextActors: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<TriageEvidence>;
  readonly lastSuccessfulRefresh: string | null;
  readonly errors: ReadonlyArray<TriageItemError>;
  readonly certainty: TriageCertainty;
  readonly relations: ReadonlyArray<TriageRelation>;
  readonly judgments: ReadonlyArray<TriageJudgment>;
  readonly details?: JsonObject;
}

export interface TriageChange {
  readonly item: string;
  readonly detectedAt: string;
  readonly kind: "added" | "removed" | "changed";
  readonly fields: ReadonlyArray<string>;
  readonly before?: JsonObject;
  readonly after?: JsonObject;
}

export interface TriageError {
  readonly code: string;
  readonly message: string;
  readonly source: string;
  readonly at: string;
  readonly retryable: boolean;
  readonly item?: string;
  readonly details?: JsonObject;
}

export interface TriageUsage {
  readonly details?: JsonObject;
  readonly githubRequests: number;
  readonly githubPages: number;
  readonly inferenceRequests: number;
  readonly inferenceCacheHits: number;
  readonly inferenceInputCharacters: number;
  readonly inferenceBudget: number;
  readonly inferenceBudgetRemaining: number;
  readonly truncatedConnections: number;
}

export interface TriageConfigSummary {
  readonly scopes: ReadonlyArray<string>;
  readonly refreshIntervalMinutes: number;
  readonly staleAfterMinutes: number;
  readonly githubPageLimit: number;
  readonly inferenceEnabled: boolean;
  readonly inferenceProvider: string;
  readonly inferenceModel: string;
  readonly mergePolicies: ReadonlyArray<string>;
}

export interface TriageReport {
  readonly generatedAt: string;
  readonly lastScanAt: string | null;
  readonly items: ReadonlyArray<TriageItem>;
  readonly changes: ReadonlyArray<TriageChange>;
  readonly errors: ReadonlyArray<TriageError>;
  readonly usage: TriageUsage;
  readonly configSummary: TriageConfigSummary;
}

export interface TriageExplanation {
  readonly item: string;
  readonly found: boolean;
  readonly summary: string;
  readonly classification: TriageClassification | null;
  readonly blockers: ReadonlyArray<TriageBlocker>;
  readonly nextActors: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<TriageEvidence>;
  readonly judgments: ReadonlyArray<TriageJudgment>;
  readonly errors: ReadonlyArray<TriageItemError>;
}

export interface RepoScope {
  readonly repo: string;
  readonly authors?: ReadonlyArray<string>;
  readonly kinds?: ReadonlyArray<TriageItemKind>;
  readonly includeClosed?: boolean;
}

export interface MergePolicy {
  readonly requiredCheckSources?: ReadonlyArray<{
    readonly context: string;
    readonly integrationId: number;
  }>;
  readonly repo: string;
  readonly requiredApprovals: number;
  readonly requiredChecks: ReadonlyArray<string>;
  readonly requireMergeable: boolean;
  readonly mergeQueue?: "required" | "optional" | "disabled";
  readonly skippedChecks?: "accept" | "block";
  readonly externalQueue?: "maintainer" | "none";
  readonly upstreamPermission?: "maintainer" | "viewer";
  readonly maintainerActors?: ReadonlyArray<string>;
}

export interface InferenceConfig {
  readonly dailyRequestBudget?: number;
  readonly monthlyRequestBudget?: number;
  readonly dailyCostBudgetUsd?: number;
  readonly monthlyCostBudgetUsd?: number;
  readonly inputCostPerMillionUsd?: number;
  readonly maxInputTokens?: number;
  readonly configuredModelVersion?: string;
  readonly confidenceThreshold?: number;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly provider: string;
  readonly model: string;
  readonly requestBudget: number;
  readonly retries: number;
  readonly maxInputCharacters: number;
  readonly requestTimeoutMs: number;
}

export interface TriageConfig {
  readonly username?: string;
  readonly lookbackDays?: number;
  readonly stalledAfterDays?: number;
  readonly githubTimeoutMs?: number;
  readonly githubRetries?: number;
  readonly githubConcurrency?: number;
  readonly scopes: ReadonlyArray<RepoScope>;
  readonly mergePolicies: ReadonlyArray<MergePolicy>;
  readonly refreshIntervalMinutes: number;
  readonly staleAfterMinutes: number;
  readonly githubPageLimit: number;
  readonly leaseSeconds: number;
  readonly inference: InferenceConfig;
}

export interface MonitorDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly getGitHubToken?: () => Promise<string>;
  readonly now?: () => Date;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface MonitorOptions {
  readonly dataDir: string;
  readonly configPath?: string;
  readonly dependencies?: MonitorDependencies;
}

export interface TriageMonitor {
  scan(): Promise<TriageReport>;
  status(): TriageReport;
  changes(): ReadonlyArray<TriageChange>;
  explain(item: string): TriageExplanation;
  close(): void;
}
