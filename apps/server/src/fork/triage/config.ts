// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import type {
  InferenceConfig,
  MergePolicy,
  RepoScope,
  TriageConfig,
  TriageItemKind,
} from "./types.ts";
const record = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error("Expected a configuration object");
  return v as Record<string, unknown>;
};
const num = (v: unknown, fallback: number, min = 0, integer = true): number => {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v)))
    throw new Error(`Invalid numeric configuration: ${String(v)}`);
  return v;
};
const str = (v: unknown, fallback: string): string => {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !v.trim())
    throw new Error("Expected a nonempty configuration string");
  return v;
};
const bool = (v: unknown, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error("Expected a configuration boolean");
  return v;
};
const strings = (v: unknown, fallback: readonly string[] = []): readonly string[] => {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0))
    throw new Error("Expected an array of strings");
  return v;
};
const choice = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !values.includes(v as T))
    throw new Error(`Invalid configuration choice: ${String(v)}`);
  return v as T;
};
const repo = (v: unknown) => {
  const value = str(v, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error("Repository must be owner/name");
  return value;
};
const array = (v: unknown): readonly unknown[] => {
  if (!Array.isArray(v)) throw new Error("Expected a configuration array");
  return v;
};
export const readConfig = (configPath?: string): TriageConfig => {
  const input = record(configPath ? JSON.parse(NodeFS.readFileSync(configPath, "utf8")) : {});
  const username = str(input.username, "Silthus");
  const scopes: readonly RepoScope[] =
    input.scopes === undefined
      ? [
          { repo: "PostHog/posthog", authors: [username], kinds: ["pull-request"] },
          { repo: "PostHog/posthog.com", authors: [username], kinds: ["pull-request"] },
          { repo: "Silthus/posthog" },
        ]
      : array(input.scopes).map((v) => {
          const s = record(v);
          const kinds = strings(s.kinds, ["issue", "pull-request"]);
          if (!kinds.every((k) => k === "issue" || k === "pull-request"))
            throw new Error("Invalid item kind");
          return {
            repo: repo(s.repo),
            ...(s.authors === undefined ? {} : { authors: strings(s.authors) }),
            kinds: kinds as readonly TriageItemKind[],
            includeClosed: bool(s.includeClosed, true),
          };
        });
  const mergePolicies: readonly MergePolicy[] =
    input.mergePolicies === undefined
      ? []
      : array(input.mergePolicies).map((v) => {
          const p = record(v);
          return {
            repo: repo(p.repo),
            requiredApprovals: num(p.requiredApprovals, 1),
            requiredChecks: strings(p.requiredChecks),
            requireMergeable: bool(p.requireMergeable, true),
            mergeQueue: choice(p.mergeQueue, ["required", "optional", "disabled"], "optional"),
            skippedChecks: choice(p.skippedChecks, ["accept", "block"], "block"),
            externalQueue: choice(p.externalQueue, ["maintainer", "none"], "none"),
            upstreamPermission: choice(
              p.upstreamPermission,
              ["maintainer", "viewer"],
              "maintainer",
            ),
            maintainerActors: strings(p.maintainerActors),
          };
        });
  const i = input.inference === undefined ? {} : record(input.inference);
  const inference: InferenceConfig = {
    enabled: bool(i.enabled, true),
    endpoint: str(i.endpoint, "https://ai-gateway.vercel.sh/v1/evaluate"),
    provider: str(i.provider, "vercel-ai-gateway"),
    model: str(i.model, "typesafe-ai/jev"),
    requestBudget: num(i.requestBudget, 50),
    retries: num(i.retries, 2),
    maxInputCharacters: num(i.maxInputCharacters, 24000, 1),
    requestTimeoutMs: num(i.requestTimeoutMs, 30000, 1),
    dailyRequestBudget: num(i.dailyRequestBudget, 500),
    monthlyRequestBudget: num(i.monthlyRequestBudget, 10000),
    dailyCostBudgetUsd: num(i.dailyCostBudgetUsd, 1, 0, false),
    monthlyCostBudgetUsd: num(i.monthlyCostBudgetUsd, 10, 0, false),
    inputCostPerMillionUsd: num(i.inputCostPerMillionUsd, 0.042, 0, false),
    maxInputTokens: num(i.maxInputTokens, 32000, 1),
    configuredModelVersion: str(i.configuredModelVersion, "unpinned"),
    confidenceThreshold: num(i.confidenceThreshold, 0.85, 0, false),
  };
  if ((inference.confidenceThreshold ?? 0) > 1)
    throw new Error("confidenceThreshold must be at most 1");
  if (!inference.endpoint.startsWith("https://"))
    throw new Error("Inference endpoint must use HTTPS");
  return {
    username,
    scopes,
    mergePolicies,
    lookbackDays: num(input.lookbackDays, 30),
    stalledAfterDays: num(input.stalledAfterDays, 14),
    refreshIntervalMinutes: num(input.refreshIntervalMinutes, 15, 1),
    staleAfterMinutes: num(input.staleAfterMinutes, 60, 1),
    githubPageLimit: num(input.githubPageLimit, 20, 1),
    githubTimeoutMs: num(input.githubTimeoutMs, 15000, 1),
    githubRetries: num(input.githubRetries, 2),
    githubConcurrency: num(input.githubConcurrency, 4, 1),
    leaseSeconds: num(input.leaseSeconds, 1800, 3),
    inference,
  };
};
