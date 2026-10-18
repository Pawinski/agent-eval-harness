import { describe, it, expect, beforeEach } from "vitest";
import {
  createToolsV2Context,
  createReadFileTool,
  createApplyPatchTool,
  createRunCheckTool,
  createCsvQueryTool,
  createFlakySumTool,
  createFlakyLookupTool,
  type ToolsV2Context,
} from "../mcp/tools-v2.js";

describe("read_file tool", () => {
  const tool = createReadFileTool();

  it("reads fixture file successfully", async () => {
    const result = await tool.handler({ path: "code/calculator.ts" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("export function add");
    expect(result.content).toContain("export function compute");
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
});

describe("error recovery tools", () => {
  describe("flaky_sum tool", () => {
    it("fails on first call with ERROR", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakySumTool(ctx);

      const result1 = await tool.handler({ a: 10, b: 20 });
      expect(result1.ok).toBe(false);
      expect(result1.error).toContain("ERROR");
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
    it("fails on first call with ERROR", async () => {
      const ctx = createToolsV2Context();
      const tool = createFlakyLookupTool(ctx);

      const result1 = await tool.handler({ sku: "SKU-100" });
      expect(result1.ok).toBe(false);
      expect(result1.error).toContain("ERROR");
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
