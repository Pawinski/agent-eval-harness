import { describe, it, expect, vi } from "vitest";
import { printSummaryToConsole } from "../matrix.js";
import { getSuiteTasks, SUITE_CONFIGS, type RunResult } from "../matrix/types.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "../../results");

interface ResultRow {
  sha: string;
  suite: string;
  model: string;
  run_n: number;
  pass: number;
  total: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number | null;
  cost_usd: number;
  date: string;
}

const EXPECTED_FIELDS = [
  "sha",
  "suite",
  "model",
  "run_n",
  "pass",
  "total",
  "tokens_in",
  "tokens_out",
  "tokens_cached",
  "cost_usd",
  "date",
] as const;

function collectJsonFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith("_")) continue;
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...collectJsonFiles(fullPath));
      } else if (entry.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return files;
}

function isValidDateYYYYMMDD(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

function is40HexString(str: string): boolean {
  return /^[0-9a-f]{40}$/i.test(str);
}

describe("results schema validation", () => {
  const jsonFiles = collectJsonFiles(RESULTS_DIR);

  it("should have at least one result file", () => {
    expect(jsonFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("results/0.1.0 result files render with tasks.ts gone", () => {
    // The 0.1.0 suite source is gone from this commit...
    expect(() => getSuiteTasks("0.1.0")).toThrow();
    const suiteDir = path.join(RESULTS_DIR, "0.1.0");
    const rows = readdirSync(suiteDir)
      .filter((e) => e.endsWith(".json") && !e.startsWith("_"))
      .map((e) => JSON.parse(readFileSync(path.join(suiteDir, e), "utf8")) as ResultRow);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const runs: RunResult[] = rows.map((r) => ({
      model: r.model, runN: r.run_n, pass: r.pass, total: r.total,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out, tokensCached: r.tokens_cached, costUsd: r.cost_usd,
      emptyTasks: [], emptyCount: 0, calls: [], retries: 0, parametersFetched: null,
    }));
    // ...yet the stored rows still render through the matrix summary.
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    try {
      printSummaryToConsole(runs, "0.1.0", SUITE_CONFIGS["0.1.0"].defaultCapUsd, SUITE_CONFIGS["0.1.0"].taskCount);
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("\n");
    expect(out).toContain("Suite: 0.1.0 | Cap: $10.00 | Tasks: 7");
    for (const r of rows) {
      expect(r.suite).toBe("0.1.0");
      expect(out).toContain(`| ${r.model} | ${r.run_n} | ${r.pass}/${r.total} |`);
    }
    const perModel = lines.slice(lines.findIndex((l) => l.includes("Per-Model Summary")));
    for (const model of new Set(rows.map((r) => r.model))) {
      const passes = rows.filter((r) => r.model === model).sort((a, b) => a.run_n - b.run_n).map((r) => `${r.pass}/7`).join(", ");
      expect(perModel.some((l) => l.startsWith(`| ${model} | ${passes} |`))).toBe(true);
    }
  });

  for (const filePath of jsonFiles) {
    const relPath = path.relative(RESULTS_DIR, filePath);

    describe(`results/${relPath}`, () => {
      const content = readFileSync(filePath, "utf8");
      const data = JSON.parse(content) as ResultRow;

      it("has exactly the expected fields", () => {
        const keys = Object.keys(data).sort();
        const expected = [...EXPECTED_FIELDS].sort();
        expect(keys).toEqual(expected);
      });

      it("sha is a 40-hex string", () => {
        expect(typeof data.sha).toBe("string");
        expect(is40HexString(data.sha)).toBe(true);
      });

      it("suite is a string", () => {
        expect(typeof data.suite).toBe("string");
        expect(data.suite.length).toBeGreaterThan(0);
      });

      it("model is a string", () => {
        expect(typeof data.model).toBe("string");
        expect(data.model.length).toBeGreaterThan(0);
      });

      it("run_n is an integer >= 1", () => {
        expect(Number.isInteger(data.run_n)).toBe(true);
        expect(data.run_n).toBeGreaterThanOrEqual(1);
      });

      it("pass is an integer", () => {
        expect(Number.isInteger(data.pass)).toBe(true);
      });

      it("total is an integer and pass <= total", () => {
        expect(Number.isInteger(data.total)).toBe(true);
        expect(data.pass).toBeLessThanOrEqual(data.total);
      });

      it("tokens_in is an integer", () => {
        expect(Number.isInteger(data.tokens_in)).toBe(true);
      });

      it("tokens_out is an integer", () => {
        expect(Number.isInteger(data.tokens_out)).toBe(true);
      });

      it("tokens_cached is an integer or null", () => {
        if (data.tokens_cached !== null) {
          expect(Number.isInteger(data.tokens_cached)).toBe(true);
        } else {
          expect(data.tokens_cached).toBeNull();
        }
      });

      it("cost_usd is a number >= 0", () => {
        expect(typeof data.cost_usd).toBe("number");
        expect(data.cost_usd).toBeGreaterThanOrEqual(0);
      });

      it("date is YYYY-MM-DD", () => {
        expect(typeof data.date).toBe("string");
        expect(isValidDateYYYYMMDD(data.date)).toBe(true);
      });
    });
  }
});
