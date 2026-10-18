import { describe, it, expect } from "vitest";
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
