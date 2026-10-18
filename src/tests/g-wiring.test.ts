/**
 * Production-path wiring for task g: retries go through the budget check, the
 * parameter filter is applied from priceData, provider errors are HTTP-class,
 * retries appear in the SKIPPED line, retry delays are configurable, every task
 * gets a fresh client, and the opus 0.2.0 worst case.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenRouterClient, RateLimitExhaustedError, type LlmClient, type LlmCompletionResponse } from "../llm/client.js";
import { runMatrix, MatrixLlmClient } from "../matrix/runner.js";
import { MatrixAbort, SUITE_CONFIGS, getDefaultIMax, getCallsPerRun, getSuiteTasks } from "../matrix/types.js";
import { calculateModelFullWorstCaseWithCallsPerRun, type PriceDataWithParams } from "../matrix/prices.js";
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
      { suite: "0.1.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    expect(chat).toBe(7 + 2); // 7 tasks x 1 call, plus 2 x 429
    expect(runs[0].retries).toBe(2);
    // one check before each of the 7 calls + one before each of the 2 retries
    expect(spy).toHaveBeenCalledTimes(7 + 2);
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
      { suite: "0.1.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
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
      { suite: "0.1.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
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
      { suite: "0.1.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
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
      { suite: "0.1.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
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
      { suite: "0.1.0", models: ["m/x"], runs: 1, capUsd: 100, fixture: false },
      priceFor(["m/x"]),
      { skipFileWrites: true },
    );
    expect(runs[0].abortReason).toBeUndefined();
    expect(new Set(runs[0].calls.map((c) => c.taskId)).size).toBe(7);
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
      argv: ["--suite", "0.1.0", "--models", "a/a,b/b", "--runs", "1", "--credit-usd", "100"],
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
    for (const suite of ["0.1.0", "0.2.0"]) {
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

  it("opus 0.2.0 worst case: 118 calls/run at iMax 4700 = ~$10.28 (flat 192 = ~$16.73)", () => {
    const opus = { modelId: "anthropic/claude-opus-5.5", promptPrice: 12 / 1_000_000, completionPrice: 60 / 1_000_000 };
    const iMax = getDefaultIMax("0.2.0", SUITE_CONFIGS["0.2.0"].maxSteps);
    expect(iMax).toBe(4700);
    expect(getCallsPerRun("0.2.0")).toBe(TASKS_V2.reduce((s, t) => s + (t.maxSteps ?? 8), 0));
    expect(getCallsPerRun("0.2.0")).toBe(118);
    expect(calculateModelFullWorstCaseWithCallsPerRun(1, 118, iMax, opus)).toBeCloseTo(10.28, 2);
    expect(calculateModelFullWorstCaseWithCallsPerRun(1, 16 * 12, iMax, opus)).toBeCloseTo(16.73, 2);
  });

  it("patch-check prelude timeout is 50 ms", () => {
    expect(PRELUDE_TIMEOUT_MS).toBe(50);
  });
});
