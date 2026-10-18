/**
 * Suite 0.2.0 tools: fixture-backed, no network, no shell, no writes outside memory.
 * Includes all v1 tools (echo, add, json_get, regex_extract, word_count) plus v2 tools.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpToolResult, McpToolSchema, InProcessMcpOptions } from "./client.js";
import { getDefaultToolDefinitions } from "./client.js";

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
    description: "Read a fixture file by relative path (e.g. code/calculator.ts). Returns file contents.",
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
        return { ok: true, content };
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
    description: "Apply a unified diff patch to a fixture file in memory. Use old_line and new_line for single-line replacement.",
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
      const oldLine = String(args.old_line ?? "");
      const newLine = String(args.new_line ?? "");

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
    description: "Run a fixture check on a patched file. Returns exit code 0 on success, 1 on failure.",
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

      let content: string;
      if (ctx.patchState.patched.has(relativePath)) {
        content = ctx.patchState.patched.get(relativePath)!;
      } else {
        const fullPath = resolveFixturePath(relativePath);
        if (!fullPath || !existsSync(fullPath)) {
          return { ok: false, content: "", error: `file not found: ${relativePath}` };
        }
        content = readFileSync(fullPath, "utf8");
      }

      const result = runFixtureCheck(content, checkName);
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
}

function runFixtureCheck(content: string, checkName: string): CheckResult {
  switch (checkName) {
    case "sum_array": {
      const hasBug = content.includes("i <= arr.length");
      if (hasBug) {
        return { exitCode: 1, passed: false, message: "sumArray has off-by-one bug" };
      }
      return { exitCode: 0, passed: true, message: "sumArray check passed" };
    }
    case "find_max": {
      const hasBug = content.includes("arr[i] < max");
      if (hasBug) {
        return { exitCode: 1, passed: false, message: "findMax comparison is inverted" };
      }
      return { exitCode: 0, passed: true, message: "findMax check passed" };
    }
    case "greet": {
      const hasBug = content.includes('+ "?"');
      if (hasBug) {
        return { exitCode: 1, passed: false, message: "greet uses wrong punctuation" };
      }
      return { exitCode: 0, passed: true, message: "greet check passed" };
    }
    default:
      return { exitCode: 1, passed: false, message: `unknown check: ${checkName}` };
  }
}

export function createCsvQueryTool(): McpToolSchema & { handler: ToolHandler } {
  return {
    name: "csv_query",
    description: "Query a CSV fixture file. Supports filter (column=value) and aggregate (sum:column, count, avg:column).",
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
          const match = filter.match(/^(\w+)\s*=\s*(.+)$/);
          if (match) {
            const [, col, val] = match;
            rows = rows.filter((r) => r[col] === val);
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

export function createErrorRecoveryTool(
  ctx: ToolsV2Context,
  toolName: string,
  successHandler: ToolHandler,
): McpToolSchema & { handler: ToolHandler } {
  return {
    name: toolName,
    description: `Tool that fails once with ERROR on first call, then succeeds. Used for error recovery testing.`,
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string" },
      },
      required: ["input"],
    },
    handler: (args) => {
      const key = `${toolName}:${JSON.stringify(args)}`;
      const count = ctx.errorRecoveryState.errorCounts.get(key) ?? 0;
      
      if (count === 0) {
        ctx.errorRecoveryState.errorCounts.set(key, 1);
        return { ok: false, content: "", error: "ERROR: temporary failure, retry with same input" };
      }
      
      return successHandler(args);
    },
  };
}

export function createFlakySumTool(ctx: ToolsV2Context): McpToolSchema & { handler: ToolHandler } {
  return {
    name: "flaky_sum",
    description: "Sum two numbers. May fail on first attempt - retry on error.",
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
        return { ok: false, content: "", error: "ERROR: service temporarily unavailable, please retry" };
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
    description: "Look up a product name by SKU. May fail on first attempt - retry on error.",
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
        return { ok: false, content: "", error: "ERROR: connection timeout, please retry" };
      }
      
      const name = data[sku];
      if (!name) {
        return { ok: false, content: "", error: `SKU not found: ${sku}` };
      }
      
      return { ok: true, content: name };
    },
  };
}

/** Returns schemas for all 11 tools available in suite 0.2.0 (5 v1 + 6 v2). */
export function getToolsV2Schemas(): McpToolSchema[] {
  const v1Schemas = getDefaultToolDefinitions().map(({ handler: _h, ...schema }) => schema);
  const v2Schemas: McpToolSchema[] = [
    { name: "read_file", description: "Read a fixture file by relative path (e.g. code/calculator.ts). Returns file contents.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "apply_patch", description: "Apply a unified diff patch to a fixture file in memory. Use old_line and new_line for single-line replacement.", inputSchema: { type: "object", properties: { path: { type: "string" }, old_line: { type: "string" }, new_line: { type: "string" } }, required: ["path", "old_line", "new_line"] } },
    { name: "run_check", description: "Run a fixture check on a patched file. Returns exit code 0 on success, 1 on failure.", inputSchema: { type: "object", properties: { path: { type: "string" }, check: { type: "string" } }, required: ["path", "check"] } },
    { name: "csv_query", description: "Query a CSV fixture file. Supports filter (column=value) and aggregate (sum:column, count, avg:column).", inputSchema: { type: "object", properties: { path: { type: "string" }, filter: { type: "string" }, aggregate: { type: "string" }, select: { type: "string" } }, required: ["path"] } },
    { name: "flaky_sum", description: "Sum two numbers. May fail on first attempt - retry on error.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
    { name: "flaky_lookup", description: "Look up a product name by SKU. May fail on first attempt - retry on error.", inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } },
  ];
  return [...v1Schemas, ...v2Schemas];
}

/** Creates tool options with all 11 tools (5 v1 + 6 v2) for suite 0.2.0. */
export function createToolsV2Options(ctx: ToolsV2Context): InProcessMcpOptions {
  const v1Tools = getDefaultToolDefinitions();
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
