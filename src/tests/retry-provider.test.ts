/**
 * Tests for 429 retry logic, provider errors, and parameter filtering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpenRouterClient,
  ProviderError,
  RateLimitExhaustedError,
  DEFAULT_RETRY_DELAYS,
  type LlmCompletionResponse,
} from "../llm/client.js";
import {
  runMatrix,
  getCallsPerRun,
  calculateModelFullWorstCaseWithCallsPerRun,
  type PriceData,
  type ModelPricing,
  type LlmClientFactory,
} from "../matrix/index.js";

describe("429 retry logic", () => {
  let originalFetch: typeof fetch;
  let fetchCallCount: number;
  let sleepCalls: number[];

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchCallCount = 0;
    sleepCalls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("retries on 429 then succeeds", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return new Response("Rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "success" } }],
        model: "test-model",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
      retryConfig: {
        delays: [0, 0, 0],
        sleep: async (ms) => { sleepCalls.push(ms); },
      },
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.content).toBe("success");
    expect(fetchCallCount).toBe(2);
    expect(result._meta?.retries).toBe(1);
    expect(sleepCalls).toEqual([0]);
  });

  it("retries with correct backoff delays", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response("Rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "success" } }],
        model: "test-model",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    });

    const customDelays = [100, 200, 300];
    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
      retryConfig: {
        delays: customDelays,
        sleep: async (ms) => { sleepCalls.push(ms); },
      },
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.content).toBe("success");
    expect(result._meta?.retries).toBe(2);
    expect(sleepCalls).toEqual([100, 200]);
  });

  it("throws RateLimitExhaustedError after all retries fail", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response("Rate limited", { status: 429 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
      retryConfig: {
        delays: [0, 0, 0],
        sleep: async () => {},
      },
    });

    await expect(client.complete({
      messages: [{ role: "user", content: "test" }],
    })).rejects.toThrow(RateLimitExhaustedError);

    try {
      await client.complete({ messages: [{ role: "user", content: "test" }] });
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitExhaustedError);
      expect((err as RateLimitExhaustedError).retries).toBe(3);
      expect((err as RateLimitExhaustedError).model).toBe("test/model");
    }
  });

  it("uses default retry delays (15s, 60s, 180s)", () => {
    expect(DEFAULT_RETRY_DELAYS).toEqual([15_000, 60_000, 180_000]);
  });

  it("does not retry on 5xx errors", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      return new Response("Server error", { status: 500 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
      retryConfig: {
        delays: [0, 0, 0],
        sleep: async (ms) => { sleepCalls.push(ms); },
      },
    });

    await expect(client.complete({
      messages: [{ role: "user", content: "test" }],
    })).rejects.toThrow("HTTP 500");

    expect(fetchCallCount).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  it("calls preRetryCheck before each retry", async () => {
    let preRetryCheckCalls = 0;
    let callCount = 0;

    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response("Rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "success" } }],
        model: "test-model",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
      retryConfig: {
        delays: [0, 0, 0],
        sleep: async () => {},
        preRetryCheck: async () => { preRetryCheckCalls++; },
      },
    });

    await client.complete({ messages: [{ role: "user", content: "test" }] });

    expect(preRetryCheckCalls).toBe(2);
  });

  it("aborts retry when preRetryCheck throws", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response("Rate limited", { status: 429 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
      retryConfig: {
        delays: [0, 0, 0],
        sleep: async () => {},
        preRetryCheck: async () => { throw new Error("Budget exceeded"); },
      },
    });

    await expect(client.complete({
      messages: [{ role: "user", content: "test" }],
    })).rejects.toThrow("Budget exceeded");
  });
});

describe("provider errors", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws ProviderError on 200 with error object", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        error: { code: "rate_limit_exceeded", type: "rate_limit" },
      }), { status: 200 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
    });

    try {
      await client.complete({ messages: [{ role: "user", content: "test" }] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.code).toBe("rate_limit_exceeded");
      expect(pe.type).toBe("rate_limit");
    }
  });

  it("throws ProviderError on empty choices", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [],
        model: "test-model",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
    });

    try {
      await client.complete({ messages: [{ role: "user", content: "test" }] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("empty_choices");
    }
  });

  it("throws ProviderError on missing usage", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "test" } }],
        model: "test-model",
      }), { status: 200 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
    });

    try {
      await client.complete({ messages: [{ role: "user", content: "test" }] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("missing_usage");
    }
  });

  it("records only code/type, not message body", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        error: {
          code: "context_length_exceeded",
          type: "invalid_request_error",
          message: "This prompt contains sensitive information that should not be logged",
        },
      }), { status: 200 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
    });

    try {
      await client.complete({ messages: [{ role: "user", content: "test" }] });
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.code).toBe("context_length_exceeded");
      expect(pe.type).toBe("invalid_request_error");
      expect(pe.message).not.toContain("sensitive");
    }
  });
});

describe("parameter filtering", () => {
  let originalFetch: typeof fetch;
  let capturedBody: string;

  beforeEach(() => {
    originalFetch = global.fetch;
    capturedBody = "";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("filters unsupported parameters and records dropped ones", async () => {
    const droppedParams: string[][] = [];

    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "success" } }],
        model: "test-model",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    });

    const supportedParams = new Map<string, Set<string>>([
      ["test/model", new Set(["temperature"])],
    ]);

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
      supportedParameters: supportedParams,
      onDroppedParameters: (model, dropped) => {
        droppedParams.push([model, ...dropped]);
      },
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "test" }],
      temperature: 0.5,
      maxTokens: 100,
    });

    const body = JSON.parse(capturedBody);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBeUndefined();
    expect(body.model).toBe("test/model");
    expect(body.messages).toBeDefined();

    expect(result._meta?.droppedParameters).toContain("max_tokens");
    expect(droppedParams[0]).toContain("max_tokens");
  });

  it("keeps all parameters when model not in supported list", async () => {
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "success" } }],
        model: "other/model",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    });

    const supportedParams = new Map<string, Set<string>>([
      ["test/model", new Set(["temperature"])],
    ]);

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "other/model",
      supportedParameters: supportedParams,
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "test" }],
      temperature: 0.5,
      maxTokens: 100,
    });

    const body = JSON.parse(capturedBody);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    expect(result._meta?.droppedParameters).toBeUndefined();
  });

  it("keeps parameters when no supported list provided (fallback behavior)", async () => {
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "success" } }],
        model: "test-model",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    });

    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "test" }],
      temperature: 0.5,
      maxTokens: 100,
    });

    const body = JSON.parse(capturedBody);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    expect(result._meta?.droppedParameters).toBeUndefined();
  });
});

describe("matrix integration with retries", () => {
  const testPricing: ModelPricing = {
    modelId: "test/model",
    promptPrice: 0,
    completionPrice: 0,
  };

  const testPriceData: PriceData = {
    fetchedAt: new Date().toISOString(),
    models: new Map([["test/model", testPricing], ["test/model2", testPricing]]),
  };

  it("four 429s then skip, matrix continues to next model", async () => {
    let model1Calls = 0;
    let model2Calls = 0;

    const llmClientFactory: LlmClientFactory = (model) => ({
      async complete(): Promise<LlmCompletionResponse> {
        if (model === "test/model") {
          model1Calls++;
          throw new RateLimitExhaustedError(model, 3);
        }
        model2Calls++;
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model,
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    });

    const { runs, skippedModels } = await runMatrix(
      { suite: "0.1.0", models: ["test/model", "test/model2"], runs: 1, capUsd: 100, fixture: false },
      testPriceData,
      { llmClientFactory, skipFileWrites: true },
    );

    expect(model1Calls).toBe(1);
    expect(model2Calls).toBeGreaterThan(0);
    
    const skippedModel1 = skippedModels.find(s => s.model === "test/model");
    expect(skippedModel1).toBeDefined();
    expect(skippedModel1?.reason).toBe("rate_limited");
    expect(skippedModel1?.retries).toBe(3);

    const model2Run = runs.find(r => r.model === "test/model2");
    expect(model2Run).toBeDefined();
  });

  it("mixed 429 and 5xx: 429 success after retry, 5xx counts as http error", async () => {
    let taskIdx = 0;

    const llmClientFactory: LlmClientFactory = (model) => {
      let callCount = 0;
      return {
        async complete(): Promise<LlmCompletionResponse> {
          callCount++;
          if (taskIdx === 0) {
            taskIdx++;
            return {
              content: "Thought: done\nAction: finish\nAction Input: hello",
              model,
              usage: { promptTokens: 100, completionTokens: 50 },
              _meta: { retries: 2 },
            };
          }
          if (taskIdx === 1) {
            taskIdx++;
            throw new Error("HTTP 500 Server Error");
          }
          return {
            content: "Thought: done\nAction: finish\nAction Input: hello",
            model,
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        },
      };
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      testPriceData,
      { llmClientFactory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.retries).toBeGreaterThan(0);
    
    const httpErrorCalls = run.calls.filter(c => c.httpError);
    expect(httpErrorCalls.length).toBe(1);
    expect(httpErrorCalls[0].httpStatus).toBe(500);
  });

  it("success after retry does NOT count toward http error abort", async () => {
    let taskIdx = 0;

    const llmClientFactory: LlmClientFactory = (model) => ({
      async complete(): Promise<LlmCompletionResponse> {
        taskIdx++;
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model,
          usage: { promptTokens: 100, completionTokens: 50 },
          _meta: { retries: 2 },
        };
      },
    });

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      testPriceData,
      { llmClientFactory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.abortReason).toBeUndefined();
    expect(run.retries).toBeGreaterThan(0);
  });

  it("records retries per call in _meta", async () => {
    const llmClientFactory: LlmClientFactory = (model) => {
      let callNum = 0;
      return {
        async complete(): Promise<LlmCompletionResponse> {
          callNum++;
          return {
            content: "Thought: done\nAction: finish\nAction Input: hello",
            model,
            usage: { promptTokens: 100, completionTokens: 50 },
            _meta: callNum === 1 ? { retries: 2 } : undefined,
          };
        },
      };
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      testPriceData,
      { llmClientFactory, skipFileWrites: true },
    );

    const run = runs[0];
    const callsWithRetries = run.calls.filter(c => c.retries && c.retries > 0);
    expect(callsWithRetries.length).toBeGreaterThanOrEqual(1);
    expect(callsWithRetries[0].retries).toBe(2);
  });

  it("records total retries per run", async () => {
    const llmClientFactory: LlmClientFactory = (model) => ({
      async complete(): Promise<LlmCompletionResponse> {
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model,
          usage: { promptTokens: 100, completionTokens: 50 },
          _meta: { retries: 1 },
        };
      },
    });

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      testPriceData,
      { llmClientFactory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.retries).toBeGreaterThanOrEqual(7);
  });

  it("provider error records in call result", async () => {
    let taskIdx = 0;

    const llmClientFactory: LlmClientFactory = (model) => ({
      async complete(): Promise<LlmCompletionResponse> {
        taskIdx++;
        if (taskIdx === 1) {
          throw new ProviderError("provider_error: test_error", { code: "test_error", type: "test_type" });
        }
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model,
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    });

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      testPriceData,
      { llmClientFactory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.abortReason).toBe("provider_error");

    const errorCall = run.calls.find(c => c.providerError);
    expect(errorCall).toBeDefined();
    expect(errorCall?.providerError?.code).toBe("test_error");
    expect(errorCall?.providerError?.type).toBe("test_type");
  });
});

describe("per-task credit pre-flight", () => {
  it("getCallsPerRun returns 118 for suite 0.2.0", () => {
    const calls = getCallsPerRun("0.2.0");
    expect(calls).toBe(118);
  });

  it("getCallsPerRun returns 56 for suite 0.1.0 (7 tasks × 8 steps)", () => {
    const calls = getCallsPerRun("0.1.0");
    expect(calls).toBe(56);
  });

  it("opus worst case for 0.2.0 uses per-task maxSteps (118 calls)", () => {
    const opusPricing: ModelPricing = {
      modelId: "anthropic/claude-opus-5.5",
      promptPrice: 15 / 1_000_000,
      completionPrice: 75 / 1_000_000,
    };

    const callsPerRun = getCallsPerRun("0.2.0");
    expect(callsPerRun).toBe(118);

    const iMax = 4700;
    const outputTokens = 512;
    const worstCase = calculateModelFullWorstCaseWithCallsPerRun(1, callsPerRun, iMax, opusPricing);

    const expectedPerCall = iMax * opusPricing.promptPrice + outputTokens * opusPricing.completionPrice;
    const expectedTotal = callsPerRun * expectedPerCall;
    expect(worstCase).toBeCloseTo(expectedTotal, 6);

    const flatCallsPerRun = 16 * 12;
    const flatWorstCase = calculateModelFullWorstCaseWithCallsPerRun(1, flatCallsPerRun, iMax, opusPricing);
    expect(worstCase).toBeLessThan(flatWorstCase);
    expect(worstCase / flatWorstCase).toBeCloseTo(118 / 192, 2);
  });
});

describe("full matrix run with scripted fetch", () => {
  const testPricing: ModelPricing = {
    modelId: "test/model",
    promptPrice: 0,
    completionPrice: 0,
  };

  it("every model × suite with no shared state between models", async () => {
    const modelCallCounts = new Map<string, number>();

    const llmClientFactory: LlmClientFactory = (model) => {
      return {
        async complete(): Promise<LlmCompletionResponse> {
          modelCallCounts.set(model, (modelCallCounts.get(model) ?? 0) + 1);
          return {
            content: "Thought: done\nAction: finish\nAction Input: hello",
            model,
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        },
      };
    };

    const models = ["model/a", "model/b", "model/c"];
    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map(models.map(m => [m, { ...testPricing, modelId: m }])),
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models, runs: 1, capUsd: 100, fixture: false },
      priceData,
      { llmClientFactory, skipFileWrites: true },
    );

    expect(runs.length).toBe(3);

    for (const model of models) {
      const modelRuns = runs.filter(r => r.model === model);
      expect(modelRuns.length).toBe(1);
      expect(modelCallCounts.get(model)).toBeGreaterThan(0);
    }

    for (const model of models) {
      expect(modelCallCounts.get(model)).not.toBe(0);
    }
  });

  it("fixture mode has retries: 0", async () => {
    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["test/model", testPricing]]),
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: true },
      priceData,
      { skipFileWrites: true },
    );

    expect(runs[0].retries).toBe(0);
  });
});
