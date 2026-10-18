/**
 * Tests for ban-scan using synthetic test terms (never real banned terms).
 * All fixtures are built at test time from hashes plus a synthetic, non-banned test term.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  runScan,
  formatOutput,
  scanFile,
  generateCandidates,
  checkLine,
  exitCode,
  allowlistFor,
  isRepoRoot,
  BANNED_HASHES,
  IGNORE_DIRS,
  SPAN_HASHES,
  ALLOWLIST,
  MIN_TERM_LEN,
  MAX_TERM_LEN,
} from "./ban-scan.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Synthetic separator term ("zzfakeword zzother" normalizes to the joined form).
const SYNTHETIC_SPAN_HASH = createHash("sha256").update("zzfakewordzzother").digest("hex");

const SYNTHETIC_TERM = "zzsyntheticfaketermzz";
const SYNTHETIC_HASH = createHash("sha256").update(SYNTHETIC_TERM).digest("hex");
const TEST_HASHES = new Set([SYNTHETIC_HASH]);

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const SCRIPT = path.join(REPO_ROOT, "src/tests/ban-scan.ts");

/**
 * Env for a whole-repo CLI run: the inherited scan overrides are stripped so a parent
 * BAN_SCAN_ROOT or BAN_SCAN_TEST_HASH can never redirect or widen the repo scan.
 * Only values passed explicitly in `extra` reach the child.
 */
function repoCliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BAN_SCAN_ROOT;
  delete env.BAN_SCAN_TEST_HASH;
  return { ...env, ...extra };
}

function runCli(env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });
    return { status: 0, stdout };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? null, stdout: err.stdout ?? "" };
  }
}

