import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScan, formatOutput, scanFile } from "./ban-scan.js";

const SYNTHETIC_TERMS = ["zzfaketermzz", "xxsyntheticxx"];

describe("ban-scan", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ban-scan-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects a synthetic term and returns correct hit count and path:line", () => {
    const testFile = path.join(tempDir, "test-file.ts");
    writeFileSync(testFile, `const name = "zzfaketermzz";\n`);

    const result = runScan(tempDir, SYNTHETIC_TERMS);

    expect(result.total).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].path).toBe("test-file.ts");
    expect(result.hits[0].line).toBe(1);
  });

  it("output contains no scanned terms", () => {
    const testFile = path.join(tempDir, "leaked.ts");
    writeFileSync(testFile, `const job = "xxsyntheticxx";\n`);

    const result = runScan(tempDir, SYNTHETIC_TERMS);
    const output = formatOutput(result);

    for (const term of SYNTHETIC_TERMS) {
      expect(output.toLowerCase()).not.toContain(term.toLowerCase());
    }

    expect(output).toContain("leaked.ts:1");
    expect(output).toContain("FAIL: 1 hit(s)");
  });

  it("returns PASS: 0 hits for clean directory", () => {
    const cleanFile = path.join(tempDir, "clean.ts");
    writeFileSync(cleanFile, "const x = 42;\n");

    const result = runScan(tempDir, SYNTHETIC_TERMS);
    const output = formatOutput(result);

    expect(result.total).toBe(0);
    expect(output).toContain("PASS: 0 hits");
  });

  it("scanFile returns line numbers only", () => {
    const testFile = path.join(tempDir, "file.ts");
    writeFileSync(
      testFile,
      `line one\ncontains zzfaketermzz here\nline three\n`
    );

    const violations = scanFile(testFile, SYNTHETIC_TERMS);

    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
    expect(Object.keys(violations[0])).toEqual(["line"]);
  });

  it("output format shows only path:line, no content", () => {
    const testFile = path.join(tempDir, "app.ts");
    writeFileSync(testFile, `secret: "zzfaketermzz"\n`);

    const result = runScan(tempDir, SYNTHETIC_TERMS);
    const output = formatOutput(result);

    expect(output).toContain("app.ts:1");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("[");
    expect(output).not.toContain('"');
  });
});
