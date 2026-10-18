/**
 * Suite 0.2.0 tools: fixture-backed, no network, no shell, no writes outside memory.
 * Includes all v1 tools (echo, add, json_get, regex_extract, word_count) plus v2 tools.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import type { McpToolResult, McpToolSchema, InProcessMcpOptions } from "./client.js";
import { getDefaultToolDefinitions } from "./client.js";

const VERIFICATION_SALT = "v020-check-7f3a9c";
const PASS_MARKER = "__CHECK_PASS__";
const MAX_STDOUT_BYTES = 1024;
const CHILD_TIMEOUT_MS = 2000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.resolve(__dirname, "../../fixtures");

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;

export interface PatchState {
  original: Map<string, string>;
  patched: Map<string, string>;
}

export interface ErrorRecoveryState {
  errorCounts: Map<string, number>;
}

export interface ToolsV2Context {
  patchState: PatchState;
  errorRecoveryState: ErrorRecoveryState;
}

export function createToolsV2Context(): ToolsV2Context {
  return {
    patchState: {
      original: new Map(),
      patched: new Map(),
    },
    errorRecoveryState: {
      errorCounts: new Map(),
    },
  };
}

function isPathSafe(requestedPath: string): boolean {
  const normalized = path.normalize(requestedPath);
  if (normalized.includes("..")) {
    return false;
  }
  if (path.isAbsolute(normalized)) {
    return false;
  }
  return true;
}

function resolveFixturePath(relativePath: string): string | null {
  if (!isPathSafe(relativePath)) {
    return null;
  }
  const fullPath = path.join(FIXTURES_ROOT, relativePath);
  const realRoot = path.resolve(FIXTURES_ROOT);
  const realPath = path.resolve(fullPath);
  if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
    return null;
  }
  return realPath;
}

export function createReadFileTool(): McpToolSchema & { handler: ToolHandler } {
  return {
    name: "read_file",
    description: "Read a fixture file (path: relative path like code/calculator.ts or data/inventory.csv). Returns numbered lines.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path within fixtures directory" },
      },
      required: ["path"],
    },
    handler: (args) => {
      const relativePath = String(args.path ?? "");
      if (!relativePath) {
        return { ok: false, content: "", error: "path is required" };
      }

      const fullPath = resolveFixturePath(relativePath);
      if (!fullPath) {
        return { ok: false, content: "", error: "path traversal rejected" };
      }

      if (!existsSync(fullPath)) {
        return { ok: false, content: "", error: `file not found: ${relativePath}` };
      }

      try {
        const content = readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        const numbered = lines.map((line, i) => `${String(i + 1).padStart(3, " ")}| ${line}`).join("\n");
        return { ok: true, content: numbered };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };
}

export function createApplyPatchTool(ctx: ToolsV2Context): McpToolSchema & { handler: ToolHandler } {
  return {
    name: "apply_patch",
    description: "Replace a line in a fixture file (path, old_line: line to find, new_line: replacement). Matching ignores leading/trailing whitespace; line-number prefixes from read_file are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the fixture file" },
        old_line: { type: "string", description: "The exact line to replace (trimmed for matching)" },
        new_line: { type: "string", description: "The replacement line" },
      },
      required: ["path", "old_line", "new_line"],
    },
    handler: (args) => {
      const relativePath = String(args.path ?? "");
      let oldLine = String(args.old_line ?? "");
      const newLine = String(args.new_line ?? "");
      
      oldLine = oldLine.replace(/^\s*\d+\|\s?/, "");

      if (!relativePath || !oldLine) {
        return { ok: false, content: "", error: "path and old_line are required" };
      }

      const fullPath = resolveFixturePath(relativePath);
      if (!fullPath) {
        return { ok: false, content: "", error: "path traversal rejected" };
      }

      let content: string;
      if (ctx.patchState.patched.has(relativePath)) {
        content = ctx.patchState.patched.get(relativePath)!;
      } else if (existsSync(fullPath)) {
        content = readFileSync(fullPath, "utf8");
        ctx.patchState.original.set(relativePath, content);
      } else {
        return { ok: false, content: "", error: `file not found: ${relativePath}` };
      }

      const lines = content.split("\n");
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === oldLine.trim()) {
          const indent = lines[i].match(/^(\s*)/)?.[1] ?? "";
          lines[i] = indent + newLine.trim();
          found = true;
          break;
        }
      }

      if (!found) {
        return { ok: false, content: "", error: `line not found: ${oldLine.trim()}` };
      }

      const newContent = lines.join("\n");
      ctx.patchState.patched.set(relativePath, newContent);
      return { ok: true, content: "patch applied" };
    },
  };
}

export function createRunCheckTool(ctx: ToolsV2Context): McpToolSchema & { handler: ToolHandler } {
  return {
    name: "run_check",
    description: "Run a named check (check: sum_array | find_max | greet) on a patched file (path). Returns exit code and result.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the fixture file" },
        check: { type: "string", description: "Check name: sum_array, find_max, greet" },
      },
      required: ["path", "check"],
    },
    handler: (args) => {
      const relativePath = String(args.path ?? "");
      const checkName = String(args.check ?? "");

      if (!relativePath || !checkName) {
        return { ok: false, content: "", error: "path and check are required" };
      }

      const validChecks = ["sum_array", "find_max", "greet"];
      if (!validChecks.includes(checkName)) {
        return { ok: true, content: `exit 1\nunknown check: ${checkName}` };
      }

      let content: string;
      const wasPatched = ctx.patchState.patched.has(relativePath);
      if (wasPatched) {
        content = ctx.patchState.patched.get(relativePath)!;
      } else {
        const fullPath = resolveFixturePath(relativePath);
        if (!fullPath || !existsSync(fullPath)) {
          return { ok: false, content: "", error: `file not found: ${relativePath}` };
        }
        content = readFileSync(fullPath, "utf8");
      }

      const result = runFixtureCheck(content, checkName, wasPatched);
      if (result.exitCode === 0 && result.token) {
        return {
          ok: true,
          content: `exit 0\nverification: ${result.token}`,
          data: result,
        };
      }
      return {
        ok: true,
        content: `exit ${result.exitCode}`,
        data: result,
      };
    },
  };
}

interface CheckResult {
  exitCode: number;
  passed: boolean;
  message: string;
  token?: string;
}

function extractFunctionSource(content: string, funcName: string): string {
  const lines = content.split("\n");
  let inFunc = false;
  let braceCount = 0;
  const funcLines: string[] = [];
  
  const funcPattern = new RegExp(`\\bfunction\\s+${funcName}\\s*\\(`);
  
  for (const line of lines) {
    if (!inFunc && funcPattern.test(line)) {
      inFunc = true;
    }
    if (inFunc) {
      funcLines.push(line.replace(/^export\s+/, ""));
      braceCount += (line.match(/\{/g) || []).length;
      braceCount -= (line.match(/\}/g) || []).length;
      if (braceCount === 0 && funcLines.length > 0) {
        break;
      }
    }
  }
  return funcLines.join("\n");
}

function transpileToJs(tsCode: string): string {
  const result = transpileModule(tsCode, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2020,
      strict: false,
    },
  });
  return result.outputText;
}

function computeFixedToken(checkName: string): string {
  const hash = createHash("sha256");
  hash.update(`suite-0.2.0:${checkName}:${VERIFICATION_SALT}`);
  return hash.digest("hex").slice(0, 8);
}

interface TestCase<T, R> {
  input: T;
  expected: R;
}

/**
 * Check if Node's permission model is available.
 * Returns { ok: true } if --permission works, { ok: false, message } otherwise.
 */
