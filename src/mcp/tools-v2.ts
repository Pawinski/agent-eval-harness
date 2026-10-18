/**
 * Suite 0.2.0 tools: fixture-backed, no network, no shell, no writes outside memory.
 * Includes all v1 tools (echo, add, json_get, regex_extract, word_count) plus v2 tools.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  transpileModule,
  ModuleKind,
  ScriptTarget,
  createSourceFile,
  ScriptKind,
  SyntaxKind,
  type SourceFile,
  type Node as TSNode,
} from "typescript";
import type { McpToolResult, McpToolSchema, InProcessMcpOptions } from "./client.js";
import { getDefaultToolDefinitions } from "./client.js";

const VERIFICATION_SALT = "v020-check-7f3a9c";
const RESULT_PREFIX = "__RESULTS__:";
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

export interface PermissionCheckDeps {
  nodeVersion?: string;
  spawnProbe?: () => { status: number | null; stdout: string };
}

/**
 * Check if Node's permission model is available.
 * Returns { ok: true } if --permission works, { ok: false, message } otherwise.
 * Accepts optional deps for testing.
 */
export function checkPermissionModelSupport(deps: PermissionCheckDeps = {}): { ok: boolean; message?: string } {
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const [major] = nodeVersion.split(".").map(Number);
  
  if (major < 22) {
    return { ok: false, message: `Node ${nodeVersion} is too old; permission model requires Node >= 22` };
  }

  let probeResult: { status: number | null; stdout: string };
  if (deps.spawnProbe) {
    probeResult = deps.spawnProbe();
  } else {
    const result = spawnSync(process.execPath, ["--permission", "-e", "console.log('ok')"], {
      env: {},
      timeout: 5000,
      encoding: "utf8",
    });
    probeResult = { status: result.status, stdout: result.stdout ?? "" };
  }

  if (probeResult.status !== 0 || !probeResult.stdout.includes("ok")) {
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
 * Validate that extracted code is exactly one function declaration with the expected name.
 * Uses TypeScript parser to ensure no other top-level statements.
 */
function validateSingleFunctionDeclaration(tsCode: string, expectedFuncName: string): boolean {
  try {
    const sourceFile: SourceFile = createSourceFile(
      "check.ts",
      tsCode,
      ScriptTarget.ES2020,
      true,
      ScriptKind.TS
    );

    const topLevelStatements: TSNode[] = [];
    sourceFile.forEachChild((node) => {
      if (node.kind !== SyntaxKind.EndOfFileToken) {
        topLevelStatements.push(node);
      }
    });

    if (topLevelStatements.length !== 1) {
      return false;
    }

    const stmt = topLevelStatements[0];
    if (stmt.kind !== SyntaxKind.FunctionDeclaration) {
      return false;
    }

    const funcDecl = stmt as { name?: { text: string } };
    if (!funcDecl.name || funcDecl.name.text !== expectedFuncName) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Inline worker script for permission-restricted child process.
 * 
 * Protocol:
 * - Input (stdin): JSON { code, funcName, inputs }
 *   - code: the transpiled function source (standalone, no wrapper)
 *   - funcName: name of the function to call
 *   - inputs: array of input values to test
 * - Output (stdout): "__RESULTS__:" + JSON {results, errors}
 * 
 * The child NEVER sees expected values. It only runs the function and returns results.
 * The host compares results against expected values and mints the token.
 * 
 * Uses three separate vm.Script runs:
 * 1. Prelude: deep-freezes all prototypes/constructors, captures a plain-data serializer
 * 2. Patch script: runs the patched function definition in strict mode
 * 3. Call script: invokes the function on each input, stores results as own data properties
 */
const WORKER_SCRIPT = `"use strict";
const vm = require("node:vm");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const { code, funcName, inputs } = JSON.parse(input);
    const ctx = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: "afterEvaluate",
    });
    
    // Step 1: Prelude - deep-freeze prototypes/constructors, capture safe serializer
    // This runs BEFORE any untrusted code to prevent prototype poisoning
    const preludeScript = new vm.Script(\`
      (function() {
        "use strict";
        // Capture primitives before any tampering
        const _Object = Object;
        const _Array = Array;
        const _JSON = JSON;
        const _String = String;
        const _Number = Number;
        const _Boolean = Boolean;
        const _Symbol = Symbol;
        const _Error = Error;
        const _Promise = Promise;
        const _Reflect = Reflect;
        const _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
        const _getOwnPropertyNames = Object.getOwnPropertyNames;
        const _getOwnPropertySymbols = Object.getOwnPropertySymbols;
        const _isArray = Array.isArray;
        const _freeze = Object.freeze;
        const _isFrozen = Object.isFrozen;
        const _getPrototypeOf = Object.getPrototypeOf;
        const _defineProperty = Object.defineProperty;
        const _isFinite = isFinite;
        
        // True deep-freeze all prototypes, constructors, and their reachable properties
        const toFreeze = [
          _Object.prototype, _Array.prototype, Function.prototype,
          _String.prototype, _Number.prototype, _Boolean.prototype,
          _Symbol.prototype, _Error.prototype, _Promise.prototype,
          _JSON, _Object, _Array, _Reflect
        ];
        const stack = [];
        for (let i = 0; i < toFreeze.length; i++) stack[stack.length] = toFreeze[i];
        while (stack.length > 0) {
          const o = stack[stack.length - 1];
          stack.length = stack.length - 1;
          if (o === null || (typeof o !== "object" && typeof o !== "function") || _isFrozen(o)) continue;
          _freeze(o);
          const names = _getOwnPropertyNames(o);
          const syms = _getOwnPropertySymbols(o);
          const keys = [];
          for (let j = 0; j < names.length; j++) keys[keys.length] = names[j];
          for (let j = 0; j < syms.length; j++) keys[keys.length] = syms[j];
          for (let j = 0; j < keys.length; j++) {
            const d = _getOwnPropertyDescriptor(o, keys[j]);
            if (!d) continue;
            if ("value" in d) stack[stack.length] = d.value;
            if (d.get) stack[stack.length] = d.get;
            if (d.set) stack[stack.length] = d.set;
          }
          const p = _getPrototypeOf(o);
          if (p) stack[stack.length] = p;
        }
        
        // Plain-data serializer: handles only string, finite number, boolean, null,
        // arrays and plain objects of those. Rejects accessors, toJSON, functions,
        // symbols, class instances, and non-finite numbers. Proxies are not reliably
        // detectable; results are compared by the host against primitive expected values.
        function safeSerialize(val, seen) {
          if (val === null) return "null";
          const t = typeof val;
          if (t === "string") {
            return _JSON.stringify(val);
          }
          if (t === "number") {
            if (!_isFinite(val)) return null; // reject NaN, Infinity
            return _JSON.stringify(val);
          }
          if (t === "boolean") {
            return val ? "true" : "false";
          }
          if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
            return null; // reject
          }
          if (t !== "object") return null;
          
          // Check for circular references
          if (!seen) seen = [];
          for (let i = 0; i < seen.length; i++) {
            if (seen[i] === val) return null;
          }
          seen[seen.length] = val;
          
          // Reject class instances (prototype not Object.prototype or Array.prototype)
          const proto = _getPrototypeOf(val);
          if (_isArray(val)) {
            if (proto !== _Array.prototype) return null;
            const parts = [];
            const len = val.length;
            for (let i = 0; i < len; i++) {
              const desc = _getOwnPropertyDescriptor(val, i);
              if (!desc) {
                parts[parts.length] = "null"; // sparse slot
              } else if ("get" in desc || "set" in desc) {
                return null; // accessor
              } else {
                const s = safeSerialize(desc.value, seen);
                if (s === null) return null;
                parts[parts.length] = s;
              }
            }
            return "[" + parts.join(",") + "]";
          } else {
            if (proto !== _Object.prototype && proto !== null) return null;
            // Reject if val has toJSON
            const toJSONDesc = _getOwnPropertyDescriptor(val, "toJSON");
            if (toJSONDesc) return null;
            const keys = _getOwnPropertyNames(val);
            const parts = [];
            for (let i = 0; i < keys.length; i++) {
              const k = keys[i];
              if (typeof k !== "string") continue;
              const desc = _getOwnPropertyDescriptor(val, k);
              if (!desc) continue;
              if ("get" in desc || "set" in desc) return null; // accessor
              const s = safeSerialize(desc.value, seen);
              if (s === null) return null;
              parts[parts.length] = _JSON.stringify(k) + ":" + s;
            }
            return "{" + parts.join(",") + "}";
          }
        }
        
        // Export captured functions to global for call script
        globalThis.__safeSerialize = safeSerialize;
        globalThis.__defineProperty = _defineProperty;
      })();
    \`);
    preludeScript.runInContext(ctx, { timeout: 20 });
    
    // Step 2: Run the patched function source in strict mode
    const funcScript = new vm.Script('"use strict";\\n' + code);
    funcScript.runInContext(ctx, { timeout: 50 });
    
    // Step 3: Call script - invoke function on each input
    // Results stored as own data properties (no holes), serialized with safe serializer
    const inputsJson = JSON.stringify(inputs);
    const callScript = new vm.Script(\`
      (function() {
        "use strict";
        const __serialize = globalThis.__safeSerialize;
        const __defProp = globalThis.__defineProperty;
        const __inputs = JSON.parse('\${inputsJson.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'")}');
        const __func = \${funcName};
        if (typeof __func !== "function") {
          return __serialize({ ok: false, error: "not a function" });
        }
        const __out = [];
        for (let __i = 0; __i < __inputs.length; __i++) {
          try {
            const __r = __func(__inputs[__i]);
            __defProp(__out, __i, { value: __r, writable: true, enumerable: true, configurable: true });
          } catch (e) {
            return __serialize({ ok: false, error: "error:" + __i });
          }
        }
        const __serialized = __serialize({ ok: true, results: __out });
        if (__serialized === null) {
          return __serialize({ ok: false, error: "serialize failed" });
        }
        return __serialized;
      })();
    \`);
    const callResultStr = callScript.runInContext(ctx, { timeout: 100 });
    
    // callResultStr must be a string (serialized in-context)
    if (typeof callResultStr !== "string") {
      console.log("${RESULT_PREFIX}" + JSON.stringify({ results: [], errors: ["not a string"] }));
      return;
    }
    
    let parsed;
    try {
      parsed = JSON.parse(callResultStr);
    } catch {
      console.log("${RESULT_PREFIX}" + JSON.stringify({ results: [], errors: ["parse error"] }));
      return;
    }
    
    if (!parsed || !parsed.ok) {
      console.log("${RESULT_PREFIX}" + JSON.stringify({ results: [], errors: [parsed?.error || "unknown"] }));
      return;
    }
    
    // Re-serialize with worker's JSON.stringify (safe from patch overrides)
    console.log("${RESULT_PREFIX}" + JSON.stringify({ results: parsed.results, errors: [] }));
  } catch {}
});
`;

/**
 * Run behavior check in a separate permission-restricted Node process.
 * Child returns results; host compares against expected values.
 */
function runBehaviorCheckSync(
  jsCode: string,
  funcName: string,
  inputs: unknown[],
  expectedOutputs: unknown[]
): boolean {
  const stdinData = JSON.stringify({ code: jsCode, funcName, inputs });
  
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

    if (result.status !== 0) {
      return false;
    }

    const stdout = result.stdout?.toString("utf8") ?? "";
    const trimmed = stdout.trim();
    
    if (!trimmed.startsWith(RESULT_PREFIX)) {
      return false;
    }
    
    const jsonPart = trimmed.slice(RESULT_PREFIX.length);
    let parsed: { results?: unknown[]; errors?: string[] };
    try {
      parsed = JSON.parse(jsonPart);
    } catch {
      return false;
    }
    
    if (!parsed || !Array.isArray(parsed.results)) {
      return false;
    }
    
    if (parsed.errors && parsed.errors.length > 0) {
      return false;
    }
    
    if (parsed.results.length !== expectedOutputs.length) {
      return false;
    }
    
    for (let i = 0; i < expectedOutputs.length; i++) {
      if (!deepEqual(parsed.results[i], expectedOutputs[i])) {
        return false;
      }
    }
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Deep equality comparison for comparing child results to expected values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  
  if (Array.isArray(a) || Array.isArray(b)) return false;
  
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  
  if (aKeys.length !== bKeys.length) return false;
  
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  
  return true;
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
  
  if (!validateSingleFunctionDeclaration(funcSource, checkConfig.funcName)) {
    return { exitCode: 1, passed: false, message: "check failed" };
  }
  
  let jsCode: string;
  try {
    jsCode = transpileToJs(funcSource);
  } catch {
    return { exitCode: 1, passed: false, message: "check failed" };
  }
  
  const inputs = checkConfig.tests.map((t) => t.input);
  const expectedOutputs = checkConfig.tests.map((t) => t.expected);
  
  const passed = runBehaviorCheckSync(jsCode, checkConfig.funcName, inputs, expectedOutputs);
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
