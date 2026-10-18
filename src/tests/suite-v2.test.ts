import { describe, it, expect } from "vitest";
import { TASKS_V2 } from "../suite/tasks-v2.js";
import { runCheck } from "../suite/checkers.js";
import {
  getSuiteTasks,
  SUITE_CONFIGS,
  getDefaultCapUsd,
  getDefaultIMax,
} from "../matrix/types.js";
import { runMatrix, createFixturePrices } from "../matrix/index.js";

describe("suite 0.2.0 configuration", () => {
  it("SUITE_CONFIGS includes 0.2.0", () => {
    const config = SUITE_CONFIGS["0.2.0"];
    expect(config).toBeDefined();
    expect(config.version).toBe("0.2.0");
    expect(config.taskCount).toBe(16);
    expect(config.maxSteps).toBe(12);
    expect(config.maxInputTokens).toBe(4700);
    expect(config.defaultCapUsd).toBe(35.0);
  });

  it("getDefaultCapUsd returns $35 for 0.2.0", () => {
    expect(getDefaultCapUsd("0.2.0")).toBe(35.0);
  });

  it("getDefaultIMax returns 4700 for 0.2.0 with maxSteps 12", () => {
    expect(getDefaultIMax("0.2.0", 12)).toBe(4700);
  });

  it("getSuiteTasks returns 16 tasks for 0.2.0", () => {
    const tasks = getSuiteTasks("0.2.0");
    expect(tasks.length).toBe(16);
  });
});

describe("suite 0.2.0 fixture answers", () => {
  it("all 16 fixture answers pass their checks", () => {
    for (const task of TASKS_V2) {
      const result = runCheck(task.fixtureAnswer ?? "", 0, task.check);
      expect(result.pass).toBe(true);
    }
  });

  it("fixture answers are non-empty", () => {
    for (const task of TASKS_V2) {
      expect(task.fixtureAnswer).toBeDefined();
      expect(task.fixtureAnswer!.trim().length).toBeGreaterThan(0);
    }
  });

  it("patch tasks use exact token match", () => {
    const patchTasks = TASKS_V2.filter((t) => t.category === "patch");
    expect(patchTasks.length).toBe(3);
    
    for (const task of patchTasks) {
      expect(runCheck("fixed", 0, task.check).pass).toBe(false);
      expect(runCheck("Fixed", 0, task.check).pass).toBe(false);
      expect(task.fixtureAnswer).toMatch(/^[0-9a-f]{8}$/);
      expect(runCheck(task.fixtureAnswer!, 0, task.check).pass).toBe(true);
    }
  });
});

describe("suite 0.2.0 task metadata", () => {
  it("all tasks have deterministic checks", () => {
    const allowedKinds = ["exact", "json_equal", "regex", "contains"];
    for (const task of TASKS_V2) {
      expect(allowedKinds).toContain(task.check.kind);
    }
  });

  it("all tasks have maxSteps between 6 and 12", () => {
    for (const task of TASKS_V2) {
      const steps = task.maxSteps ?? 8;
      expect(steps).toBeGreaterThanOrEqual(6);
      expect(steps).toBeLessThanOrEqual(12);
    }
  });

  it("tool selection tasks have undefined expectedTools", () => {
    const selectionTasks = TASKS_V2.filter((t) => t.category === "selection");
    expect(selectionTasks.length).toBe(3);
    for (const task of selectionTasks) {
      expect(task.expectedTools).toBeUndefined();
    }
  });
});

describe("suite 0.2.0 matrix fixture", () => {
  it("fixture mode scores 16/16 for all models", async () => {
    const models = ["test/model-a", "test/model-b"];
    const priceData = createFixturePrices(models);

    const { runs, globalAbort } = await runMatrix(
      { suite: "0.2.0", models, runs: 1, capUsd: 100, fixture: true },
      priceData,
      { skipFileWrites: true },
    );

    expect(globalAbort).toBe(false);
    expect(runs.length).toBe(2);
    
    for (const run of runs) {
      expect(run.pass).toBe(16);
      expect(run.total).toBe(16);
      expect(run.costUsd).toBe(0);
    }
  });

  it("fixture mode produces zero cost", async () => {
    const models = ["test/model"];
    const priceData = createFixturePrices(models);

    const { runs } = await runMatrix(
      { suite: "0.2.0", models, runs: 3, capUsd: 100, fixture: true },
      priceData,
      { skipFileWrites: true },
    );

    const totalCost = runs.reduce((sum, r) => sum + r.costUsd, 0);
    expect(totalCost).toBe(0);
  });
});

describe("suite 0.1.0 config preserved", () => {
  it("SUITE_CONFIGS 0.1.0 unchanged (for historical results)", () => {
    const config = SUITE_CONFIGS["0.1.0"];
    expect(config.version).toBe("0.1.0");
    expect(config.taskCount).toBe(7);
    expect(config.maxSteps).toBe(8);
    expect(config.maxInputTokens).toBe(3000);
    expect(config.defaultCapUsd).toBe(10.0);
  });
});

describe("task fixture tool call counts", () => {
  it("documents expected tool calls per task", () => {
    const expectedCalls: Record<string, number> = {
      chain_json_regex_add: 3,
      chain_word_count_multiply: 2,
      chain_extract_sum: 3,
      select_echo_tool: 1,
      select_add_tool: 1,
      select_json_tool: 1,
      code_compute_result: 1,
      code_find_throw: 1,
      code_validate_email: 1,
      patch_sum_array: 3,
      patch_find_max: 3,
      patch_greet: 3,
      data_inventory_sum: 1,
      data_weather_avg: 1,
      error_recovery_sum: 2,
      error_recovery_lookup: 2,
    };

    expect(Object.keys(expectedCalls).length).toBe(16);
    
    for (const [_id, calls] of Object.entries(expectedCalls)) {
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(calls).toBeLessThanOrEqual(8);
    }
  });
});