export function checkPermissionModelSupport(): { ok: boolean; message?: string } {
  const nodeVersion = process.versions.node;
  const [major] = nodeVersion.split(".").map(Number);
  
  if (major < 22) {
    return { ok: false, message: `Node ${nodeVersion} is too old; permission model requires Node >= 22` };
  }

  const result = spawnSync(process.execPath, ["--permission", "-e", "console.log('ok')"], {
    env: {},
    timeout: 5000,
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout?.includes("ok")) {
    return { ok: false, message: `Node ${nodeVersion} does not support --permission flag` };
  }

  return { ok: true };
}

/**
 * Preflight check for 0.2.0: verifies Node permission model is available.
 * Call this before any model or paid calls.
 */
export function runPreflight(): void {
  const check = checkPermissionModelSupport();
  if (!check.ok) {
    console.error(`PREFLIGHT FAILED: ${check.message}`);
    console.error("Suite 0.2.0 requires Node >= 22 with permission model support.");
    console.error("Please upgrade Node or use a supported version.");
    process.exit(1);
  }
}

/**
 * Inline worker script for permission-restricted child process.
 * Reads JSON from stdin, runs function in sandboxed vm, outputs PASS_MARKER or nothing.
 */
const WORKER_SCRIPT = `
const vm = require("node:vm");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const { code, funcName, tests } = JSON.parse(input);
    const ctx = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    });
    const inputsJson = JSON.stringify(tests.map(t => t.input));
    const expectedJson = JSON.stringify(tests.map(t => t.expected));
    const script = new vm.Script(\`
      (function() {
        const __inputs = JSON.parse('\${inputsJson.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'")}');
        const __expected = JSON.parse('\${expectedJson.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'")}');
        \${code}
        const __func = \${funcName};
        if (typeof __func !== "function") return false;
        for (let __i = 0; __i < __inputs.length; __i++) {
          try {
            if (__func(__inputs[__i]) !== __expected[__i]) return false;
          } catch { return false; }
        }
        return true;
      })();
    \`);
    const passed = script.runInContext(ctx, { timeout: 100 });
    if (passed === true) console.log("${PASS_MARKER}");
  } catch {}
});
`;

/**
 * Run behavior check in a separate permission-restricted Node process.
 * Returns true only if the child outputs exactly the PASS_MARKER.
 */
function runBehaviorCheckSync(
  jsCode: string,
  funcName: string,
  testCases: TestCase<unknown, unknown>[]
): boolean {
  const stdinData = JSON.stringify({ code: jsCode, funcName, tests: testCases });
  
  try {
    const result = spawnSync(
      process.execPath,
      ["--permission", "--max-old-space-size=64", "-e", WORKER_SCRIPT],
      {
        input: stdinData,
        env: {},
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        stdio: ["pipe", "pipe", "ignore"],
        killSignal: "SIGKILL",
      }
    );

    const stdout = result.stdout?.toString("utf8") ?? "";
    return result.status === 0 && stdout.trim() === PASS_MARKER;
  } catch {
    return false;
  }
}

const CHECK_TEST_CASES: Record<string, { funcName: string; tests: TestCase<unknown, unknown>[] }> = {
  sum_array: {
    funcName: "sumArray",
    tests: [
      { input: [1, 2, 3], expected: 6 },
      { input: [], expected: 0 },
      { input: [5], expected: 5 },
      { input: [-1, 4], expected: 3 },
    ],
  },
  find_max: {
    funcName: "findMax",
    tests: [
      { input: [3, 9, 2], expected: 9 },
      { input: [5], expected: 5 },
      { input: [-3, -1, -7], expected: -1 },
      { input: [2, 2], expected: 2 },
    ],
  },
  greet: {
    funcName: "greet",
    tests: [
      { input: "A", expected: "Hello, A!" },
      { input: "World", expected: "Hello, World!" },
    ],
  },
};

function runFixtureCheck(content: string, checkName: string, wasPatched: boolean): CheckResult {
  if (!wasPatched) {
    return { exitCode: 1, passed: false, message: "check failed" };
  }
  
  const checkConfig = CHECK_TEST_CASES[checkName];
  if (!checkConfig) {
    return { exitCode: 1, passed: false, message: `unknown check: ${checkName}` };
  }
  
  const funcSource = extractFunctionSource(content, checkConfig.funcName);
  if (!funcSource) {
    return { exitCode: 1, passed: false, message: "check failed" };
  }
  
  let jsCode: string;
  try {
    jsCode = transpileToJs(funcSource);
  } catch {
    return { exitCode: 1, passed: false, message: "check failed" };
  }
  
  const passed = runBehaviorCheckSync(jsCode, checkConfig.funcName, checkConfig.tests);
  if (!passed) {
    return { exitCode: 1, passed: false, message: "check failed" };
  }
  
  const token = computeFixedToken(checkName);
  return { exitCode: 0, passed: true, message: "check passed", token };
}

export function createCsvQueryTool(): McpToolSchema & { handler: ToolHandler } {
  return {
    name: "csv_query",
    description: "Query a CSV file (path). Options: filter as column=value, aggregate as sum:column or avg:column or count, select as comma-separated columns.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to CSV file" },
        filter: { type: "string", description: "Filter expression: column=value (optional)" },
        aggregate: { type: "string", description: "Aggregate: sum:column, count, avg:column (optional)" },
        select: { type: "string", description: "Comma-separated columns to return (optional)" },
      },
      required: ["path"],
    },
    handler: (args) => {
      const relativePath = String(args.path ?? "");
      const filter = args.filter ? String(args.filter) : undefined;
      const aggregate = args.aggregate ? String(args.aggregate) : undefined;
      const select = args.select ? String(args.select) : undefined;

      if (!relativePath) {
        return { ok: false, content: "", error: "path is required" };
      }

      const fullPath = resolveFixturePath(relativePath);
      if (!fullPath) {
        return { ok: false, content: "", error: "path traversal rejected" };
      }

      if (!existsSync(fullPath)) {
        return { ok: false, content: "", error: `file not found: ${relativePath}` };
      }

      try {
        const content = readFileSync(fullPath, "utf8");
        const lines = content.trim().split("\n");
        if (lines.length < 2) {
          return { ok: false, content: "", error: "CSV must have header and data rows" };
        }

        const headers = lines[0].split(",").map((h) => h.trim());
        let rows = lines.slice(1).map((line) => {
          const values = line.split(",").map((v) => v.trim());
          const row: Record<string, string> = {};
          headers.forEach((h, i) => {
            row[h] = values[i] ?? "";
          });
          return row;
        });

        if (filter) {
          const trimmed = filter.trim();
          const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
          if (!match) {
            return { ok: false, content: "", error: `invalid filter format: ${filter} (use column=value)` };
          }
          const [, col, rawVal] = match;
          const val = rawVal.trim().replace(/^["']|["']$/g, "").trim();
          const beforeCount = rows.length;
          rows = rows.filter((r) => r[col]?.toLowerCase() === val.toLowerCase());
          if (rows.length === 0 && beforeCount > 0) {
            return { ok: false, content: "", error: `no rows match filter: ${col}=${val}` };
          }
        }

        if (aggregate) {
          if (aggregate === "count") {
            const result = { count: rows.length };
            return { ok: true, content: JSON.stringify(result), data: result };
          }
          
          const sumMatch = aggregate.match(/^sum:(\w+)$/);
          if (sumMatch) {
            const col = sumMatch[1];
            const sum = rows.reduce((acc, r) => acc + parseFloat(r[col] || "0"), 0);
            const result = { sum: Math.round(sum * 100) / 100 };
            return { ok: true, content: JSON.stringify(result), data: result };
          }

          const avgMatch = aggregate.match(/^avg:(\w+)$/);
          if (avgMatch) {
            const col = avgMatch[1];
            const sum = rows.reduce((acc, r) => acc + parseFloat(r[col] || "0"), 0);
            const avg = rows.length > 0 ? sum / rows.length : 0;
            const result = { avg: Math.round(avg * 100) / 100 };
            return { ok: true, content: JSON.stringify(result), data: result };
          }
        }

        if (select) {
          const cols = select.split(",").map((c) => c.trim());
          rows = rows.map((r) => {
            const selected: Record<string, string> = {};
            cols.forEach((c) => {
              if (c in r) selected[c] = r[c];
            });
            return selected;
          });
        }

        return { ok: true, content: JSON.stringify(rows), data: rows };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };
}

export function createFlakySumTool(ctx: ToolsV2Context): McpToolSchema & { handler: ToolHandler } {
  return {
    name: "flaky_sum",
    description: "Compute a + b. May fail transiently on first call; retry on error.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
    handler: (args) => {
      const a = Number(args.a);
      const b = Number(args.b);
      const key = `flaky_sum:${a}:${b}`;
      const count = ctx.errorRecoveryState.errorCounts.get(key) ?? 0;
      
      if (count === 0) {
        ctx.errorRecoveryState.errorCounts.set(key, 1);
        return { ok: false, content: "", error: "service temporarily unavailable, please retry" };
      }
      
      const sum = a + b;
      return { ok: true, content: String(sum), data: { sum } };
    },
  };
}

export function createFlakyLookupTool(ctx: ToolsV2Context): McpToolSchema & { handler: ToolHandler } {
  const data: Record<string, string> = {
    "SKU-100": "Widget Standard",
    "SKU-200": "Widget Premium", 
    "SKU-300": "Widget Enterprise",
  };

  return {
    name: "flaky_lookup",
    description: "Look up product name by sku. May fail transiently on first call; retry on error.",
    inputSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
      },
      required: ["sku"],
    },
    handler: (args) => {
      const sku = String(args.sku);
      const key = `flaky_lookup:${sku}`;
      const count = ctx.errorRecoveryState.errorCounts.get(key) ?? 0;
      
      if (count === 0) {
        ctx.errorRecoveryState.errorCounts.set(key, 1);
        return { ok: false, content: "", error: "connection timeout, please retry" };
      }
      
      const name = data[sku];
      if (!name) {
        return { ok: false, content: "", error: `SKU not found: ${sku}` };
      }
      
      return { ok: true, content: name };
    },
  };
}

/** Enhanced v1 tool descriptions for 0.2.0 (makes arguments discoverable). */
const V1_DESCRIPTION_OVERRIDES: Record<string, string> = {
  echo: "Return the input unchanged (text: string to return).",
  add: "Compute a + b (a and b: numbers).",
  json_get: "Extract a value from JSON (json: JSON string, key: property name).",
  regex_extract: "Extract first capture group (text: input, pattern: regex with one capture).",
  word_count: "Count words (text: string to count).",
};

/** Creates tool options with all 11 tools (5 v1 + 6 v2) for suite 0.2.0. */
export function createToolsV2Options(ctx: ToolsV2Context): InProcessMcpOptions {
  const v1Tools = getDefaultToolDefinitions().map((tool) => ({
    ...tool,
    description: V1_DESCRIPTION_OVERRIDES[tool.name] ?? tool.description,
  }));
  const v2Tools = [
    createReadFileTool(),
    createApplyPatchTool(ctx),
    createRunCheckTool(ctx),
    createCsvQueryTool(),
    createFlakySumTool(ctx),
    createFlakyLookupTool(ctx),
  ];
  return {
    tools: [...v1Tools, ...v2Tools],
  };
}
