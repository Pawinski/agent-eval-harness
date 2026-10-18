/**
 * End-to-end gate for task g through the real matrix (production client, scripted fetch):
 * aborted runs are not scored, every task gets a fresh production client, empty or missing
 * supported_parameters means not fetched, temperatureSent per run, /models honours
 * OPENROUTER_BASE_URL with no auth header, and the rate_limited Skipped line label.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const written = vi.hoisted(() => new Map<string, string>());
const created = vi.hoisted(() => [] as object[]);

vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (p: unknown, d: unknown) => { written.set(String(p), String(d)); }),
  };
});

vi.mock("../llm/index.js", async (orig) => {
  const real = await orig<typeof import("../llm/index.js")>();
  return {
    ...real,
    createLlmClient: (...a: Parameters<typeof real.createLlmClient>) => {
      const c = real.createLlmClient(...a);
      created.push(c);
      return c;
    },
  };
});

import { runMain } from "../matrix.js";
import { runMatrix, MatrixLlmClient, summarizeTemperatureSent } from "../matrix/runner.js";
import { fetchModelPricesWithParams } from "../matrix/prices.js";
import { getSuiteTasks, MatrixAbort } from "../matrix/types.js";

const ok = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "Thought: d\nAction: finish\nAction Input: hello" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );
const tiny = (m: string) => ({ modelId: m, promptPrice: 1e-9, completionPrice: 1e-9 });

beforeEach(() => {
  written.clear();
  created.length = 0;
  vi.stubEnv("OPENROUTER_API_KEY", "test-key-not-real");
  vi.stubEnv("OPENROUTER_BASE_URL", "http://mock.invalid/api/v1");
  vi.stubEnv("RETRY_DELAYS_MS", "1,1,1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("g gate: real matrix with scripted fetch", () => {
  it("aborted runs (rate_limited, http_errors) get no scored file, are excluded from pass/mean, and show as not scored", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      if (b.model === "a/a") return new Response("rl", { status: 429 });
      if (b.model === "b/b") return new Response(JSON.stringify({ error: { code: "overloaded" } }), { status: 200 });
      return ok();
    }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const models = ["a/a", "b/b", "c/c", "d/d"];
    const code = await runMain({
      argv: ["--suite", "0.1.0", "--models", models.join(","), "--runs", "2", "--credit-usd", "100", "--cap-usd", "50"],
      env: process.env,
      getGitStatus: () => ({ sha: "0".repeat(40), isDirty: false }),
      skipPricesFetch: true,
      priceData: {
        fetchedAt: "t",
        models: new Map(models.map((m) => [m, tiny(m)])),
        supportedParameters: new Map([["d/d", new Set(["max_tokens"])]]),
        parametersFetched: true,
      } as never,
    });
    expect(code).toBe(0);

    const files = [...written.keys()];
    const scored = (m: string) => files.filter((f) => new RegExp(`[\\\\/]0\\.1\\.0[\\\\/][0-9a-f]{7}-${m}-run\\d\\.json$`).test(f));
    const meta = (m: string) => files.filter((f) => new RegExp(`_meta[\\\\/][0-9a-f]{7}-${m}-run\\d\\.json$`).test(f)).map((f) => JSON.parse(written.get(f)!));
    expect(scored("a__a")).toEqual([]);
    expect(scored("b__b")).toEqual([]);
    expect(scored("c__c").length).toBe(2);
    expect(meta("a__a").map((j) => j.abortReason)).toEqual(["rate_limited"]);
    expect(meta("b__b").map((j) => j.abortReason)).toEqual(["http_errors"]);
    expect(meta("c__c").map((j) => j.temperatureSent)).toEqual([true, true]);
    expect(meta("d__d").map((j) => j.temperatureSent)).toEqual([false, false]);
    expect(meta("c__c").map((j) => j.parametersFetched)).toEqual([false, false]);
    expect(meta("d__d").map((j) => j.parametersFetched)).toEqual([true, true]);

    const summaryPath = files.find((f) => /_summary-[0-9a-f]{7}-.*\.json$/.test(f))!;
    const summary = JSON.parse(written.get(summaryPath)!);
    expect(summary.modelSummaries["a/a"]).toMatchObject({ passes: [], mean: null, spread: null, abortedRuns: 1 });
    expect(summary.modelSummaries["b/b"]).toMatchObject({ passes: [], mean: null, spread: null, abortedRuns: 1 });
    expect(summary.modelSummaries["c/c"]).toMatchObject({ passes: [0, 0], abortedRuns: 0 });
    expect(summary.runs.filter((r: { abort_reason: string | null }) => r.abort_reason).map((r: { model: string; abort_reason: string }) => [r.model, r.abort_reason]))
      .toEqual([["a/a", "rate_limited"], ["b/b", "http_errors"]]);

    const md = written.get(summaryPath.replace(/\.json$/, ".md"))!;
    for (const out of [md, lines.join("\n")]) {
      // Not Empty either: an aborted task is not an empty answer.
      expect(out).toContain("| a/a | 1 | not scored (rate_limited) | 0 | 0 | - | $0.000000 | - | rate_limited | - |");
      expect(out).toContain("| b/b | 1 | not scored (http_errors) |");
      expect(out).toMatch(/\| c\/c \| 1 \| 0\/7 \|.*\| - \| yes \|/);
      expect(out).toMatch(/\| d\/d \| 1 \| 0\/7 \|.*\| - \| no \|/);
      expect(out).toMatch(/\| a\/a \| - \| - \| - \|/);
    }
    const skipped = lines.find((l) => l.includes("(skipped: rate_limited)"));
    expect(skipped).toMatch(/worst case \$\d+\.\d{4}, cap \$50\.0000, retries 3$/);
  });

  it("the production client factory makes one fresh client per model x run x task", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const models = ["a/a", "b/b"];
    await runMatrix(
      { suite: "0.1.0", models, runs: 2, capUsd: 100, fixture: false },
      { fetchedAt: "t", models: new Map(models.map((m) => [m, tiny(m)])) },
      { skipFileWrites: true },
    );
    const n = models.length * 2 * getSuiteTasks("0.1.0").length;
    expect(created.length).toBe(n);
    expect(new Set(created).size).toBe(n);
  });

  it("empty or missing supported_parameters: not fetched, model left out of the filter", async () => {
    const pricing = { prompt: "0.000001", completion: "0.000002" };
    const reply = (data: unknown[]) => vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
    vi.stubGlobal("fetch", reply([{ id: "a/a", pricing, supported_parameters: [] }, { id: "b/b", pricing }]));
    const none = await fetchModelPricesWithParams(["a/a", "b/b"], "http://mock.invalid/api/v1/models");
    expect(none.parametersFetched).toBe(false);
    expect(none.supportedParameters.size).toBe(0);

    vi.stubGlobal("fetch", reply([{ id: "a/a", pricing, supported_parameters: [] }, { id: "c/c", pricing, supported_parameters: ["temperature"] }]));
    const mixed = await fetchModelPricesWithParams(["a/a", "c/c"], "http://mock.invalid/api/v1/models");
    expect(mixed.parametersFetched).toBe(true);
    expect([...mixed.supportedParameters.keys()]).toEqual(["c/c"]);
  });

  it("matrix /models uses OPENROUTER_BASE_URL and sends no auth header", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runMain({
      argv: ["--suite", "0.1.0", "--models", "a/a", "--runs", "1", "--credit-usd", "1"],
      env: { OPENROUTER_API_KEY: "test-key-not-real", OPENROUTER_BASE_URL: "http://mock.invalid/custom/v1/" },
      getGitStatus: () => ({ sha: "0".repeat(40), isDirty: false }),
      skipFileWrites: true,
    });
    expect(code).toBe(1); // no pricing for a/a in the empty list
    expect(seen.map((s) => s.url)).toEqual(["http://mock.invalid/custom/v1/models"]);
    expect(JSON.stringify(seen[0].init?.headers ?? {})).not.toMatch(/authorization/i);
  });

  it("global_cap aborted run gets no scored file, only _meta with abortReason, excluded from pass/mean", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    let budgetCheckCount = 0;
    vi.spyOn(MatrixLlmClient.prototype, "checkBudget").mockImplementation(function () {
      budgetCheckCount++;
      if (budgetCheckCount === 4) {
        throw new MatrixAbort("global_cap", "cap exceeded");
      }
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const models = ["nex-agi/nex", "openai/4o-mini"];
    const code = await runMain({
      argv: ["--suite", "0.1.0", "--models", models.join(","), "--runs", "1", "--credit-usd", "100", "--cap-usd", "50"],
      env: process.env,
      getGitStatus: () => ({ sha: "0".repeat(40), isDirty: false }),
      skipPricesFetch: true,
      priceData: {
        fetchedAt: "t",
        models: new Map(models.map((m) => [m, tiny(m)])),
      } as never,
    });
    expect(code).toBe(1);

    const files = [...written.keys()];
    const scoredNex = files.filter((f) => /[\\/]0\.1\.0[\\/][0-9a-f]{7}-nex-agi__nex-run\d\.json$/.test(f));
    const metaNex = files.filter((f) => /_meta[\\/][0-9a-f]{7}-nex-agi__nex-run\d\.json$/.test(f)).map((f) => JSON.parse(written.get(f)!));
    expect(scoredNex).toEqual([]);
    expect(metaNex.length).toBe(1);
    expect(metaNex[0].abortReason).toBe("global_cap");

    const summaryPath = files.find((f) => /_summary-[0-9a-f]{7}-.*\.json$/.test(f))!;
    const summary = JSON.parse(written.get(summaryPath)!);
    expect(summary.modelSummaries["nex-agi/nex"]).toMatchObject({ passes: [], mean: null, spread: null, abortedRuns: 1 });
    expect(summary.runs.find((r: { model: string }) => r.model === "nex-agi/nex").abort_reason).toBe("global_cap");

    const output = lines.join("\n");
    expect(output).toContain("| nex-agi/nex | 1 | not scored (global_cap) |");
    expect(output).toContain("GLOBAL CAP REACHED");
  });

  it("mixed temperatureSent: some calls sent temperature, some did not", async () => {
    const calls = [
      { taskId: "t1", step: 1, usage: { promptTokens: 1, completionTokens: 1, cachedTokens: null, costUsd: 0 }, empty: false, httpError: false, temperatureSent: true },
      { taskId: "t2", step: 1, usage: { promptTokens: 1, completionTokens: 1, cachedTokens: null, costUsd: 0 }, empty: false, httpError: false, temperatureSent: false },
      { taskId: "t3", step: 1, usage: { promptTokens: 1, completionTokens: 1, cachedTokens: null, costUsd: 0 }, empty: false, httpError: false, temperatureSent: true },
    ];
    expect(summarizeTemperatureSent(calls)).toBe("mixed");
    expect(summarizeTemperatureSent([calls[0], calls[2]])).toBe(true);
    expect(summarizeTemperatureSent([calls[1]])).toBe(false);
    expect(summarizeTemperatureSent([])).toBe(null);
  });

  it("mixed temperatureSent end-to-end: different supported_parameters per model in same matrix", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const models = ["a/a", "b/b"];
    const { runs } = await runMatrix(
      { suite: "0.1.0", models, runs: 1, capUsd: 100, fixture: false },
      {
        fetchedAt: "t",
        models: new Map(models.map((m) => [m, tiny(m)])),
        supportedParameters: new Map([["b/b", new Set(["max_tokens"])]]),
        parametersFetched: true,
      } as never,
      { skipFileWrites: true },
    );
    expect(runs[0].temperatureSent).toBe(true);
    expect(runs[1].temperatureSent).toBe(false);
  });

  it("invalid RETRY_DELAYS_MS (empty piece) exits 1 with clear error naming the variable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
    const code = await runMain({
      argv: ["--suite", "0.1.0", "--models", "a/a", "--runs", "1", "--credit-usd", "1"],
      env: { OPENROUTER_API_KEY: "test-key-not-real", RETRY_DELAYS_MS: "1,,2" },
      getGitStatus: () => ({ sha: "0".repeat(40), isDirty: false }),
      skipPricesFetch: true,
      priceData: { fetchedAt: "t", models: new Map([["a/a", tiny("a/a")]]) } as never,
      skipFileWrites: true,
    });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes("RETRY_DELAYS_MS") && e.includes("invalid"))).toBe(true);
  });

  it("invalid RETRY_DELAYS_MS (non-numeric) exits 1 with clear error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
    const code = await runMain({
      argv: ["--suite", "0.1.0", "--models", "a/a", "--runs", "1", "--credit-usd", "1"],
      env: { OPENROUTER_API_KEY: "test-key-not-real", RETRY_DELAYS_MS: "abc,def" },
      getGitStatus: () => ({ sha: "0".repeat(40), isDirty: false }),
      skipPricesFetch: true,
      priceData: { fetchedAt: "t", models: new Map([["a/a", tiny("a/a")]]) } as never,
      skipFileWrites: true,
    });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes("RETRY_DELAYS_MS") && e.includes("invalid"))).toBe(true);
  });

  it("invalid RETRY_DELAYS_MS (negative) exits 1 with clear error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
    const code = await runMain({
      argv: ["--suite", "0.1.0", "--models", "a/a", "--runs", "1", "--credit-usd", "1"],
      env: { OPENROUTER_API_KEY: "test-key-not-real", RETRY_DELAYS_MS: "1000,-500,2000" },
      getGitStatus: () => ({ sha: "0".repeat(40), isDirty: false }),
      skipPricesFetch: true,
      priceData: { fetchedAt: "t", models: new Map([["a/a", tiny("a/a")]]) } as never,
      skipFileWrites: true,
    });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes("RETRY_DELAYS_MS") && e.includes("invalid"))).toBe(true);
  });
});
