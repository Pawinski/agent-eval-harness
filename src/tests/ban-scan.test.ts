/**
 * Tests for ban-scan using synthetic test terms (never real banned terms).
 * All fixtures are built at test time from hashes plus a synthetic, non-banned test term.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  runScan,
  formatOutput,
  scanFile,
  generateCandidates,
  checkLine,
  BANNED_HASHES,
} from "./ban-scan.js";

const SYNTHETIC_TERM = "zzsyntheticfaketermzz";
const SYNTHETIC_HASH = createHash("sha256").update(SYNTHETIC_TERM).digest("hex");
const TEST_HASHES = new Set([SYNTHETIC_HASH]);

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("ban-scan", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ban-scan-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects exact synthetic term and returns correct hit count and path:line", () => {
    const testFile = path.join(tempDir, "test-file.ts");
    writeFileSync(testFile, `const name = "${SYNTHETIC_TERM}";\n`);

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());

    expect(result.total).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].path).toBe("test-file.ts");
    expect(result.hits[0].line).toBe(1);
    expect(result.hits[0].allowed).toBe(false);
  });

  it("detects case-variant forms", () => {
    const testFile = path.join(tempDir, "case.ts");
    writeFileSync(testFile, `const x = "${SYNTHETIC_TERM.toUpperCase()}";\n`);

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.total).toBe(1);
  });

  it("detects string concatenation split forms", () => {
    const half1 = SYNTHETIC_TERM.slice(0, 11);
    const half2 = SYNTHETIC_TERM.slice(11);
    const testFile = path.join(tempDir, "concat.ts");
    writeFileSync(testFile, `const x = "${half1}" + "${half2}";\n`);

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.total).toBe(1);
  });

  it("detects array join split forms", () => {
    const half1 = SYNTHETIC_TERM.slice(0, 11);
    const half2 = SYNTHETIC_TERM.slice(11);
    const testFile = path.join(tempDir, "join.ts");
    writeFileSync(testFile, `const x = ["${half1}", "${half2}"].join("");\n`);

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.total).toBe(1);
  });

  it("detects terms split by hyphens/underscores/dots", () => {
    const parts = [
      SYNTHETIC_TERM.slice(0, 5),
      SYNTHETIC_TERM.slice(5, 11),
      SYNTHETIC_TERM.slice(11),
    ];
    const testFile = path.join(tempDir, "split.ts");
    writeFileSync(testFile, `const x = "${parts.join("-")}";\n`);

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.total).toBe(1);
  });

  it("output contains no scanned terms", () => {
    const testFile = path.join(tempDir, "leaked.ts");
    writeFileSync(testFile, `const job = "${SYNTHETIC_TERM}";\n`);

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    const output = formatOutput(result);

    expect(output.toLowerCase()).not.toContain(SYNTHETIC_TERM.toLowerCase());
    expect(output).toContain("leaked.ts:1");
    expect(output).toContain("FAIL: 1 non-allowed hit(s)");
  });

  it("returns PASS: 0 hits for clean directory", () => {
    const cleanFile = path.join(tempDir, "clean.ts");
    writeFileSync(cleanFile, "const x = 42;\n");

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    const output = formatOutput(result);

    expect(result.total).toBe(0);
    expect(output).toContain("PASS: 0 hits");
  });

  it("scanFile returns line numbers with allowed flag", () => {
    const testFile = path.join(tempDir, "file.ts");
    writeFileSync(testFile, `line one\ncontains ${SYNTHETIC_TERM} here\nline three\n`);

    const violations = scanFile(testFile, TEST_HASHES);

    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
    expect(violations[0].allowed).toBe(false);
  });

  it("allowlist exempts exact file:line", () => {
    const testFile = path.join(tempDir, "allowed.ts");
    writeFileSync(testFile, `line one\ncontains ${SYNTHETIC_TERM} here\nline three\n`);

    const allowlist = new Map([["allowed.ts", new Set([2])]]);
    const result = runScan(tempDir, TEST_HASHES, undefined, allowlist);

    expect(result.total).toBe(1);
    expect(result.allowedCount).toBe(1);
    expect(result.hits[0].allowed).toBe(true);

    const output = formatOutput(result);
    expect(output).toContain("PASS: 0 non-allowed hits, 1 allowed");
  });

  it("allowlist does not exempt other lines", () => {
    const testFile = path.join(tempDir, "partial.ts");
    writeFileSync(testFile, `${SYNTHETIC_TERM}\nclean\n${SYNTHETIC_TERM}\n`);

    const allowlist = new Map([["partial.ts", new Set([1])]]);
    const result = runScan(tempDir, TEST_HASHES, undefined, allowlist);

    expect(result.total).toBe(2);
    expect(result.allowedCount).toBe(1);
    expect(result.hits.find((h) => h.line === 1)?.allowed).toBe(true);
    expect(result.hits.find((h) => h.line === 3)?.allowed).toBe(false);

    const output = formatOutput(result);
    expect(output).toContain("FAIL: 1 non-allowed hit(s)");
  });

  it("output format shows only path:line, no content", () => {
    const testFile = path.join(tempDir, "app.ts");
    writeFileSync(testFile, `secret: "${SYNTHETIC_TERM}"\n`);

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    const output = formatOutput(result);

    expect(output).toContain("app.ts:1");
    expect(output).not.toContain("secret");
  });

  describe("generateCandidates", () => {
    it("extracts individual alphanumeric runs", () => {
      const candidates = generateCandidates("hello-world_test");
      expect(candidates).toContain("hello");
      expect(candidates).toContain("world");
      expect(candidates).toContain("test");
    });

    it("generates 2-4 adjacent run concatenations", () => {
      const candidates = generateCandidates("a-b-c-d-e");
      expect(candidates).toContain("ab");
      expect(candidates).toContain("abc");
      expect(candidates).toContain("abcd");
      expect(candidates).toContain("bc");
      expect(candidates).toContain("bcd");
      expect(candidates).toContain("bcde");
    });

    it("normalizes to lowercase", () => {
      const candidates = generateCandidates("Hello-WORLD");
      expect(candidates).toContain("hello");
      expect(candidates).toContain("world");
      expect(candidates).toContain("helloworld");
    });
  });

  describe("checkLine", () => {
    it("returns true when line contains hashed term", () => {
      const hashes = new Set([hashString("testterm")]);
      expect(checkLine("const x = testterm;", hashes)).toBe(true);
    });

    it("returns false for clean line", () => {
      const hashes = new Set([hashString("forbidden")]);
      expect(checkLine("const x = allowed;", hashes)).toBe(false);
    });

    it("detects concatenated string literals", () => {
      const hashes = new Set([hashString("foobar")]);
      expect(checkLine("const x = 'foo' + 'bar';", hashes)).toBe(true);
    });

    it("detects array join expressions", () => {
      const hashes = new Set([hashString("foobar")]);
      expect(checkLine("const x = ['foo', 'bar'].join('');", hashes)).toBe(true);
    });

    it("uses extraHashes when provided", () => {
      const hashes = new Set<string>();
      const extra = new Set([hashString("extra")]);
      expect(checkLine("const x = extra;", hashes, extra)).toBe(true);
    });
  });

  describe("BANNED_HASHES validation", () => {
    it("contains only valid SHA256 hex strings", () => {
      for (const h of BANNED_HASHES) {
        expect(h).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it("has expected count", () => {
      expect(BANNED_HASHES.size).toBe(10);
    });
  });
});

