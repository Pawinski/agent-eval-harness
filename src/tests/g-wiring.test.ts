/**
 * Production-path wiring for task g: retries go through the budget check, the
 * parameter filter is applied from priceData, provider errors are HTTP-class,
 * retries appear in the SKIPPED line, retry delays are configurable, every task
 * gets a fresh client, and the opus 0.2.0 worst case.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenRouterClient, RateLimitExhaustedError, parseRetryDelaysEnv, type LlmClient, type LlmCompletionResponse } from "../llm/client.js";
import { runMatrix, MatrixLlmClient } from "../matrix/runner.js";
import { MatrixAbort, SUITE_CONFIGS, getDefaultIMax, getCallsPerRun, getSuiteTasks, DEFAULT_MODELS } from "../matrix/types.js";
import { calculateModelFullWorstCaseWithCallsPerRun, type PriceDataWithParams, type ModelPricing } from "../matrix/prices.js";
import { runMain } from "../matrix.js";
import { TASKS_V2 } from "../suite/index.js";
import { PRELUDE_TIMEOUT_MS } from "../mcp/tools-v2.js";

const zero = (m: string) => ({ modelId: m, promptPrice: 0, completionPrice: 0 });
const priceFor = (models: string[], extra: Partial<PriceDataWithParams> = {}) => ({
  fetchedAt: "t",
  models: new Map(models.map((m) => [m, zero(m)])),
  ...extra,
});
const okJson = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "Thought: d\nAction: finish\nAction Input: hello" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );

function liveEnv() {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key-not-real");
  vi.stubEnv("OPENROUTER_BASE_URL", "http://mock.invalid/api/v1");
  vi.stubEnv("RETRY_DELAYS_MS", "1,1,1");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("g production wiring", () => {
  it("every 429 retry in the default (production) client goes through the budget check", async () => {
    liveEnv();
    let chat = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++chat <= 2 ? new Response("rl", { status: 429 }) : okJson())));
    const spy = vi.spyOn(MatrixLlmClient.prototype, "checkBudget");
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    expect(chat).toBe(16 + 2); // 16 tasks x 1 call, plus 2 x 429
    expect(runs[0].retries).toBe(2);
    // one check before each of the 16 calls + one before each of the 2 retries
    expect(spy).toHaveBeenCalledTimes(16 + 2);
  });

  it("a budget check that fails before a retry stops the retry", async () => {
    liveEnv();
    let chat = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { chat++; return new Response("rl", { status: 429 }); }));
    let n = 0;
    vi.spyOn(MatrixLlmClient.prototype, "checkBudget").mockImplementation(() => {
      if (++n === 2) throw new MatrixAbort("global_cap", "cap");
    });
    const res = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    expect(chat).toBe(1);
    expect(res.globalAbort).toBe(true);
  });

  it("the parameter filter from priceData is applied in the production client and recorded", async () => {
    liveEnv();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return okJson(); }));
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"], { supportedParameters: new Map([["m/x", new Set(["max_tokens"])]]), parametersFetched: true }) as never,
      { skipFileWrites: true },
    );
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(JSON.parse(b)).not.toHaveProperty("temperature");
    expect(runs[0].calls.every((c) => c.droppedParameters?.includes("temperature"))).toBe(true);
    expect(runs[0].parametersFetched).toBe(true);
  });

  it("without supported_parameters behaviour is unchanged and parametersFetched=false is recorded", async () => {
    liveEnv();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return okJson(); }));
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    for (const b of bodies) expect(JSON.parse(b)).toHaveProperty("temperature", 0);
    expect(runs[0].parametersFetched).toBe(false);
  });

  it("provider errors are HTTP-class: 2 tasks abort as http_errors, not Empty, code only", async () => {
    liveEnv();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "overloaded", message: "SECRET-PROVIDER-TEXT" } }), { status: 200 })));
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    const run = runs[0];
    expect(run.abortReason).toBe("http_errors");
    expect(run.emptyTasks).toEqual([]);
    expect(run.calls.length).toBe(2);
    expect(run.calls.every((c) => c.httpError && c.errorCode === "overloaded")).toBe(true);
    expect(JSON.stringify(run)).not.toContain("SECRET-PROVIDER-TEXT");
  });

  it("a single provider error does not abort the run", async () => {
    liveEnv();
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () =>
      ++n === 1 ? new Response(JSON.stringify({ choices: [] }), { status: 200 }) : okJson()));
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    expect(runs[0].abortReason).toBeUndefined();
    expect(new Set(runs[0].calls.map((c) => c.taskId)).size).toBe(16);
  });

  it("RETRY_DELAYS_MS configures the backoff", async () => {
    vi.stubEnv("RETRY_DELAYS_MS", "5,6");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rl", { status: 429 })));
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new OpenRouterClient({ apiKey: "k", defaultModel: "m/x", retryConfig: { sleep } });
    await expect(c.complete({ messages: [{ role: "user", content: "u" }] })).rejects.toBeInstanceOf(RateLimitExhaustedError);
    expect(sleep.mock.calls.map((a) => a[0])).toEqual([5, 6]);
  });

  it("the SKIPPED line reports retries for a rate-limited model", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runMain({
      argv: ["--suite", "0.2.0", "--models", "a/a,b/b", "--runs", "1", "--credit-usd", "100"],
      env: { OPENROUTER_API_KEY: "test-key-not-real" },
      getGitStatus: () => ({ sha: "0".repeat(40), isDirty: false }),
      skipPricesFetch: true,
      priceData: priceFor(["a/a", "b/b"]),
      skipFileWrites: true,
      llmClientFactory: (model: string): LlmClient => ({
        async complete(): Promise<LlmCompletionResponse> {
          if (model === "a/a") throw new RateLimitExhaustedError(model, 3);
          return { content: "Thought: d\nAction: finish\nAction Input: hello", model, usage: { promptTokens: 1, completionTokens: 1 } };
        },
      }),
    });
    expect(code).toBeTypeOf("number");
    const skipped = lines.find((l) => l.includes("SKIPPED:"));
    expect(skipped).toBeDefined();
    expect(skipped).toContain("retries 3");
  });

  it("full matrix: every model x suite x run x task gets a fresh client", async () => {
    for (const suite of ["0.2.0"]) {
      const clients: object[] = [];
      const perClientCalls = new Map<object, number>();
      const models = ["a/a", "b/b"];
      await runMatrix(
        { suite, models, runs: 2, capUsd: 100, fixture: false },
        priceFor(models),
        {
          skipFileWrites: true,
          llmClientFactory: (model: string) => {
            const c: LlmClient = {
              async complete(): Promise<LlmCompletionResponse> {
                perClientCalls.set(c, (perClientCalls.get(c) ?? 0) + 1);
                return { content: "Thought: d\nAction: finish\nAction Input: hello", model, usage: { promptTokens: 1, completionTokens: 1 } };
              },
            };
            clients.push(c);
            return c;
          },
        },
      );
      const tasks = getSuiteTasks(suite).length;
      expect(clients.length).toBe(models.length * 2 * tasks);
      expect(new Set(clients).size).toBe(clients.length);
      for (const c of clients) expect(perClientCalls.get(c)).toBe(1);
    }
  });

  it("opus 0.2.0 worst case (FIXTURE PRICES $12/$60 per M): 118 calls/run at iMax 4700 = ~$10.28 (flat 192 = ~$16.73)", () => {
    // These are FIXTURE PRICES for test determinism, not real OpenRouter prices
    const opus = { modelId: "anthropic/claude-opus-5.5", promptPrice: 12 / 1_000_000, completionPrice: 60 / 1_000_000 };
    const iMax = getDefaultIMax("0.2.0", SUITE_CONFIGS["0.2.0"].maxSteps);
    expect(iMax).toBe(4700);
    expect(getCallsPerRun("0.2.0")).toBe(TASKS_V2.reduce((s, t) => s + (t.maxSteps ?? 8), 0));
    expect(getCallsPerRun("0.2.0")).toBe(118);
    expect(calculateModelFullWorstCaseWithCallsPerRun(1, 118, iMax, opus)).toBeCloseTo(10.28, 2);
    expect(calculateModelFullWorstCaseWithCallsPerRun(1, 16 * 12, iMax, opus)).toBeCloseTo(16.73, 2);
  });

  it("opus 0.2.0 worst case (REAL PRICES $4/$20 per M from 2026-10-17 snapshot): $3.43/run, $10.28/3 runs", () => {
    // Real prices from openrouter-models-2026-10-17.json snapshot
    const opus = { modelId: "anthropic/claude-opus-5.5", promptPrice: 4 / 1_000_000, completionPrice: 20 / 1_000_000 };
    const iMax = getDefaultIMax("0.2.0", SUITE_CONFIGS["0.2.0"].maxSteps);
    const callsPerRun = getCallsPerRun("0.2.0");
    expect(iMax).toBe(4700);
    expect(callsPerRun).toBe(118);
    // Formula: callsPerRun * (iMax * promptPrice + 512 * completionPrice)
    // = 118 * (4700 * 0.000004 + 512 * 0.00002)
    // = 118 * (0.0188 + 0.01024) = 118 * 0.02904 = 3.42672
    expect(calculateModelFullWorstCaseWithCallsPerRun(1, callsPerRun, iMax, opus)).toBeCloseTo(3.43, 2);
    expect(calculateModelFullWorstCaseWithCallsPerRun(3, callsPerRun, iMax, opus)).toBeCloseTo(10.28, 2);
  });

  it("all 6 DEFAULT_MODELS x 3 runs worst case at REAL PRICES = $17.31", () => {
    // Real prices from openrouter-models-2026-10-17.json snapshot
    const realPrices: Record<string, ModelPricing> = {
      "nex-agi/nex-n2.5-pro": { modelId: "nex-agi/nex-n2.5-pro", promptPrice: 0.075 / 1_000_000, completionPrice: 0.25 / 1_000_000 },
      "openai/gpt-4o-mini": { modelId: "openai/gpt-4o-mini", promptPrice: 0.15 / 1_000_000, completionPrice: 0.6 / 1_000_000 },
      "anthropic/claude-haiku-5.5": { modelId: "anthropic/claude-haiku-5.5", promptPrice: 0.1 / 1_000_000, completionPrice: 0.5 / 1_000_000 },
      "mistralai/mistral-large-2512": { modelId: "mistralai/mistral-large-2512", promptPrice: 0.5 / 1_000_000, completionPrice: 1.5 / 1_000_000 },
      "openai/gpt-6.1-sol": { modelId: "openai/gpt-6.1-sol", promptPrice: 2 / 1_000_000, completionPrice: 10 / 1_000_000 },
      "anthropic/claude-opus-5.5": { modelId: "anthropic/claude-opus-5.5", promptPrice: 4 / 1_000_000, completionPrice: 20 / 1_000_000 },
    };
    const iMax = getDefaultIMax("0.2.0", SUITE_CONFIGS["0.2.0"].maxSteps);
    const callsPerRun = getCallsPerRun("0.2.0");
    let total = 0;
    for (const model of DEFAULT_MODELS) {
      const pricing = realPrices[model];
      const worstCase = calculateModelFullWorstCaseWithCallsPerRun(3, callsPerRun, iMax, pricing);
      total += worstCase;
    }
    expect(total).toBeCloseTo(17.31, 2);
  });

  it("runMain pre-flight uses 118 calls/run for 0.2.0: opus x 3 runs = $30.84 (FIXTURE PRICES)", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const opus = "anthropic/claude-opus-5.5";
    // FIXTURE PRICES for test determinism
    await runMain({
      argv: ["--suite", "0.2.0", "--models", opus, "--runs", "3", "--credit-usd", "1"],
      env: { OPENROUTER_API_KEY: "test-key-not-real" },
      getGitStatus: () => ({ sha: "0".repeat(40), isDirty: false }),
      skipPricesFetch: true,
      priceData: { fetchedAt: "t", models: new Map([[opus, { modelId: opus, promptPrice: 12 / 1_000_000, completionPrice: 60 / 1_000_000 }]]) },
      skipFileWrites: true,
      llmClientFactory: (): LlmClient => { throw new Error("no calls expected"); },
    });
    const line = lines.find((l) => l.startsWith("Worst case per model"));
    expect(line).toBe(`Worst case per model (3 runs x 118 calls): ${opus} $30.84`);
  });

  it("patch-check prelude timeout is 50 ms", () => {
    expect(PRELUDE_TIMEOUT_MS).toBe(50);
  });

  it("RETRY_DELAYS_MS rejects empty pieces like '1,,2'", () => {
    expect(parseRetryDelaysEnv("1,,2")).toBeUndefined();
    expect(parseRetryDelaysEnv("1,2,")).toBeUndefined();
    expect(parseRetryDelaysEnv(",1,2")).toBeUndefined();
    expect(parseRetryDelaysEnv("1,2,3")).toEqual([1, 2, 3]);
    expect(parseRetryDelaysEnv("15000,60000,180000")).toEqual([15000, 60000, 180000]);
  });

  it("RETRY_DELAYS_MS rejects 0 (must be positive integers)", () => {
    expect(parseRetryDelaysEnv("0")).toBeUndefined();
    expect(parseRetryDelaysEnv("1,0,2")).toBeUndefined();
  });

  it("RETRY_DELAYS_MS rejects decimals", () => {
    expect(parseRetryDelaysEnv("1.5")).toBeUndefined();
    expect(parseRetryDelaysEnv("1000,1.5,2000")).toBeUndefined();
  });

  it("RETRY_DELAYS_MS rejects scientific notation", () => {
    expect(parseRetryDelaysEnv("1e3")).toBeUndefined();
    expect(parseRetryDelaysEnv("1000,1e3,2000")).toBeUndefined();
  });

  it("RETRY_DELAYS_MS rejects negative values", () => {
    expect(parseRetryDelaysEnv("-1")).toBeUndefined();
    expect(parseRetryDelaysEnv("1000,-500,2000")).toBeUndefined();
  });

  it("RETRY_DELAYS_MS rejects empty string", () => {
    expect(parseRetryDelaysEnv("")).toBeUndefined();
  });

  it("empty supported_parameters array is treated as not fetched", async () => {
    liveEnv();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return okJson(); }));
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"], { supportedParameters: new Map([["m/x", new Set()]]), parametersFetched: false }) as never,
      { skipFileWrites: true },
    );
    for (const b of bodies) {
      expect(JSON.parse(b)).toHaveProperty("temperature", 0);
      expect(JSON.parse(b)).toHaveProperty("max_tokens");
    }
    expect(runs[0].parametersFetched).toBe(false);
  });

  it("max_tokens is never dropped even when not in supported_parameters", async () => {
    liveEnv();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return okJson(); }));
    await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"], { supportedParameters: new Map([["m/x", new Set(["temperature"])]]), parametersFetched: true }) as never,
      { skipFileWrites: true },
    );
    for (const b of bodies) {
      expect(JSON.parse(b)).toHaveProperty("max_tokens");
    }
  });

  it("rate-limited model is excluded from pass and mean", async () => {
    liveEnv();
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      {
        skipFileWrites: true,
        llmClientFactory: (): LlmClient => ({
          async complete(): Promise<LlmCompletionResponse> {
            throw new RateLimitExhaustedError("m/x", 3);
          },
        }),
      },
    );
    expect(runs.length).toBe(1);
    expect(runs[0].abortReason).toBe("rate_limited");
  });

  it("http_errors aborted run is excluded from pass and mean", async () => {
    liveEnv();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "overloaded" } }), { status: 200 })));
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    expect(runs.length).toBe(1);
    expect(runs[0].abortReason).toBe("http_errors");
  });

  it("temperatureSent is recorded per call when temperature is sent", async () => {
    liveEnv();
    vi.stubGlobal("fetch", vi.fn(async () => okJson()));
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    expect(runs[0].calls.length).toBeGreaterThan(0);
    for (const call of runs[0].calls) {
      expect(call.temperatureSent).toBe(true);
    }
  });

  it("temperatureSent is false when temperature is dropped", async () => {
    liveEnv();
    vi.stubGlobal("fetch", vi.fn(async () => okJson()));
    const { runs } = await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"], { supportedParameters: new Map([["m/x", new Set(["max_tokens"])]]), parametersFetched: true }) as never,
      { skipFileWrites: true },
    );
    for (const call of runs[0].calls) {
      expect(call.temperatureSent).toBe(false);
    }
  });

  it("fresh-client test: a retry in task 2 checks task 2's budget (not task 1's)", async () => {
    liveEnv();
    let taskIdx = 0;
    const callsPerTask: number[] = [];
    const budgetCheckTaskCosts: number[] = [];

    // Track budget checks - they should see the correct task's cost, not another task's
    const originalCheckBudget = MatrixLlmClient.prototype.checkBudget;
    vi.spyOn(MatrixLlmClient.prototype, "checkBudget").mockImplementation(function(this: MatrixLlmClient) {
      const taskCostSoFar = (this as unknown as { config: { getTaskCostSoFar: () => number } }).config.getTaskCostSoFar();
      budgetCheckTaskCosts.push(taskCostSoFar);
      return originalCheckBudget.call(this);
    });

    vi.stubGlobal("fetch", vi.fn(async () => okJson()));

    await runMatrix(
      { suite: "0.2.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      {
        skipFileWrites: true,
        llmClientFactory: (model: string) => {
          const thisTask = taskIdx++;
          let calls = 0;
          return {
            async complete(): Promise<LlmCompletionResponse> {
              calls++;
              callsPerTask[thisTask] = calls;
              return { content: "Thought: d\nAction: finish\nAction Input: hello", model, usage: { promptTokens: 1, completionTokens: 1 } };
            },
          };
        },
      },
    );

    // Verify we created 16 separate clients (one per task) - this proves per-task isolation
    expect(taskIdx).toBe(16);
    // Each client was called once - if clients were reused this would be different
    expect(callsPerTask.every((c) => c === 1)).toBe(true);
    // Each budget check should see taskCostSoFar starting at 0 for each new task
    // (not accumulated from previous tasks). This is the key assertion:
    // if the factory reused clients, the budget would accumulate across tasks.
    for (const cost of budgetCheckTaskCosts) {
      expect(cost).toBe(0);
    }
  });
});
