/**
 * run.ts (npm run eval) rejects an invalid RETRY_DELAYS_MS before any network call.
 * Spawns the real CLI with a preload that turns any fetch into a recorded failure.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let dir = "";
let trap = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "run-cli-"));
  trap = path.join(dir, "no-network.mjs");
  writeFileSync(trap, 'globalThis.fetch = async () => { process.stderr.write("NETWORK_CALL\\n"); throw new Error("network disabled in test"); };\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runCli(retryDelays: string, extra: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(trap).href, "src/run.ts", ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      RETRY_DELAYS_MS: retryDelays,
      OPENROUTER_API_KEY: "test-key-not-real",
      OPENROUTER_BASE_URL: "http://127.0.0.1:9/api/v1",
      MODEL: "m/x",
    },
  });
}

describe("run.ts CLI RETRY_DELAYS_MS check", () => {
  for (const bad of ["0", "1.5", "1e3", "1,,2", "-1", "1000,0"]) {
    it(`exits 1 with a clear message and no network call for ${JSON.stringify(bad)}`, () => {
      const r = runCli(bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("RETRY_DELAYS_MS is invalid");
      expect(r.stderr).not.toContain("NETWORK_CALL");
    }, 60_000);
  }

  it("a valid value passes the check (control)", () => {
    const r = runCli("1000,2000", ["--fixture", "--task", "chain_json_regex_add"]);
    expect(r.stderr).not.toContain("RETRY_DELAYS_MS is invalid");
    expect(r.status).toBe(0);
  }, 60_000);
});

function runEvalCli(extra: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(trap).href, "src/run.ts", ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key-not-real",
      OPENROUTER_BASE_URL: "http://127.0.0.1:9/api/v1",
      MODEL: "m/x",
    },
  });
}

function runMatrixCli(extra: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(trap).href, "src/matrix.ts", ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key-not-real",
      OPENROUTER_BASE_URL: "http://127.0.0.1:9/api/v1",
    },
  });
}

const E61F639_MSG = "Suite 0.1.0 was retired from main; reproduce it at commit e61f639 (see README).";

describe("run.ts CLI --suite 0.1.0 rejection", () => {
  it("--suite 0.1.0 exits 1 with e61f639 pointer and no network call", () => {
    const r = runEvalCli(["--suite", "0.1.0"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(E61F639_MSG);
    expect(r.stderr).not.toContain("NETWORK_CALL");
  }, 60_000);

  it("--suite 0.1.0 --fixture exits 1 with e61f639 pointer and no network call", () => {
    const r = runEvalCli(["--suite", "0.1.0", "--fixture"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(E61F639_MSG);
    expect(r.stderr).not.toContain("NETWORK_CALL");
  }, 60_000);
});

describe("matrix CLI --suite 0.1.0 rejection", () => {
  it("--suite 0.1.0 exits 1 with e61f639 pointer and no network call", () => {
    const r = runMatrixCli(["--suite", "0.1.0"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(E61F639_MSG);
    expect(r.stderr).not.toContain("NETWORK_CALL");
  }, 60_000);

  it("--suite 0.1.0 --fixture exits 1 with e61f639 pointer and no network call", () => {
    const r = runMatrixCli(["--suite", "0.1.0", "--fixture"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(E61F639_MSG);
    expect(r.stderr).not.toContain("NETWORK_CALL");
  }, 60_000);
});
