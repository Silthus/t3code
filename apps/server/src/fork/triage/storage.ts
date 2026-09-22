// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { InferenceConfig, JsonObject, TriageReport } from "./types.ts";

interface JsonRow {
  readonly report_json: string;
}

interface CacheRow {
  readonly value_json: string;
}

interface LeaseRow {
  readonly owner: string;
  readonly expires_at: number;
}

export class TriageStorage {
  readonly #database: NodeSqlite.DatabaseSync;

  constructor(dataDir: string) {
    NodeFS.mkdirSync(dataDir, { recursive: true });
    this.#database = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "triage.sqlite"));
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generated_at TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inference_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inference_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, item TEXT NOT NULL,
        estimated_cost REAL NOT NULL, reported_cost REAL, input_tokens INTEGER, output_tokens INTEGER,
        status TEXT NOT NULL DEFAULT 'reserved'
      );
      CREATE TABLE IF NOT EXISTS leases (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  latestReport(): TriageReport | null {
    const row = this.#database
      .prepare("SELECT report_json FROM reports ORDER BY id DESC LIMIT 1")
      .get() as JsonRow | undefined;
    return row ? (JSON.parse(row.report_json) as TriageReport) : null;
  }

  saveReport(report: TriageReport): void {
    this.#transaction(() => {
      this.#database
        .prepare("INSERT INTO reports(generated_at, report_json) VALUES (?, ?)")
        .run(report.generatedAt, JSON.stringify(report));
    });
  }

  readCache(key: string): unknown | null {
    const row = this.#database
      .prepare("SELECT value_json FROM inference_cache WHERE cache_key = ?")
      .get(key) as CacheRow | undefined;
    return row ? JSON.parse(row.value_json) : null;
  }

  writeCache(key: string, value: unknown, updatedAt: string): void {
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO inference_cache(cache_key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(value), updatedAt);
    });
  }

  acquireLease(owner: string, now: number, leaseSeconds: number, name = "scan"): boolean {
    return this.#transaction(() => {
      const row = this.#database
        .prepare("SELECT owner, expires_at FROM leases WHERE name = ?")
        .get(name) as LeaseRow | undefined;
      if (row && row.expires_at > now && row.owner !== owner) return false;
      this.#database
        .prepare(
          `INSERT INTO leases(name, owner, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
        )
        .run(name, owner, now + leaseSeconds * 1000);
      return true;
    });
  }

  releaseLease(owner: string, name = "scan"): void {
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM leases WHERE name = ? AND owner = ?").run(name, owner);
    });
  }

  renewLease(owner: string, now: number, seconds: number, name = "scan"): boolean {
    return (
      this.#database
        .prepare("UPDATE leases SET expires_at = ? WHERE name = ? AND owner = ?")
        .run(now + seconds * 1000, name, owner).changes === 1
    );
  }

  usageSummary(at: string): JsonObject {
    const period = (prefix: string) => {
      const row = this.#database
        .prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(COALESCE(reported_cost, estimated_cost)),0) AS charged,
        COALESCE(SUM(estimated_cost),0) AS estimated, COALESCE(SUM(reported_cost),0) AS reported,
        COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
        SUM(CASE WHEN reported_cost IS NULL THEN 1 ELSE 0 END) AS unknownCostAttempts FROM inference_attempts WHERE at LIKE ?`)
        .get(prefix + "%") as {
        requests: number;
        charged: number;
        estimated: number;
        reported: number;
        inputTokens: number;
        outputTokens: number;
        unknownCostAttempts: number | null;
      };
      return { ...row, unknownCostAttempts: row.unknownCostAttempts ?? 0 };
    };
    return {
      daily: period(at.slice(0, 10)),
      monthly: period(at.slice(0, 7)),
      assumptions:
        "USD. Unknown attempt cost retains reservation. Input estimate uses UTF-8 bytes as an upper bound; output is estimated free. Prices are configurable.",
    };
  }

  reserveAttempt(
    item: string,
    at: string,
    estimate: number,
    config: InferenceConfig,
  ): number | null {
    return this.#transaction(() => {
      const summary = this.usageSummary(at);
      const daily = summary.daily as JsonObject,
        monthly = summary.monthly as JsonObject;
      if (
        Number(daily.requests) >= (config.dailyRequestBudget ?? 500) ||
        Number(monthly.requests) >= (config.monthlyRequestBudget ?? 10000) ||
        Number(daily.charged) + estimate > (config.dailyCostBudgetUsd ?? 1) ||
        Number(monthly.charged) + estimate > (config.monthlyCostBudgetUsd ?? 10) ||
        config.dailyCostBudgetUsd === 0 ||
        config.monthlyCostBudgetUsd === 0
      )
        return null;
      return Number(
        this.#database
          .prepare("INSERT INTO inference_attempts(at,item,estimated_cost) VALUES(?,?,?)")
          .run(at, item, estimate).lastInsertRowid,
      );
    });
  }

  finishAttempt(
    id: number,
    result: {
      cost: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      status: string;
    },
  ): void {
    this.#database
      .prepare(
        "UPDATE inference_attempts SET reported_cost=?,input_tokens=?,output_tokens=?,status=? WHERE id=?",
      )
      .run(result.cost, result.inputTokens, result.outputTokens, result.status, id);
  }

  close(): void {
    this.#database.close();
  }

  #transaction<Result>(run: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