function allowedHitLines(): string[] {
  return [...ALLOWLIST].flatMap(([f, ls]) => [...ls].map((l) => `${f}:${l} [allowed]`));
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

  it("detects term embedded in longer words (old substring parity)", () => {
    const testFile = path.join(tempDir, "embedded.ts");
    writeFileSync(
      testFile,
      [
        `const a = "${SYNTHETIC_TERM}s";`,
        `const myZz${SYNTHETIC_TERM.toUpperCase()}App = 1;`,
        `const id_${SYNTHETIC_TERM}2026 = 2;`,
        `// pre${SYNTHETIC_TERM}ing`,
        `const clean = "zzsynthetic only";`,
      ].join("\n") + "\n",
    );

    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.hits.map((h) => h.line)).toEqual([1, 2, 3, 4]);
  });

  it("detects separator terms embedded across two runs only for span hashes", () => {
    const lines = [
      "x outzzfakeword zzotherx",
      "id_zzfakeword-zzother2026",
      "zzfakewordzzother",
    ];
    for (const l of lines) {
      expect(checkLine(l, new Set([SYNTHETIC_SPAN_HASH]), undefined, new Set([SYNTHETIC_SPAN_HASH]))).toBe(true);
    }
    // Without the span set, cross-run embedding is not matched.
    expect(checkLine(lines[0], new Set([SYNTHETIC_SPAN_HASH]), undefined, new Set())).toBe(false);
  });

  it("detects a 5-way split across string concatenation", () => {
    const testFile = path.join(tempDir, "concat5.ts");
    writeFileSync(testFile, `const x = "zzsyn-thet-ic" + "fake-termzz";\n`);
    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.total).toBe(1);
  });

  it("detects a 5-part array join", () => {
    const testFile = path.join(tempDir, "join5.ts");
    writeFileSync(testFile, `const x = ["zz", "synth", "etic", "fake", "termzz"].join("");\n`);
    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.total).toBe(1);
  });

  it("scans .yml and .yaml files", () => {
    writeFileSync(path.join(tempDir, "ci.yml"), `name: ${SYNTHETIC_TERM}\n`);
    writeFileSync(path.join(tempDir, "conf.yaml"), `key: ${SYNTHETIC_TERM}\n`);
    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.hits.map((h) => h.path).sort()).toEqual(["ci.yml", "conf.yaml"]);
  });

  for (const ext of [".mjs", ".cjs", ".sh", ".html", ".tsx", ".jsx"]) {
    it(`scans ${ext} files`, () => {
      writeFileSync(path.join(tempDir, `canary${ext}`), `x = "${SYNTHETIC_TERM}"\n`);
      const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
      expect(result.hits.map((h) => h.path)).toEqual([`canary${ext}`]);
    });
  }

  it("scans extensionless text files", () => {
    writeFileSync(path.join(tempDir, "Dockerfile"), `LABEL x="${SYNTHETIC_TERM}"\n`);
    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.hits.map((h) => h.path)).toEqual(["Dockerfile"]);
  });

  it("skips extensionless binary files", () => {
    writeFileSync(
      path.join(tempDir, "blob"),
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${SYNTHETIC_TERM}\n`)]),
    );
    const result = runScan(tempDir, TEST_HASHES, undefined, new Map());
    expect(result.total).toBe(0);
  });

  it("default allowlist does not exempt other lines of the real client.ts", () => {
    const rel = path.join("src", "llm", "client.ts");
    mkdirSync(path.join(tempDir, "src", "llm"), { recursive: true });
    const original = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const planted = `${original.replace(/\n?$/, "\n")}// ${SYNTHETIC_TERM}\n`;
    writeFileSync(path.join(tempDir, rel), planted);
    const plantedLine = planted.split("\n").length - 1;

    // Line granularity of the default allowlist, applied explicitly to a mirror of the file.
    const result = runScan(tempDir, BANNED_HASHES, IGNORE_DIRS, ALLOWLIST, new Set([SYNTHETIC_HASH]));
    const allowedLines = [...(ALLOWLIST.get("src/llm/client.ts") ?? [])];
    expect(result.hits.filter((h) => h.allowed).map((h) => h.line)).toEqual(allowedLines);
    expect(result.hits.filter((h) => !h.allowed).map((h) => h.line)).toEqual([plantedLine]);
    expect(formatOutput(result)).toContain("FAIL: 1 non-allowed hit(s)");
  });

  it("default allowlist applies only at the repo root (resolved real path)", () => {
    expect(isRepoRoot(REPO_ROOT)).toBe(true);
    expect(allowlistFor(REPO_ROOT)).toBe(ALLOWLIST);
    expect(isRepoRoot(tempDir)).toBe(false);
    expect(allowlistFor(tempDir).size).toBe(0);
    // A symlink to the repo root resolves to the repo root.
    const link = path.join(tempDir, "repo-link");
    symlinkSync(REPO_ROOT, link, "dir");
    expect(isRepoRoot(link)).toBe(true);
    expect(isRepoRoot(path.join(REPO_ROOT, "src", ".."))).toBe(true);
  });

  it("CLI at a non-repo root does not apply the default allowlist", () => {
    // Mirror the allowlisted files at their repo-relative paths under a temp root.
    for (const rel of ALLOWLIST.keys()) {
      mkdirSync(path.join(tempDir, path.dirname(rel)), { recursive: true });
      cpSync(path.join(REPO_ROOT, rel), path.join(tempDir, rel));
    }
    const { status, stdout } = runCli({ ...repoCliEnv(), BAN_SCAN_ROOT: tempDir });
    const expected = [...ALLOWLIST].flatMap(([f, ls]) => [...ls].map((l) => `${f}:${l}`));
    const hitLines = stdout.split("\n").filter((l) => /:\d+( \[allowed\])?$/.test(l));

    expect(status).toBe(1);
    expect(hitLines.sort()).toEqual(expected.sort());
    expect(stdout).not.toContain("[allowed]");
    expect(stdout).toContain(`FAIL: ${expected.length} non-allowed hit(s), 0 allowed`);
  });

  it("exitCode is 1 on non-allowed hits and 0 otherwise", () => {
    expect(exitCode({ hits: [{ path: "a", line: 1, allowed: false }], total: 1, allowedCount: 0 })).toBe(1);
    expect(exitCode({ hits: [{ path: "a", line: 1, allowed: true }], total: 1, allowedCount: 1 })).toBe(0);
    expect(exitCode({ hits: [], total: 0, allowedCount: 0 })).toBe(0);
  });

  it("CLI on the repo exits 0 with exactly the allowlisted hits", () => {
    const { status, stdout } = runCli(repoCliEnv());
    const expected = allowedHitLines();
    const hitLines = stdout.split("\n").filter((l) => /:\d+( \[allowed\])?$/.test(l));
    expect(status).toBe(0);
    expect(hitLines.sort()).toEqual(expected.sort());
    expect(stdout).toContain(`PASS: 0 non-allowed hits, ${expected.length} allowed`);
  });

  it("whole-repo CLI ignores BAN_SCAN_ROOT in the parent env and catches a hit planted in the repo", () => {
    // Parent env points the scanner at a clean copy of src/ (the redirect a stray env could cause).
    const clean = path.join(tempDir, "clean");
    cpSync(path.join(REPO_ROOT, "src"), path.join(clean, "src"), { recursive: true });
    // Token and hash are built at runtime; nothing planted exists in the repo as text.
    const token = `zzplant${randomBytes(6).toString("hex")}zz`;
    const plantRel = `.ban-scan-plant-${process.pid}-${randomBytes(3).toString("hex")}.txt`;
    const plantPath = path.join(REPO_ROOT, plantRel);
    const saved = { root: process.env.BAN_SCAN_ROOT, hash: process.env.BAN_SCAN_TEST_HASH };
    process.env.BAN_SCAN_ROOT = clean;
    process.env.BAN_SCAN_TEST_HASH = hashString("zzunrelatedparenthashzz");
    try {
      writeFileSync(plantPath, `note: ${token}\n`);
      const { status, stdout } = runCli(repoCliEnv({ BAN_SCAN_TEST_HASH: hashString(token) }));
      const expected = [...allowedHitLines(), `${plantRel}:1`];
      const hitLines = stdout.split("\n").filter((l) => /:\d+( \[allowed\])?$/.test(l));

      expect(status).toBe(1);
      expect(hitLines.sort()).toEqual(expected.sort());
      expect(stdout).toContain(`FAIL: 1 non-allowed hit(s), ${allowedHitLines().length} allowed`);
      expect(stdout).not.toContain(token);
    } finally {
      rmSync(plantPath, { force: true });
      if (saved.root === undefined) delete process.env.BAN_SCAN_ROOT;
      else process.env.BAN_SCAN_ROOT = saved.root;
      if (saved.hash === undefined) delete process.env.BAN_SCAN_TEST_HASH;
      else process.env.BAN_SCAN_TEST_HASH = saved.hash;
    }
  });

  it("CLI exits 1 on non-allowed hits and shows counts only", () => {
    const testFile = path.join(tempDir, "violation.ts");
    writeFileSync(testFile, `const secret = "${SYNTHETIC_TERM}";\n`);

    const script = path.join(REPO_ROOT, "src/tests/ban-scan.ts");
    let exitCode: number | null = null;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, ["--import", "tsx", script], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          BAN_SCAN_ROOT: tempDir,
          BAN_SCAN_TEST_HASH: SYNTHETIC_HASH,
        },
      });
      exitCode = 0;
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string };
      exitCode = err.status ?? null;
      stdout = err.stdout ?? "";
    }

    expect(exitCode).toBe(1);
    expect(stdout).toContain("violation.ts:1");
    expect(stdout).toContain("FAIL: 1 non-allowed hit(s)");
    expect(stdout.toLowerCase()).not.toContain(SYNTHETIC_TERM.toLowerCase());
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

    it("matches the pinned digest of the sorted hash set (catches dropped or swapped hashes)", () => {
      const digest = hashString([...BANNED_HASHES].sort().join("\n"));
      expect(digest).toBe("4fcebbc2f5cb4a5b184171273e787712ad998479c222e84ec76ed13d828ae615");
    });

    it("SPAN_HASHES is a subset of BANNED_HASHES", () => {
      expect(SPAN_HASHES.size).toBe(2);
      for (const h of SPAN_HASHES) expect(BANNED_HASHES.has(h)).toBe(true);
    });

    it("synthetic term length is within the substring window", () => {
      expect(SYNTHETIC_TERM.length).toBeGreaterThanOrEqual(MIN_TERM_LEN);
      expect(SYNTHETIC_TERM.length).toBeLessThanOrEqual(MAX_TERM_LEN);
    });
  });
});

