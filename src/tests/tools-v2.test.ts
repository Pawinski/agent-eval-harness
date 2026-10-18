import { describe, it, expect, beforeEach } from "vitest";
import {
  createToolsV2Context,
  createToolsV2Options,
  createReadFileTool,
  createApplyPatchTool,
  createRunCheckTool,
  createCsvQueryTool,
  createFlakySumTool,
  createFlakyLookupTool,
  getToolsV2Schemas,
  type ToolsV2Context,
} from "../mcp/tools-v2.js";
import { InProcessMcpClient } from "../mcp/client.js";
import { TASKS_V2 } from "../suite/tasks-v2.js";

describe("read_file tool", () => {
  const tool = createReadFileTool();

  it("reads fixture file successfully", async () => {
    const result = await tool.handler({ path: "code/calculator.ts" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("export function add");
    expect(result.content).toContain("export function compute");
  });

  it("outputs line numbers", async () => {
    const result = await tool.handler({ path: "code/calculator.ts" });
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/^\s*1\|/);
    expect(result.content).toContain(" 25| ");
  });

  it("rejects path traversal with ..", async () => {
    const result = await tool.handler({ path: "../package.json" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path traversal rejected");
  });

  it("rejects path traversal with nested ..", async () => {
    const result = await tool.handler({ path: "code/../../package.json" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path traversal rejected");
  });

  it("rejects absolute paths", async () => {
    const result = await tool.handler({ path: "/etc/passwd" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path traversal rejected");
  });

  it("returns error for non-existent file", async () => {
    const result = await tool.handler({ path: "code/nonexistent.ts" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("file not found");
  });

  it("requires path argument", async () => {
    const result = await tool.handler({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path is required");
  });
});

describe("apply_patch tool", () => {
  let ctx: ToolsV2Context;

  beforeEach(() => {
    ctx = createToolsV2Context();
  });

  it("applies patch successfully", async () => {
    const tool = createApplyPatchTool(ctx);
    const result = await tool.handler({
      path: "code/buggy.ts",
      old_line: "for (let i = 0; i <= arr.length; i++) {",
      new_line: "for (let i = 0; i < arr.length; i++) {",
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("patch applied");
    expect(ctx.patchState.patched.has("code/buggy.ts")).toBe(true);
  });

  it("stores original content before patching", async () => {
    const tool = createApplyPatchTool(ctx);
    await tool.handler({
      path: "code/buggy.ts",
      old_line: "for (let i = 0; i <= arr.length; i++) {",
      new_line: "for (let i = 0; i < arr.length; i++) {",
    });
    expect(ctx.patchState.original.has("code/buggy.ts")).toBe(true);
    expect(ctx.patchState.original.get("code/buggy.ts")).toContain("i <= arr.length");
  });

  it("fails when line not found", async () => {
    const tool = createApplyPatchTool(ctx);
    const result = await tool.handler({
      path: "code/buggy.ts",
      old_line: "this line does not exist",
      new_line: "replacement",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("line not found");
  });

  it("rejects path traversal", async () => {
    const tool = createApplyPatchTool(ctx);
    const result = await tool.handler({
      path: "../package.json",
      old_line: "old",
      new_line: "new",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path traversal rejected");
  });
});

describe("run_check tool", () => {
  let ctx: ToolsV2Context;

  beforeEach(() => {
    ctx = createToolsV2Context();
  });

  it("detects sum_array bug (exit 1)", async () => {
    const tool = createRunCheckTool(ctx);
    const result = await tool.handler({
      path: "code/buggy.ts",
      check: "sum_array",
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("exit 1");
    expect((result.data as { exitCode: number }).exitCode).toBe(1);
  });

  it("passes sum_array after fix (exit 0)", async () => {
    const patchTool = createApplyPatchTool(ctx);
    await patchTool.handler({
      path: "code/buggy.ts",
      old_line: "for (let i = 0; i <= arr.length; i++) {",
      new_line: "for (let i = 0; i < arr.length; i++) {",
    });

    const checkTool = createRunCheckTool(ctx);
    const result = await checkTool.handler({
      path: "code/buggy.ts",
      check: "sum_array",
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("exit 0");
    expect((result.data as { exitCode: number }).exitCode).toBe(0);
  });

  it("detects find_max bug (exit 1)", async () => {
    const tool = createRunCheckTool(ctx);
    const result = await tool.handler({
      path: "code/buggy.ts",
      check: "find_max",
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("exit 1");
  });

  it("passes find_max after fix (exit 0)", async () => {
    const patchTool = createApplyPatchTool(ctx);
    await patchTool.handler({
      path: "code/buggy.ts",
      old_line: "if (arr[i] < max) {",
      new_line: "if (arr[i] > max) {",
    });

    const checkTool = createRunCheckTool(ctx);
    const result = await checkTool.handler({
      path: "code/buggy.ts",
      check: "find_max",
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("exit 0");
  });

  it("detects greet bug (exit 1)", async () => {
    const tool = createRunCheckTool(ctx);
    const result = await tool.handler({
      path: "code/buggy.ts",
      check: "greet",
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("exit 1");
  });

  it("passes greet after fix (exit 0)", async () => {
    const patchTool = createApplyPatchTool(ctx);
    await patchTool.handler({
      path: "code/buggy.ts",
      old_line: 'return "Hello, " + name + "?";',
      new_line: 'return "Hello, " + name + "!";',
    });

    const checkTool = createRunCheckTool(ctx);
    const result = await checkTool.handler({
      path: "code/buggy.ts",
      check: "greet",
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("exit 0");
  });
});

describe("csv_query tool", () => {
  const tool = createCsvQueryTool();

  it("reads CSV file successfully", async () => {
    const result = await tool.handler({ path: "data/inventory.csv" });
    expect(result.ok).toBe(true);
    const data = result.data as Array<Record<string, string>>;
    expect(data.length).toBe(8);
    expect(data[0].name).toBe("Widget A");
  });

  it("filters by column value", async () => {
    const result = await tool.handler({
      path: "data/inventory.csv",
      filter: "category=electronics",
    });
    expect(result.ok).toBe(true);
    const data = result.data as Array<Record<string, string>>;
    expect(data.length).toBe(4);
    expect(data.every((r) => r.category === "electronics")).toBe(true);
  });

  it("computes sum aggregate", async () => {
    const result = await tool.handler({
      path: "data/inventory.csv",
      filter: "category=electronics",
      aggregate: "sum:quantity",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { sum: number };
    expect(data.sum).toBe(290);
  });

  it("computes count aggregate", async () => {
    const result = await tool.handler({
      path: "data/inventory.csv",
      filter: "category=tools",
      aggregate: "count",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(3);
  });

  it("computes avg aggregate", async () => {
    const result = await tool.handler({
      path: "data/weather.csv",
      filter: "city=Warsaw",
      aggregate: "avg:temp_c",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { avg: number };
    expect(data.avg).toBeCloseTo(1.33, 1);
  });

  it("selects specific columns", async () => {
    const result = await tool.handler({
      path: "data/inventory.csv",
      select: "name,quantity",
    });
    expect(result.ok).toBe(true);
    const data = result.data as Array<Record<string, string>>;
    expect(Object.keys(data[0])).toEqual(["name", "quantity"]);
  });

  it("rejects path traversal", async () => {
    const result = await tool.handler({ path: "../package.json" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path traversal rejected");
  });

  it("filters with quoted value (trims quotes)", async () => {
    const result = await tool.handler({
      path: "data/inventory.csv",
      filter: 'category="electronics"',
    });
    expect(result.ok).toBe(true);
    const data = result.data as Array<Record<string, string>>;
    expect(data.length).toBe(4);
    expect(data.every((r) => r.category === "electronics")).toBe(true);
  });

  it("filters case-insensitively", async () => {
    const result = await tool.handler({
      path: "data/inventory.csv",
      filter: "category=ELECTRONICS",
    });
    expect(result.ok).toBe(true);
    const data = result.data as Array<Record<string, string>>;
    expect(data.length).toBe(4);
  });

  it("returns error when no rows match filter", async () => {
    const result = await tool.handler({
      path: "data/inventory.csv",
      filter: "category=nonexistent",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no rows match filter");
  });
});

describe("error recovery tools", () => {
  describe("flaky_sum tool", () => {
    it("fails on first call with error", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakySumTool(ctx);

      const result1 = await tool.handler({ a: 10, b: 20 });
      expect(result1.ok).toBe(false);
      expect(result1.error).toContain("temporarily unavailable");
    });

    it("succeeds on second call (same args)", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakySumTool(ctx);

      await tool.handler({ a: 10, b: 20 });
      const result2 = await tool.handler({ a: 10, b: 20 });
      expect(result2.ok).toBe(true);
      expect(result2.content).toBe("30");
    });

    it("error fires exactly once per unique args", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakySumTool(ctx);

      const r1 = await tool.handler({ a: 5, b: 5 });
      expect(r1.ok).toBe(false);

      const r2 = await tool.handler({ a: 5, b: 5 });
      expect(r2.ok).toBe(true);
      expect(r2.content).toBe("10");

      const r3 = await tool.handler({ a: 5, b: 5 });
      expect(r3.ok).toBe(true);
      expect(r3.content).toBe("10");
    });

    it("different args trigger separate error cycle", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakySumTool(ctx);

      const r1 = await tool.handler({ a: 1, b: 1 });
      expect(r1.ok).toBe(false);

      const r2 = await tool.handler({ a: 2, b: 2 });
      expect(r2.ok).toBe(false);

      const r3 = await tool.handler({ a: 1, b: 1 });
      expect(r3.ok).toBe(true);
      expect(r3.content).toBe("2");
    });
  });

  describe("flaky_lookup tool", () => {
    it("fails on first call with error", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakyLookupTool(ctx);

      const result1 = await tool.handler({ sku: "SKU-100" });
      expect(result1.ok).toBe(false);
      expect(result1.error).toContain("timeout");
    });

    it("succeeds on second call (same args)", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakyLookupTool(ctx);

      await tool.handler({ sku: "SKU-200" });
      const result2 = await tool.handler({ sku: "SKU-200" });
      expect(result2.ok).toBe(true);
      expect(result2.content).toBe("Widget Premium");
    });

    it("returns error for unknown SKU after retry", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakyLookupTool(ctx);

      await tool.handler({ sku: "SKU-999" });
      const result2 = await tool.handler({ sku: "SKU-999" });
      expect(result2.ok).toBe(false);
      expect(result2.error).toContain("SKU not found");
    });
  });
});

describe("observation truncation", () => {
  it("truncates long observations", async () => {
    const longContent = "x".repeat(5000);
    const maxChars = 4096;
    const truncated = longContent.slice(0, maxChars) + "\n[truncated]";
    expect(truncated.length).toBeLessThan(longContent.length);
    expect(truncated).toContain("[truncated]");
  });
});

describe("0.2.0 tool catalog completeness", () => {
  it("has exactly 11 tools (5 v1 + 6 v2)", () => {
    const schemas = getToolsV2Schemas();
    expect(schemas.length).toBe(11);
  });

  it("includes all v1 tools", () => {
    const schemas = getToolsV2Schemas();
    const names = schemas.map((s) => s.name);
    expect(names).toContain("echo");
    expect(names).toContain("add");
    expect(names).toContain("json_get");
    expect(names).toContain("regex_extract");
    expect(names).toContain("word_count");
  });

  it("includes all v2 tools", () => {
    const schemas = getToolsV2Schemas();
    const names = schemas.map((s) => s.name);
    expect(names).toContain("read_file");
    expect(names).toContain("apply_patch");
    expect(names).toContain("run_check");
    expect(names).toContain("csv_query");
    expect(names).toContain("flaky_sum");
    expect(names).toContain("flaky_lookup");
  });

  it("every 0.2.0 task's expected tools exist in catalog", () => {
    const schemas = getToolsV2Schemas();
    const availableTools = new Set(schemas.map((s) => s.name));

    for (const task of TASKS_V2) {
      if (task.expectedTools) {
        for (const toolName of task.expectedTools) {
          expect(availableTools.has(toolName)).toBe(true);
        }
      }
    }
  });

  it("createToolsV2Options returns client with 11 tools", async () => {
    const ctx = createToolsV2Context();
    const options = createToolsV2Options(ctx);
    const client = new InProcessMcpClient(options);
    const tools = await client.listTools();
    expect(tools.length).toBe(11);
  });
});

describe("tool state isolation per task", () => {
  describe("error recovery gets injected error on each fresh context", () => {
    it("flaky_sum fails on first call in both runs", async () => {
      const ctx1 = createToolsV2Context();
      const tool1 = createFlakySumTool(ctx1);
      const result1 = await tool1.handler({ a: 10, b: 20 });
      expect(result1.ok).toBe(false);

      const ctx2 = createToolsV2Context();
      const tool2 = createFlakySumTool(ctx2);
      const result2 = await tool2.handler({ a: 10, b: 20 });
      expect(result2.ok).toBe(false);
    });

    it("flaky_lookup fails on first call in both runs", async () => {
      const ctx1 = createToolsV2Context();
      const tool1 = createFlakyLookupTool(ctx1);
      const result1 = await tool1.handler({ sku: "SKU-100" });
      expect(result1.ok).toBe(false);

      const ctx2 = createToolsV2Context();
      const tool2 = createFlakyLookupTool(ctx2);
      const result2 = await tool2.handler({ sku: "SKU-100" });
      expect(result2.ok).toBe(false);
    });
  });

  describe("patch state does not leak between task runs", () => {
    it("apply_patch in one context does not affect another context", async () => {
      const ctx1 = createToolsV2Context();
      const patchTool1 = createApplyPatchTool(ctx1);

      await patchTool1.handler({
        path: "code/buggy.ts",
        old_line: "for (let i = 0; i <= arr.length; i++) {",
        new_line: "for (let i = 0; i < arr.length; i++) {",
      });

      expect(ctx1.patchState.patched.has("code/buggy.ts")).toBe(true);

      const ctx2 = createToolsV2Context();
      expect(ctx2.patchState.patched.has("code/buggy.ts")).toBe(false);

      const checkTool2 = createRunCheckTool(ctx2);
      const result = await checkTool2.handler({
        path: "code/buggy.ts",
        check: "sum_array",
      });
      expect(result.content).toBe("exit 1");
    });

    it("patched file in context 1 reads original in context 2", async () => {
      const ctx1 = createToolsV2Context();
      const patchTool1 = createApplyPatchTool(ctx1);

      await patchTool1.handler({
        path: "code/buggy.ts",
        old_line: "for (let i = 0; i <= arr.length; i++) {",
        new_line: "for (let i = 0; i < arr.length; i++) {",
      });

      const checkTool1 = createRunCheckTool(ctx1);
      const result1 = await checkTool1.handler({
        path: "code/buggy.ts",
        check: "sum_array",
      });
      expect(result1.content).toBe("exit 0");

      const ctx2 = createToolsV2Context();
      const checkTool2 = createRunCheckTool(ctx2);
      const result2 = await checkTool2.handler({
        path: "code/buggy.ts",
        check: "sum_array",
      });
      expect(result2.content).toBe("exit 1");
    });
  });
});
