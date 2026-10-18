/**
 * Ban scan: verify public surface does not contain forbidden terms.
 * Exit 0 if clean, exit 1 if violations found.
 * Output never reveals the forbidden terms (not even masked).
 *
 * Detection: extracts alphanumeric runs from each line, normalizes (lowercase, a-z0-9 only),
 * then hashes individual runs and concatenations of 2-4 adjacent runs. Also detects string
 * literal fragments joined by + or .join() within a line. Compares against a set of SHA256 hashes.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/**
 * SHA256 hashes of normalized banned terms. Normalization: lowercase, keep only a-z0-9.
 * This set contains no plaintext terms.
 */
export const BANNED_HASHES = new Set([
  "1720b5bf165cebe26e75c6c392a61a1aed38f32e44e806c502cc90894fef93fd",
  "89b7505ad79ad4892d6f2f110320da7b79e4110e0117b8249de318688c3ad83b",
  "e15babd93b9d2b806c35a3b0800c34771676a33caf01679d5082ebcbaa75e52d",
  "1a26b7dee6fc52c891e769ddab4fc79f4b6cce1b07a90fe95e53dcec05567f09",
  "e4ef8d8ccfc2ef35454689438da9a2ce2cacbf2fc1dbe3c4976534f7810e53db",
  "304e1b9833fb7aa34933689d332ba49890310202d86ad343760f703700d0a966",
  "1562206543da764123c21bd524674f0a8aaf49c8a89744c97352fe677f7e4006",
  "36dcf0328d674af11b53f1a19285e709ccb8e44308c0c487960853894792fdef",
  "ff0139d07c592e9ae929bd63ee9f24bb555ae6f97b6d8891af8213944126be80",
  "08aaa9f32114b313e08f0c1b0f8a85d797835a4e34afe67fafbc1e520e080c89",
]);

/**
 * Allowlist: file paths (relative to root) with specific line numbers that are permitted.
 * Keyed by relative path, value is set of 1-indexed line numbers.
 */
export const ALLOWLIST: Map<string, Set<number>> = new Map([
  ["src/llm/client.ts", new Set([261])],
  ["src/tests/payload-identity.test.ts", new Set([77, 78])],
]);

export const SCAN_EXTENSIONS = [".ts", ".js", ".json", ".md", ".txt", ".env"];
export const IGNORE_DIRS = ["node_modules", ".git", "dist", "logs"];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function extractAlphanumericRuns(text: string): string[] {
  return text.match(/[a-zA-Z0-9]+/g) ?? [];
}

/**
 * Extract string literal fragments from potential concatenation expressions.
 * Handles: 'a' + 'b', "a" + "b", ['a', 'b'].join(''), template pieces.
 */
