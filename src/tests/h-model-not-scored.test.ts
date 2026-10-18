/**
 * Task h: a model with any aborted run is not scored at model level. Mean and spread are
 * null in the JSON summary, "-" in the .md and console tables, and the status reads
 * "not scored (<abort reason>)". Scored per-run rows stay on record.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const written = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (p: unknown, d: unknown) => { written.set(String(p), String(d)); }),
  };
});

import { writeSummaryFiles, printSummaryToConsole } from "../matrix.js";
import type { RunResult, AbortReason } from "../matrix/types.js";

const run = (model: string, runN: number, pass: number, abortReason?: AbortReason): RunResult => ({
  model, runN, pass, total: 16, tokensIn: 10, tokensOut: 2, tokensCached: 0, costUsd: 0.001,
  abortReason, emptyTasks: [], emptyCount: 0, calls: [], retries: 0, parametersFetched: true, temperatureSent: true,
});

const runs: RunResult[] = [
  run("m/ok", 1, 16), run("m/ok", 2, 15),
  run("m/mix", 1, 15), run("m/mix", 2, 1, "rate_limited"),
  run("m/two", 1, 0, "http_errors"), run("m/two", 2, 0, "rate_limited"),
];

beforeEach(() => written.clear());
afterEach(() => vi.restoreAllMocks());

describe("h: any aborted run makes the model not scored", () => {
  it("JSON and .md summaries: null mean/spread and 'not scored (<reason>)' for a model with a scored and an aborted run", async () => {
    const { jsonPath, mdPath } = await writeSummaryFiles(runs, "0.2.0", { fetchedAt: "t", models: new Map() } as never, 35, false, 16, true);
    const json = JSON.parse(written.get(jsonPath)!);
    // The partial model keeps its scored pass on record but gets no model-level score.
    expect(json.modelSummaries["m/mix"]).toMatchObject({ passes: [15], mean: null, spread: null, abortedRuns: 1 });
    expect(json.modelSummaries["m/two"]).toMatchObject({ passes: [], mean: null, spread: null, abortedRuns: 2 });
    expect(json.modelSummaries["m/ok"]).toMatchObject({ passes: [16, 15], mean: 15.5, spread: 1, abortedRuns: 0 });
    // Per-run rows are unchanged: the scored run 1 is still there with its pass.
    expect(json.runs.filter((r: { model: string }) => r.model === "m/mix").map((r: { pass: number; abort_reason: string | null }) => [r.pass, r.abort_reason]))
      .toEqual([[15, null], [1, "rate_limited"]]);

    const md = written.get(mdPath)!;
    expect(md).toContain("| m/mix | 15/16 | - | - | $0.002000 | not scored (rate_limited) |");
    expect(md).toContain("| m/two | - | - | - | $0.002000 | not scored (http_errors, rate_limited) |");
    expect(md).toContain("| m/ok | 16/16, 15/16 | 15.50 | 1 | $0.002000 | - |");
    expect(md).toContain("| m/mix | 1 | 15/16 |");
    expect(md).toContain("| m/mix | 2 | not scored (rate_limited) |");
  });

  it("repeated abort reasons are listed once: two rate_limited aborts read exactly 'not scored (rate_limited)'", async () => {
    const twice = [run("m/rl", 1, 0, "rate_limited"), run("m/rl", 2, 0, "rate_limited"), run("m/rl", 3, 16)];
    const { jsonPath, mdPath } = await writeSummaryFiles(twice, "0.2.0", { fetchedAt: "t", models: new Map() } as never, 35, false, 16, true);
    expect(JSON.parse(written.get(jsonPath)!).modelSummaries["m/rl"]).toMatchObject({ passes: [16], mean: null, spread: null, abortedRuns: 2 });
    const row = written.get(mdPath)!.split("\n").find((l) => l.startsWith("| m/rl | 16/16 |"));
    expect(row).toBe("| m/rl | 16/16 | - | - | $0.003000 | not scored (rate_limited) |");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    printSummaryToConsole(twice, "0.2.0", 35, 16);
    expect(lines.find((l) => l.startsWith("| m/rl | 16/16 |"))).toContain("| not scored (rate_limited) |");
  });

  it("console per-model summary uses the same rule", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    printSummaryToConsole(runs, "0.2.0", 35, 16);
    const out = lines.join("\n");
    expect(out).toContain("| m/mix | 15/16 | - | - | 20 | 4 | 0 | 0 | $0.002000 | not scored (rate_limited) | yes |");
    expect(out).toContain("| m/ok | 16/16, 15/16 | 15.50 | 1 | 20 | 4 | 0 | 0 | $0.002000 | - | yes |");
  });
});
