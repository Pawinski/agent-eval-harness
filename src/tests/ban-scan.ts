/**
 * Ban scan: verify public surface does not contain forbidden terms.
 * Exit 0 if clean, exit 1 if violations found.
 * Output never reveals the forbidden terms (not even masked).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

export const BANNED_TERMS = [
  ["R", "eid"].join(""),
  ["car", "eer"].join(""),
  ["Cash", "Snap"].join(""),
  ["Sal", "on"].join(""),
  ["Stay", "22"].join(""),
  ["Door", " C"].join(""),
  ["Sta", "ff"].join(""),
  ["job", "-hunt"].join(""),
  ["Confid", "ence"].join(""),
];

export const SCAN_EXTENSIONS = [".ts", ".js", ".json", ".md", ".txt", ".env"];
export const IGNORE_DIRS = ["node_modules", ".git", "dist", "logs"];

export function scanDir(dir: string, ignoreDirs: string[] = IGNORE_DIRS): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    if (ignoreDirs.includes(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...scanDir(fullPath, ignoreDirs));
    } else if (stat.isFile()) {
      const ext = path.extname(entry);
      if (SCAN_EXTENSIONS.includes(ext) || entry === ".env.example") {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function scanFile(
  filePath: string,
  terms: string[] = BANNED_TERMS
): Array<{ line: number }> {
  const violations: Array<{ line: number }> = [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const term of terms) {
      if (lineText.toLowerCase().includes(term.toLowerCase())) {
        violations.push({ line: i + 1 });
      }
    }
  }

  return violations;
}

export interface ScanResult {
  hits: Array<{ path: string; line: number }>;
  total: number;
}

export function runScan(
  rootDir: string,
  terms: string[] = BANNED_TERMS,
  ignoreDirs: string[] = IGNORE_DIRS
): ScanResult {
  const files = scanDir(rootDir, ignoreDirs);
  const hits: Array<{ path: string; line: number }> = [];

  for (const file of files) {
    const relPath = path.relative(rootDir, file);
    const violations = scanFile(file, terms);

    for (const v of violations) {
      hits.push({ path: relPath, line: v.line });
    }
  }

  return { hits, total: hits.length };
}

export function formatOutput(result: ScanResult): string {
  const lines: string[] = [];
  lines.push("Ban scan: checking for forbidden terms...");
  lines.push("---");

  for (const hit of result.hits) {
    lines.push(`${hit.path}:${hit.line}`);
  }

  lines.push("---");
  if (result.total > 0) {
    lines.push(`FAIL: ${result.total} hit(s)`);
  } else {
    lines.push("PASS: 0 hits");
  }

  return lines.join("\n");
}

function main(): void {
  const result = runScan(ROOT);
  console.log(formatOutput(result));
  process.exit(result.total > 0 ? 1 : 0);
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("ban-scan.ts") ||
    process.argv[1].endsWith("ban-scan.js"));

if (isMainModule) {
  main();
}
