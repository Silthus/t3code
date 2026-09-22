#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { TriageStorage } from "./storage.ts";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { getGitHubToken } from "./github.ts";
import { createMonitor, readConfig } from "./monitor.ts";
import type { TriageExplanation, TriageItem, TriageReport } from "./types.ts";

type OutputFormat = "json" | "markdown" | "text";

interface Arguments {
  readonly command: string;
  readonly dataDir: string;
  readonly configPath?: string;
  readonly format: OutputFormat;
  readonly item?: string;
}

export const parseArguments = (args: ReadonlyArray<string>): Arguments => {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (value === "--help" || value === "-h")
      return { command: "help", dataDir: "", format: "text" };
    if (value.startsWith("--")) {
      if (!["--format", "--config", "--data-dir", "--item"].includes(value))
        throw new Error(`Unknown option: ${value}`);
      const next = args[++i];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      options.set(value, next);
    } else positional.push(value);
  }
  const format = options.get("--format") ?? "text";
  if (format !== "json" && format !== "markdown" && format !== "text")
    throw new Error("--format must be json, markdown, or text");
  const command = positional[0] ?? "status";
  if (!["doctor", "scan", "watch", "status", "changes", "explain", "help"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  if (positional.length > (command === "explain" ? 2 : 1))
    throw new Error("Unexpected positional argument");
  const configPath = options.get("--config") ?? process.env.T3CODE_TRIAGE_CONFIG;
  const item = options.get("--item") ?? positional[1];
  return {
    command,
    format,
    dataDir:
      options.get("--data-dir") ??
      process.env.T3_FORK_TRIAGE_DATA_DIR ??
      NodePath.join(NodeOS.homedir(), ".t3-fork-triage"),
    ...(configPath ? { configPath } : {}),
    ...(item ? { item } : {}),
  };
};

const groupName = (item: TriageItem) =>
  item.lifecycle === "merged"
    ? "shipped"
    : item.lifecycle === "closed"
      ? item.classification === "replaced"
        ? "shipped through replacement"
        : "closed"
      : item.classification;
const groupedItems = (report: TriageReport) =>
  [...report.items].sort(
    (a, b) =>
      groupName(a).localeCompare(groupName(b)) ||
      a.repo.localeCompare(b.repo) ||
      a.number - b.number,
  );

const renderReportText = (report: TriageReport) => {
  const lines = [
    `Last scan: ${report.lastScanAt ?? "never"}`,
    `Items: ${report.items.length}, changes: ${report.changes.length}, errors: ${report.errors.length}`,
  ];
  let previousGroup = "";
  for (const item of groupedItems(report)) {
    const group = groupName(item);
    if (group !== previousGroup) {
      lines.push("", `Group: ${group}`, "");
      previousGroup = group;
    }
    lines.push(
      `${item.repo}#${item.number} [${item.lifecycle}/${item.classification}] ${item.title}`,
      `  ${item.url}`,
      `  Next: ${item.nextActors.join(", ") || "none"}; evidence: ${item.certainty}; refreshed: ${item.lastSuccessfulRefresh ?? "never"}`,
      ...item.errors.map((error) => `  error: ${error.message}`),
      ...item.blockers.map((blocker) => `  blocked: ${blocker.label}`),
    );
  }
  lines.push(
    ...report.errors.map((error) => `Error: ${error.message}`),
    `Usage: ${JSON.stringify(report.usage)}`,
  );
  return lines.join("\n");
};

const renderReportMarkdown = (report: TriageReport) => {
  const lines = ["# Fork triage", "", `Last scan: ${report.lastScanAt ?? "never"}`, ""];
  let previousGroup = "";
  for (const item of groupedItems(report)) {
    const group = groupName(item);
    if (group !== previousGroup) {
      lines.push("", `## ${group}`, "");
      previousGroup = group;
    }
    lines.push(
      `- [${item.repo}#${item.number}](${item.url}) · ${item.classification} · ${item.title}`,
      `  - Lifecycle: ${item.lifecycle}; next: ${item.nextActors.join(", ") || "none"}; certainty: ${item.certainty}; refreshed: ${item.lastSuccessfulRefresh ?? "never"}`,
      ...item.blockers.map(
        (blocker) => `  - ${blocker.label} Actor: ${blocker.actor ?? "unknown"}`,
      ),
    );
  }
  if (report.errors.length > 0) {
    lines.push("", "## Errors", "", ...report.errors.map((error) => `- ${error.message}`));
  }
  return lines.join("\n");
};

export const renderExplanation = (value: TriageExplanation, format: OutputFormat) => {
  if (format === "json") return JSON.stringify(value, null, 2);
  const details = [
    `Next: ${value.nextActors.join(", ") || "none"}`,
    ...value.evidence.map((e) => `${e.sourceId}: ${e.excerpt} (${e.url})`),
    ...value.judgments.map(
      (j) =>
        `${j.label}: ${String(j.value)} (${j.certainty}, confidence ${j.confidence ?? "unknown"})`,
    ),
    ...value.errors.map((e) => e.message),
  ];
  if (format === "markdown") {
    return [
      `# ${value.item}`,
      "",
      value.summary,
      "",
      ...value.blockers.map((blocker) => `- ${blocker.label}`),
      ...details,
    ].join("\n");
  }
  return [
    value.summary,
    ...value.blockers.map((blocker) => `blocked: ${blocker.label}`),
    ...details,
  ].join("\n");
};

export const renderReport = (report: TriageReport, format: OutputFormat) =>
  format === "json"
    ? JSON.stringify(report, null, 2)
    : format === "markdown"
      ? renderReportMarkdown(report)
      : renderReportText(report);

const write = (value: string) => process.stdout.write(`${value}\n`);

export const runCli = async (rawArguments: ReadonlyArray<string>): Promise<number> => {
  const args = parseArguments(rawArguments);
  if (args.command === "help") {
    write(
      "Fork triage: doctor | scan | watch | status | changes | explain <owner/repo#number>\nOptions: --config PATH --data-dir PATH --format json|markdown|text --item ITEM",
    );
    return 0;
  }
  if (args.command === "doctor") {
    const config = readConfig(args.configPath);
    const executable = (name: string) => {
      try {
        return NodeChildProcess.execFileSync(name, ["--version"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim();
      } catch {
        return null;
      }
    };
    const bun = executable("bun"),
      gh = executable("gh");
    let githubAuthenticated = false;
    try {
      await getGitHubToken();
      githubAuthenticated = true;
    } catch {
      /* Report absence without token or subprocess output. */
    }
    write(
      JSON.stringify({
        ok: Boolean(bun && gh && githubAuthenticated),
        bun,
        gh,
        githubAuthenticated,
        scopes: config.scopes.map((scope) => scope.repo),
        inferenceKeyPresent: Boolean(process.env.AI_GATEWAY_API_KEY),
      }),
    );
    return bun && gh && githubAuthenticated ? 0 : 1;
  }

  const monitor = createMonitor({
    dataDir: args.dataDir,
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });
  try {
    if (args.command === "scan") {
      write(renderReport(await monitor.scan(), args.format));
      return 0;
    }
    if (args.command === "status") {
      write(renderReport(monitor.status(), args.format));
      return 0;
    }
    if (args.command === "changes") {
      write(
        args.format === "json"
          ? JSON.stringify(monitor.changes(), null, 2)
          : monitor
              .changes()
              .map((change) => `${change.item} ${change.kind}: ${change.fields.join(", ")}`)
              .join("\n"),
      );
      return 0;
    }
    if (args.command === "explain") {
      if (!args.item) throw new Error("explain requires an item such as owner/repo#123");
      write(renderExplanation(monitor.explain(args.item), args.format));
      return 0;
    }
    if (args.command === "watch") {
      const interval = readConfig(args.configPath).refreshIntervalMinutes * 60_000;
      const lock = new TriageStorage(args.dataDir);
      const owner = NodeCrypto.randomUUID();
      if (!lock.acquireLease(owner, Date.now(), 30, "watch")) {
        lock.close();
        throw new Error("Another watch process owns this data directory.");
      }
      const heartbeat = setInterval(() => lock.renewLease(owner, Date.now(), 30, "watch"), 10000);
      const stop = new AbortController();
      const onSignal = () => stop.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        while (!stop.signal.aborted) {
          write(renderReport(await monitor.scan(), args.format));
          try {
            await NodeTimersPromises.setTimeout(interval, undefined, { signal: stop.signal });
          } catch {
            break;
          }
        }
      } finally {
        clearInterval(heartbeat);
        lock.releaseLease(owner, "watch");
        lock.close();
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
      return 0;
    }
    throw new Error(`Unknown command: ${args.command}`);
  } finally {
    monitor.close();
  }
};

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