function extractStringFragments(line: string): string[][] {
  const groups: string[][] = [];

  const concatPattern = /(['"`])([^'"`]*)\1\s*\+\s*(['"`])([^'"`]*)\3/g;
  let match;
  while ((match = concatPattern.exec(line)) !== null) {
    groups.push([match[2], match[4]]);
  }

  const joinPattern = /\[\s*((?:['"`][^'"`]*['"`]\s*,?\s*)+)\s*\]\s*\.\s*join\s*\(\s*['"`]?[^)]*['"`]?\s*\)/g;
  while ((match = joinPattern.exec(line)) !== null) {
    const inner = match[1];
    const parts = inner.match(/['"`]([^'"`]*)['"`]/g);
    if (parts) {
      groups.push(parts.map((p) => p.slice(1, -1)));
    }
  }

  return groups;
}

/**
 * Generate all candidate strings from a line for hash checking.
 * Returns normalized candidates ready for hashing.
 */
export function generateCandidates(line: string): string[] {
  const candidates: string[] = [];
  const runs = extractAlphanumericRuns(line);

  for (const run of runs) {
    candidates.push(normalize(run));
  }

  for (let i = 0; i < runs.length; i++) {
    for (let len = 2; len <= 4 && i + len <= runs.length; len++) {
      const combined = runs.slice(i, i + len).join("");
      candidates.push(normalize(combined));
    }
  }

  const fragments = extractStringFragments(line);
  for (const group of fragments) {
    const joined = group.join("");
    candidates.push(normalize(joined));

    const fragRuns: string[] = [];
    for (const frag of group) {
      fragRuns.push(...extractAlphanumericRuns(frag));
    }
    for (let i = 0; i < fragRuns.length; i++) {
      for (let len = 2; len <= 4 && i + len <= fragRuns.length; len++) {
        const combined = fragRuns.slice(i, i + len).join("");
        candidates.push(normalize(combined));
      }
    }
  }

  return candidates;
}

export function checkLine(
  line: string,
  hashes: Set<string>,
  extraHashes?: Set<string>,
): boolean {
  const candidates = generateCandidates(line);
  for (const c of candidates) {
    if (c.length === 0) continue;
    const h = hashString(c);
    if (hashes.has(h)) return true;
    if (extraHashes?.has(h)) return true;
  }
  return false;
}

export function scanDir(
  dir: string,
  ignoreDirs: string[] = IGNORE_DIRS,
): string[] {
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
  hashes: Set<string> = BANNED_HASHES,
  allowedLines?: Set<number>,
  extraHashes?: Set<string>,
): Array<{ line: number; allowed: boolean }> {
  const violations: Array<{ line: number; allowed: boolean }> = [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    if (checkLine(lines[i], hashes, extraHashes)) {
      const allowed = allowedLines?.has(lineNum) ?? false;
      violations.push({ line: lineNum, allowed });
    }
  }

  return violations;
}

export interface ScanResult {
  hits: Array<{ path: string; line: number; allowed: boolean }>;
  total: number;
  allowedCount: number;
}

export function runScan(
  rootDir: string,
  hashes: Set<string> = BANNED_HASHES,
  ignoreDirs: string[] = IGNORE_DIRS,
  allowlist: Map<string, Set<number>> = ALLOWLIST,
  extraHashes?: Set<string>,
): ScanResult {
  const files = scanDir(rootDir, ignoreDirs);
  const hits: Array<{ path: string; line: number; allowed: boolean }> = [];

  for (const file of files) {
    const relPath = path.relative(rootDir, file);
    const allowedLines = allowlist.get(relPath);
    const violations = scanFile(file, hashes, allowedLines, extraHashes);

    for (const v of violations) {
      hits.push({ path: relPath, line: v.line, allowed: v.allowed });
    }
  }

  const allowedCount = hits.filter((h) => h.allowed).length;
  return { hits, total: hits.length, allowedCount };
}

export function formatOutput(result: ScanResult): string {
  const lines: string[] = [];
  lines.push("Ban scan: checking for forbidden terms...");
  lines.push("---");

  for (const hit of result.hits) {
    const mark = hit.allowed ? " [allowed]" : "";
    lines.push(`${hit.path}:${hit.line}${mark}`);
  }

  lines.push("---");
  const nonAllowed = result.total - result.allowedCount;
  if (nonAllowed > 0) {
    lines.push(`FAIL: ${nonAllowed} non-allowed hit(s), ${result.allowedCount} allowed`);
  } else if (result.allowedCount > 0) {
    lines.push(`PASS: 0 non-allowed hits, ${result.allowedCount} allowed`);
  } else {
    lines.push("PASS: 0 hits");
  }

  return lines.join("\n");
}

function main(): void {
  const result = runScan(ROOT);
  console.log(formatOutput(result));
  const nonAllowed = result.total - result.allowedCount;
  process.exit(nonAllowed > 0 ? 1 : 0);
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("ban-scan.ts") ||
    process.argv[1].endsWith("ban-scan.js"));

if (isMainModule) {
  main();
}
