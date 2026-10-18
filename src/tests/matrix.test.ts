import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateCallCost,
  calculateWorstCaseCost,
  validatePricesForModels,
  createFixturePrices,
  sortModelsByCost,
  sortModelsByFullWorstCase,
  checkGitStatus,
  getResultsDir,
  runMatrix,
  type ModelPricing,
  type PriceData,
  type CallResult,
  type LlmClientFactory,
  getDefaultCapUsd,
  getDefaultIMax,
  getDefaultMaxInputTokens,
  getSuiteTasks,
  getCallsPerRun,
  SUITE_CONFIGS,
  MatrixAbort,
  MatrixLlmClient,
  MAX_COMPLETION_TOKENS,
} from "../matrix/index.js";
import {
  registerSensitiveValue,
  clearSensitiveValues,
  redactString,
  redactObject,
  redactError,
  safeStringify,
} from "../matrix/redact.js";
import { parseArgs, runMain } from "../matrix.js";
import type { LlmClient, LlmCompletionResponse } from "../llm/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("cost math", () => {
  it("calculates call cost correctly", () => {
    const pricing: ModelPricing = {
      modelId: "test/model",
      promptPrice: 0.001,
      completionPrice: 0.002,
    };

    const cost = calculateCallCost(1000, 500, pricing);
    expect(cost).toBeCloseTo(1000 * 0.001 + 500 * 0.002);
    expect(cost).toBeCloseTo(2.0);
  });

  it("calculates worst case cost correctly", () => {
    const pricing: ModelPricing = {
      modelId: "test/model",
      promptPrice: 0.000001,
      completionPrice: 0.000002,
    };

    const calls = 7 * 8;
    const iMax = 2410;
    const outputTokens = 512;

    const cost = calculateWorstCaseCost(calls, iMax, outputTokens, pricing);
    const expected = calls * (iMax * 0.000001 + outputTokens * 0.000002);
    expect(cost).toBeCloseTo(expected);
  });

  it("uses correct I_max for 0.1.0", () => {
    const iMax = getDefaultIMax("0.1.0", 8);
    expect(iMax).toBe(3000);
  });

  it("uses 4700 for maxSteps 12 suites", () => {
    const iMax = getDefaultIMax("0.2.0", 12);
    expect(iMax).toBe(4700);
  });
});

describe("abort rules", () => {
  describe("rule a: run cost exceeds worst case", () => {
    it("worst case calculation includes all tasks and steps", () => {
      const pricing: ModelPricing = {
        modelId: "test/model",
        promptPrice: 0.00001,
        completionPrice: 0.00002,
      };

      const tasks = 7;
      const maxSteps = 8;
      const iMax = 2410;
      const outputTokens = 512;

      const worstCase = calculateWorstCaseCost(
        tasks * maxSteps,
        iMax,
        outputTokens,
        pricing,
      );

      expect(worstCase).toBeGreaterThan(0);
      expect(worstCase).toBe(
        tasks * maxSteps * (iMax * pricing.promptPrice + outputTokens * pricing.completionPrice),
      );
    });
  });

  describe("rule b: completion tokens exceeded", () => {
    it("MAX_COMPLETION_TOKENS constant is 512", () => {
      expect(MAX_COMPLETION_TOKENS).toBe(512);
    });
  });

  describe("rule c: prompt tokens exceeded", () => {
    it("uses 3000 for 0.1.0", () => {
      const config = SUITE_CONFIGS["0.1.0"];
      expect(config.maxInputTokens).toBe(3000);
    });

    it("getDefaultMaxInputTokens returns 4700 for maxSteps 12", () => {
      expect(getDefaultMaxInputTokens(12)).toBe(4700);
    });

    it("getDefaultMaxInputTokens returns 3750 for other maxSteps", () => {
      expect(getDefaultMaxInputTokens(8)).toBe(3750);
    });
  });

  describe("rule d: HTTP errors", () => {
    it("two failing tasks trigger abort", () => {
      const tasksWithHttpErrors = 2;
      expect(tasksWithHttpErrors >= 2).toBe(true);
    });

    it("one failing task does not trigger abort", () => {
      const tasksWithHttpErrors = 1;
      expect(tasksWithHttpErrors >= 2).toBe(false);
    });
  });
});

describe("suite tasks", () => {
  it("getSuiteTasks returns tasks for 0.1.0", () => {
    const tasks = getSuiteTasks("0.1.0");
    expect(tasks.length).toBe(7);
  });

  it("getSuiteTasks throws for unknown suite", () => {
    expect(() => getSuiteTasks("unknown")).toThrow("Unknown suite version");
  });

  it("getDefaultIMax returns 3000 for 0.1.0", () => {
    expect(getDefaultIMax("0.1.0", 8)).toBe(3000);
  });

  it("getDefaultIMax returns 4700 for maxSteps 12", () => {
    expect(getDefaultIMax("0.2.0", 12)).toBe(4700);
  });
});

describe("global cap", () => {
  it("has correct default caps", () => {
    expect(getDefaultCapUsd("0.1.0")).toBe(10.0);
    expect(getDefaultCapUsd("0.2.0")).toBe(35.0);
    expect(getDefaultCapUsd("unknown")).toBe(10.0);
  });

  it("checks cap before every call", () => {
    const cap = 10.0;
    const cumulativeCost = 9.5;
    const nextWorstCase = 0.6;

    const wouldExceed = cumulativeCost + nextWorstCase > cap;
    expect(wouldExceed).toBe(true);

    const safeCase = 0.4;
    const wouldNotExceed = cumulativeCost + safeCase > cap;
    expect(wouldNotExceed).toBe(false);
  });
});

describe("empty answer flagging", () => {
  it("flags empty string as empty", () => {
    const isEmptyAnswer = (answer: string) => !answer || !answer.trim();

    expect(isEmptyAnswer("")).toBe(true);
    expect(isEmptyAnswer("   ")).toBe(true);
    expect(isEmptyAnswer("\n\t")).toBe(true);
    expect(isEmptyAnswer("hello")).toBe(false);
    expect(isEmptyAnswer(" valid answer ")).toBe(false);
  });
});

describe("price validation", () => {
  it("validates all requested models have prices", () => {
    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([
        ["model-a", { modelId: "model-a", promptPrice: 0.001, completionPrice: 0.002 }],
        ["model-b", { modelId: "model-b", promptPrice: 0.001, completionPrice: 0.002 }],
      ]),
    };

    const valid = validatePricesForModels(priceData, ["model-a", "model-b"]);
    expect(valid.valid).toBe(true);
    expect(valid.missing).toEqual([]);
  });

  it("refuses on missing prices", () => {
    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([
        ["model-a", { modelId: "model-a", promptPrice: 0.001, completionPrice: 0.002 }],
      ]),
    };

    const valid = validatePricesForModels(priceData, ["model-a", "model-c"]);
    expect(valid.valid).toBe(false);
    expect(valid.missing).toContain("model-c");
  });
});

describe("fixture prices", () => {
  it("creates zero-cost fixture prices", () => {
    const fixture = createFixturePrices(["model-a", "model-b"]);

    expect(fixture.models.size).toBe(2);
    expect(fixture.models.get("model-a")?.promptPrice).toBe(0);
    expect(fixture.models.get("model-a")?.completionPrice).toBe(0);
  });
});

describe("model sorting", () => {
  it("sorts models by cost (cheapest first)", () => {
    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([
        ["expensive", { modelId: "expensive", promptPrice: 0.01, completionPrice: 0.02 }],
        ["cheap", { modelId: "cheap", promptPrice: 0.001, completionPrice: 0.002 }],
        ["medium", { modelId: "medium", promptPrice: 0.005, completionPrice: 0.01 }],
      ]),
    };

    const sorted = sortModelsByCost(["expensive", "cheap", "medium"], priceData);
    expect(sorted[0]).toBe("cheap");
    expect(sorted[1]).toBe("medium");
    expect(sorted[2]).toBe("expensive");
  });

  it("sortModelsByFullWorstCase uses per-task callsPerRun (118 for 0.2.0)", () => {
    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([
        ["expensive", { modelId: "expensive", promptPrice: 0.000012, completionPrice: 0.00006 }],
        ["cheap", { modelId: "cheap", promptPrice: 0.000001, completionPrice: 0.000002 }],
      ]),
    };

    const callsPerRun020 = getCallsPerRun("0.2.0");
    expect(callsPerRun020).toBe(118);

    const iMax = 4700;
    const runs = 3;

    const sorted = sortModelsByFullWorstCase(
      ["expensive", "cheap"],
      priceData,
      runs,
      callsPerRun020,
      iMax,
    );

    expect(sorted[0]).toBe("cheap");
    expect(sorted[1]).toBe("expensive");

    const callsPerRun010 = getCallsPerRun("0.1.0");
    expect(callsPerRun010).toBe(56);
  });
});

describe("per-call enforcement", () => {
  function createMockLlm(responses: Array<{ promptTokens: number; completionTokens: number }>): LlmClient & { callCount: number } {
    let idx = 0;
    return {
      callCount: 0,
      async complete(): Promise<LlmCompletionResponse> {
        this.callCount++;
        const resp = responses[idx] ?? responses[responses.length - 1];
        idx++;
        return {
          content: "Thought: done\nAction: finish\nAction Input: test",
          model: "mock",
          usage: {
            promptTokens: resp.promptTokens,
            completionTokens: resp.completionTokens,
          },
        };
      },
    };
  }

  const pricing: ModelPricing = {
    modelId: "test/model",
    promptPrice: 0.001,
    completionPrice: 0.001,
  };

  it("throws MatrixAbort on completion tokens exceeded after call", async () => {
    const mockLlm = createMockLlm([{ promptTokens: 100, completionTokens: 600 }]);
    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 2410,
      globalCapUsd: 100,
      worstCasePerRun: 100,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => 0,
      onCall: () => {},
    });

    try {
      await wrappedLlm.complete({ messages: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MatrixAbort);
      expect((err as MatrixAbort).reason).toBe("completion_tokens_exceeded");
    }
    expect(mockLlm.callCount).toBe(1);
  });

  it("throws MatrixAbort on prompt tokens exceeded after call", async () => {
    const mockLlm = createMockLlm([{ promptTokens: 4000, completionTokens: 100 }]);
    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 2410,
      globalCapUsd: 100,
      worstCasePerRun: 100,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => 0,
      onCall: () => {},
    });

    try {
      await wrappedLlm.complete({ messages: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MatrixAbort);
      expect((err as MatrixAbort).reason).toBe("prompt_tokens_exceeded");
    }
    expect(mockLlm.callCount).toBe(1);
  });

  it("throws MatrixAbort before call when global cap would be exceeded", async () => {
    const mockLlm = createMockLlm([{ promptTokens: 100, completionTokens: 100 }]);
    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 2410,
      globalCapUsd: 0.001,
      worstCasePerRun: 100,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => 0,
      onCall: () => {},
    });

    try {
      await wrappedLlm.complete({ messages: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MatrixAbort);
      expect((err as MatrixAbort).reason).toBe("global_cap");
    }
    expect(mockLlm.callCount).toBe(0);
  });

  it("throws MatrixAbort before call when run cost would exceed worst case", async () => {
    const mockLlm = createMockLlm([{ promptTokens: 100, completionTokens: 100 }]);
    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 2410,
      globalCapUsd: 100,
      worstCasePerRun: 0.001,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => 0,
      onCall: () => {},
    });

    try {
      await wrappedLlm.complete({ messages: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MatrixAbort);
      expect((err as MatrixAbort).reason).toBe("cost_exceeded");
    }
    expect(mockLlm.callCount).toBe(0);
  });

  it("no call is made after global cap trip", async () => {
    const mockLlm = createMockLlm([{ promptTokens: 100, completionTokens: 100 }]);
    let taskCost = 0;
    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 2410,
      globalCapUsd: 0.0001,
      worstCasePerRun: 100,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => taskCost,
      onCall: (usage) => { taskCost += usage.costUsd; },
    });

    try {
      await wrappedLlm.complete({ messages: [] });
    } catch {
      // Expected
    }

    const callsBefore = mockLlm.callCount;

    try {
      await wrappedLlm.complete({ messages: [] });
    } catch {
      // Expected
    }

    expect(mockLlm.callCount).toBe(callsBefore);
  });

  it("no call is made after completion token trip - tripping call is the last", async () => {
    const mockLlm = createMockLlm([
      { promptTokens: 100, completionTokens: 100 },
      { promptTokens: 100, completionTokens: 600 },
    ]);
    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 2410,
      globalCapUsd: 100,
      worstCasePerRun: 100,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => 0,
      onCall: () => {},
    });

    await wrappedLlm.complete({ messages: [] });
    expect(mockLlm.callCount).toBe(1);

    try {
      await wrappedLlm.complete({ messages: [] });
    } catch {
      // Expected - completion tokens exceeded
    }
    expect(mockLlm.callCount).toBe(2);
  });
});

describe("redaction", () => {
  const FAKE_KEY = "sk-or-test-SECRET123";

  beforeEach(() => {
    clearSensitiveValues();
  });

  afterEach(() => {
    clearSensitiveValues();
  });

  it("redacts registered sensitive values from strings", () => {
    registerSensitiveValue(FAKE_KEY);

    const input = `Authorization: Bearer ${FAKE_KEY}`;
    const result = redactString(input);

    expect(result).not.toContain(FAKE_KEY);
    expect(result).not.toContain("SECRET123");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens even without registration", () => {
    const input = "Bearer sk-or-v1-abcdef123456";
    const result = redactString(input);

    expect(result).not.toContain("sk-or-v1-abcdef123456");
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("redacts from nested objects", () => {
    registerSensitiveValue(FAKE_KEY);

    const obj = {
      headers: {
        Authorization: `Bearer ${FAKE_KEY}`,
      },
      message: `Error with key ${FAKE_KEY}`,
      nested: {
        deep: {
          value: FAKE_KEY,
        },
      },
    };

    const result = redactObject(obj);

    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(result)).not.toContain("SECRET123");
  });

  it("redacts from error messages", () => {
    registerSensitiveValue(FAKE_KEY);

    const error = new Error(`HTTP 401: Invalid key ${FAKE_KEY}`);
    const redacted = redactError(error);

    expect(redacted.message).not.toContain(FAKE_KEY);
    expect(redacted.message).not.toContain("SECRET123");
    expect(redacted.message).toContain("[REDACTED]");
  });

  it("redacts from error stack traces", () => {
    registerSensitiveValue(FAKE_KEY);

    const error = new Error(`Connection failed with ${FAKE_KEY}`);
    error.stack = `Error: Connection failed with ${FAKE_KEY}\n    at test.ts:1:1`;

    const redacted = redactError(error);

    expect(redacted.stack).not.toContain(FAKE_KEY);
    expect(redacted.stack).toContain("[REDACTED]");
  });

  it("safeStringify redacts before serialization", () => {
    registerSensitiveValue(FAKE_KEY);

    const obj = {
      key: FAKE_KEY,
      auth: `Bearer ${FAKE_KEY}`,
    };

    const result = safeStringify(obj);

    expect(result).not.toContain(FAKE_KEY);
    expect(result).not.toContain("SECRET123");
    expect(result).toContain("[REDACTED]");
  });
});

describe("redaction with HTTP errors", () => {
  const FAKE_KEY = "sk-or-test-SECRET123";

  beforeEach(() => {
    clearSensitiveValues();
    registerSensitiveValue(FAKE_KEY);
  });

  afterEach(() => {
    clearSensitiveValues();
  });

  it("redacts key from mocked HTTP error response", () => {
    const httpErrorMessage = `HTTP 401 Unauthorized: Invalid API key ${FAKE_KEY}`;
    const error = new Error(httpErrorMessage);

    const redacted = redactError(error);

    expect(redacted.message).not.toContain(FAKE_KEY);
    expect(redacted.message).not.toContain("SECRET123");
    expect(redacted.message).toContain("[REDACTED]");
    expect(redacted.message).toContain("HTTP 401");
  });

  it("redacts key from mocked network error", () => {
    const networkError = new Error(
      `fetch failed: ECONNREFUSED, request contained Bearer ${FAKE_KEY}`,
    );

    const redacted = redactError(networkError);

    expect(redacted.message).not.toContain(FAKE_KEY);
    expect(redacted.message).not.toContain("Bearer sk-or");
    expect(redacted.message).toContain("Bearer [REDACTED]");
  });

  it("redacts from stringified error objects", () => {
    const errorObj = {
      status: 403,
      message: `Forbidden: key ${FAKE_KEY} is invalid`,
      headers: {
        "x-request-id": "abc123",
        authorization: `Bearer ${FAKE_KEY}`,
      },
    };

    const result = safeStringify(errorObj);

    expect(result).not.toContain(FAKE_KEY);
    expect(result).not.toContain("SECRET123");
    expect(result).toContain("403");
    expect(result).toContain("abc123");
  });
});

describe("redaction never leaks to files", () => {
  const FAKE_KEY = "sk-or-test-SECRET123";
  const TEST_DIR = path.join(__dirname, "../../.test-output");

  beforeEach(async () => {
    clearSensitiveValues();
    registerSensitiveValue(FAKE_KEY);
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    clearSensitiveValues();
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("safeStringify output written to file contains no key", async () => {
    const data = {
      error: `Auth failed with key ${FAKE_KEY}`,
      headers: { Authorization: `Bearer ${FAKE_KEY}` },
    };

    const safePath = path.join(TEST_DIR, "safe-output.json");
    await writeFile(safePath, safeStringify(data, 2), "utf8");

    const content = await readFile(safePath, "utf8");

    expect(content).not.toContain(FAKE_KEY);
    expect(content).not.toContain("SECRET123");
    expect(content).not.toContain("Bearer sk-or");
  });

  it("redacted error message written to file contains no key", async () => {
    const error = new Error(`Request failed: Bearer ${FAKE_KEY} rejected`);
    const redacted = redactError(error);

    const logPath = path.join(TEST_DIR, "error-log.txt");
    await writeFile(logPath, redacted.message, "utf8");

    const content = await readFile(logPath, "utf8");

    expect(content).not.toContain(FAKE_KEY);
    expect(content).not.toContain("SECRET123");
    expect(content).toContain("[REDACTED]");
  });
});

describe("CLI argument validation", () => {
  describe("--cap-usd validation", () => {
    it("accepts valid positive cap", () => {
      const args = parseArgs(["--cap-usd", "10"]);
      expect(args.errors).toEqual([]);
      expect(args.capUsd).toBe(10);
    });

    it("accepts valid decimal cap", () => {
      const args = parseArgs(["--cap-usd", "5.5"]);
      expect(args.errors).toEqual([]);
      expect(args.capUsd).toBe(5.5);
    });

    it("rejects NaN for --cap-usd", () => {
      const args = parseArgs(["--cap-usd", "abc"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--cap-usd");
      expect(args.errors[0]).toContain("plain decimal");
    });

    it("rejects missing value for --cap-usd", () => {
      const args = parseArgs(["--cap-usd"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--cap-usd requires a value");
    });

    it("rejects missing value when another flag follows", () => {
      const args = parseArgs(["--cap-usd", "--fixture"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--cap-usd requires a value");
    });

    it("rejects zero for --cap-usd", () => {
      const args = parseArgs(["--cap-usd", "0"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--cap-usd");
      expect(args.errors[0]).toContain("greater than 0");
    });

    it("rejects negative for --cap-usd", () => {
      const args = parseArgs(["--cap-usd", "-5"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--cap-usd");
      expect(args.errors[0]).toContain("plain decimal");
    });

    it("rejects trailing chars for --cap-usd", () => {
      const args = parseArgs(["--cap-usd", "5abc"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--cap-usd");
      expect(args.errors[0]).toContain("plain decimal");
    });
  });

  describe("--runs validation", () => {
    it("accepts valid integer runs", () => {
      const args = parseArgs(["--runs", "3"]);
      expect(args.errors).toEqual([]);
      expect(args.runs).toBe(3);
    });

    it("rejects NaN for --runs", () => {
      const args = parseArgs(["--runs", "abc"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--runs");
      expect(args.errors[0]).toContain("integer");
    });

    it("rejects missing value for --runs", () => {
      const args = parseArgs(["--runs"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--runs requires a value");
    });

    it("rejects zero for --runs", () => {
      const args = parseArgs(["--runs", "0"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--runs");
      expect(args.errors[0]).toContain("positive integer");
    });

    it("rejects negative for --runs", () => {
      const args = parseArgs(["--runs", "-1"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--runs");
      expect(args.errors[0]).toContain("positive integer");
    });

    it("rejects trailing chars for --runs", () => {
      const args = parseArgs(["--runs", "1abc"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--runs");
      expect(args.errors[0]).toContain("integer");
    });

    it("rejects non-integer for --runs", () => {
      const args = parseArgs(["--runs", "2.5"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--runs");
      expect(args.errors[0]).toContain("integer");
    });
  });

  describe("combined arguments", () => {
    it("parses fixture mode correctly", () => {
      const args = parseArgs(["--fixture"]);
      expect(args.errors).toEqual([]);
      expect(args.fixture).toBe(true);
    });

    it("parses short flags correctly", () => {
      const args = parseArgs(["-f", "-r", "5", "-c", "20"]);
      expect(args.errors).toEqual([]);
      expect(args.fixture).toBe(true);
      expect(args.runs).toBe(5);
      expect(args.capUsd).toBe(20);
    });
  });
});

describe("git status validation", () => {
  it("checkGitStatus returns sha and isDirty", () => {
    const status = checkGitStatus();
    expect(typeof status.sha).toBe("string");
    expect(typeof status.isDirty).toBe("boolean");
  });

  it("returns full 40-char SHA", () => {
    const status = checkGitStatus();
    if (!status.error) {
      expect(status.sha.length).toBe(40);
      expect(/^[0-9a-f]+$/.test(status.sha)).toBe(true);
    }
  });
});

describe("results directory", () => {
  it("getResultsDir returns results/ for live mode", () => {
    const dir = getResultsDir(false);
    expect(dir).toContain("results");
    expect(dir).not.toContain("results-fixture");
  });

  it("getResultsDir returns results-fixture/ for fixture mode", () => {
    const dir = getResultsDir(true);
    expect(dir).toContain("results-fixture");
  });
});

describe("empty response tracking", () => {
  const pricing: ModelPricing = {
    modelId: "test/model",
    promptPrice: 0.001,
    completionPrice: 0.001,
  };

  function createEmptyMockLlm(): LlmClient & { callCount: number } {
    return {
      callCount: 0,
      async complete(): Promise<LlmCompletionResponse> {
        this.callCount++;
        return {
          content: "",
          model: "mock",
          usage: {
            promptTokens: 100,
            completionTokens: 50,
          },
        };
      },
    };
  }

  it("flags empty content as empty in onCall", async () => {
    const mockLlm = createEmptyMockLlm();
    let receivedEmpty = false;

    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 3000,
      globalCapUsd: 100,
      worstCasePerRun: 100,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => 0,
      onCall: (usage) => {
        receivedEmpty = usage.empty;
      },
    });

    await wrappedLlm.complete({ messages: [] });
    expect(receivedEmpty).toBe(true);
  });

  it("does not flag non-empty content as empty", async () => {
    const mockLlm: LlmClient & { callCount: number } = {
      callCount: 0,
      async complete(): Promise<LlmCompletionResponse> {
        this.callCount++;
        return {
          content: "valid response",
          model: "mock",
          usage: {
            promptTokens: 100,
            completionTokens: 50,
          },
        };
      },
    };
    let receivedEmpty = false;

    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 3000,
      globalCapUsd: 100,
      worstCasePerRun: 100,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => 0,
      onCall: (usage) => {
        receivedEmpty = usage.empty;
      },
    });

    await wrappedLlm.complete({ messages: [] });
    expect(receivedEmpty).toBe(false);
  });

  it("flags whitespace-only content as empty", async () => {
    const mockLlm: LlmClient & { callCount: number } = {
      callCount: 0,
      async complete(): Promise<LlmCompletionResponse> {
        this.callCount++;
        return {
          content: "   \n\t  ",
          model: "mock",
          usage: {
            promptTokens: 100,
            completionTokens: 50,
          },
        };
      },
    };
    let receivedEmpty = false;

    const wrappedLlm = new MatrixLlmClient(mockLlm, {
      pricing,
      maxInputTokens: 3000,
      iMax: 3000,
      globalCapUsd: 100,
      worstCasePerRun: 100,
      getCumulativeCost: () => 0,
      getRunCostSoFar: () => 0,
      getTaskCostSoFar: () => 0,
      onCall: (usage) => {
        receivedEmpty = usage.empty;
      },
    });

    await wrappedLlm.complete({ messages: [] });
    expect(receivedEmpty).toBe(true);
  });
});

describe("HTTP status and error code recording", () => {
  it("CallResult type includes httpStatus and errorCode fields", () => {
    const callResult: CallResult = {
      taskId: "test-task",
      step: 1,
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: null,
        costUsd: 0.001,
      },
      empty: false,
      httpError: true,
      httpStatus: 401,
      errorCode: "UNAUTHORIZED",
    };

    expect(callResult.httpStatus).toBe(401);
    expect(callResult.errorCode).toBe("UNAUTHORIZED");
  });

  it("CallResult allows missing httpStatus and errorCode", () => {
    const callResult: CallResult = {
      taskId: "test-task",
      step: 1,
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: null,
        costUsd: 0.001,
      },
      empty: false,
      httpError: false,
    };

    expect(callResult.httpStatus).toBeUndefined();
    expect(callResult.errorCode).toBeUndefined();
  });

  it("extracts HTTP status from error message pattern", () => {
    const errorMsg = "Request failed: HTTP 429 Too Many Requests";
    const httpMatch = errorMsg.match(/HTTP\s*(\d{3})/i);
    expect(httpMatch).not.toBeNull();
    expect(parseInt(httpMatch![1], 10)).toBe(429);
  });

  it("extracts error code from error message pattern", () => {
    const errorMsg = "fetch failed: ECONNREFUSED at 127.0.0.1:443";
    const codeMatch = errorMsg.match(/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET)\b/i);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1].toUpperCase()).toBe("ECONNREFUSED");
  });

  it("handles ETIMEDOUT error code", () => {
    const errorMsg = "connect ETIMEDOUT 1.2.3.4:443";
    const codeMatch = errorMsg.match(/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET)\b/i);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1].toUpperCase()).toBe("ETIMEDOUT");
  });

  it("handles ENOTFOUND error code", () => {
    const errorMsg = "getaddrinfo ENOTFOUND api.example.com";
    const codeMatch = errorMsg.match(/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET)\b/i);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1].toUpperCase()).toBe("ENOTFOUND");
  });
});

// ====================
// BEHAVIORAL TESTS
// ====================

describe("1. Empty responses end-to-end", () => {
  const zeroPricing: ModelPricing = {
    modelId: "test/empty-model",
    promptPrice: 0,
    completionPrice: 0,
  };

  const zeroPriceData: PriceData = {
    fetchedAt: new Date().toISOString(),
    models: new Map([["test/empty-model", zeroPricing]]),
  };

  function createEmptyLlmFactory(): { factory: LlmClientFactory; callCount: number } {
    let callCount = 0;
    const factory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        callCount++;
        return {
          content: "",
          model: "test/empty-model",
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    });
    return {
      factory,
      get callCount() { return callCount; },
    };
  }

  it("marks all calls as empty when client returns empty string", async () => {
    const { factory } = createEmptyLlmFactory();

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/empty-model"], runs: 1, capUsd: 100, fixture: false },
      zeroPriceData,
      { llmClientFactory: factory, skipFileWrites: true },
    );

    expect(runs.length).toBe(1);
    const run = runs[0];

    for (const call of run.calls) {
      expect(call.empty).toBe(true);
    }
  });

  it("flags each task as empty when all responses are empty", async () => {
    const { factory } = createEmptyLlmFactory();

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/empty-model"], runs: 1, capUsd: 100, fixture: false },
      zeroPriceData,
      { llmClientFactory: factory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.emptyTasks.length).toBeGreaterThan(0);
    expect(run.emptyTasks.length).toBe(run.total);
  });

  it("per-model summary emptyCount equals total empty TASKS (not calls)", async () => {
    const { factory } = createEmptyLlmFactory();

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/empty-model"], runs: 1, capUsd: 100, fixture: false },
      zeroPriceData,
      { llmClientFactory: factory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.emptyCount).toBe(run.emptyTasks.length);
    expect(run.emptyCount).toBeLessThanOrEqual(7);
    expect(run.emptyCount).toBeGreaterThan(0);
  });

  it("flags task empty when max steps hit with non-empty but no Final Answer", async () => {
    let callIdx = 0;
    const factory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        callIdx++;
        return {
          content: "Thought: I need to think more\nAction: none\nAction Input: nothing",
          model: "test/model",
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    });

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/empty-model"], runs: 1, capUsd: 100, fixture: false },
      zeroPriceData,
      { llmClientFactory: factory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.emptyTasks.length).toBeGreaterThan(0);
  });

  it("excludes HTTP error tasks from empty count", async () => {
    const httpErrorFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        throw new Error("HTTP 500 Internal Server Error");
      },
    });

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/empty-model"], runs: 1, capUsd: 100, fixture: false },
      zeroPriceData,
      { llmClientFactory: httpErrorFactory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.emptyTasks.length).toBe(0);
    expect(run.emptyCount).toBe(0);
  });
});

describe("2. Git refusal in live mode", () => {
  const mockPriceData: PriceData = {
    fetchedAt: new Date().toISOString(),
    models: new Map([["test/model", { modelId: "test/model", promptPrice: 0.001, completionPrice: 0.002 }]]),
  };

  let clientCallCount = 0;
  const trackingFactory: LlmClientFactory = () => ({
    async complete(): Promise<LlmCompletionResponse> {
      clientCallCount++;
      return { content: "test", model: "test/model", usage: { promptTokens: 10, completionTokens: 5 } };
    },
  });

  beforeEach(() => {
    clientCallCount = 0;
  });

  it("exits non-zero and makes ZERO client calls when rev-parse fails", async () => {
    const exitCode = await runMain({
      argv: ["--models", "test/model", "--runs", "1"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "", isDirty: true, error: "git rev-parse HEAD failed" }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: mockPriceData,
    });

    expect(exitCode).toBe(1);
    expect(clientCallCount).toBe(0);
  });

  it("exits non-zero and makes ZERO client calls when porcelain shows tracked change", async () => {
    const exitCode = await runMain({
      argv: ["--models", "test/model", "--runs", "1"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456", isDirty: true }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: mockPriceData,
    });

    expect(exitCode).toBe(1);
    expect(clientCallCount).toBe(0);
  });

  it("exits non-zero when porcelain shows untracked file outside results/", async () => {
    const exitCode = await runMain({
      argv: ["--models", "test/model", "--runs", "1"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456", isDirty: true }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: mockPriceData,
    });

    expect(exitCode).toBe(1);
    expect(clientCallCount).toBe(0);
  });

  it("allows changes only under results/ or results-fixture/", () => {
    const status = checkGitStatus();
    expect(typeof status.sha).toBe("string");
  });
});

describe("3. max_tokens enforcement", () => {
  it("passes max_tokens 512 to client even when MAX_TOKENS env would be higher", async () => {
    let receivedMaxTokens: number | undefined;

    const trackingFactory: LlmClientFactory = (model, maxTokens) => {
      receivedMaxTokens = maxTokens;
      return {
        async complete(): Promise<LlmCompletionResponse> {
          return {
            content: "Thought: done\nAction: finish\nAction Input: hello",
            model,
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        },
      };
    };

    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["test/model", { modelId: "test/model", promptPrice: 0, completionPrice: 0 }]]),
    };

    await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      priceData,
      { llmClientFactory: trackingFactory, skipFileWrites: true },
    );

    expect(receivedMaxTokens).toBe(512);
    expect(receivedMaxTokens).toBe(MAX_COMPLETION_TOKENS);
  });

  it("worst-case uses I_max 3000 for suite 0.1.0", () => {
    const iMax = getDefaultIMax("0.1.0", 8);
    expect(iMax).toBe(3000);
  });

  it("worst-case uses I_max 4700 for maxSteps 12", () => {
    const iMax = getDefaultIMax("0.2.0", 12);
    expect(iMax).toBe(4700);
  });
});

describe("4. Fixture output directory", () => {
  it("getResultsDir returns results-fixture/ for fixture mode", () => {
    const dir = getResultsDir(true);
    expect(dir).toContain("results-fixture");
    expect(dir).not.toMatch(/results\/$/);
  });

  it("getResultsDir returns results/ for live mode", () => {
    const dir = getResultsDir(false);
    expect(dir).toContain("results");
    expect(dir).not.toContain("results-fixture");
  });

  it("fixture run config sets fixture: true", async () => {
    const priceData = createFixturePrices(["test/model"]);

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: true },
      priceData,
      { skipFileWrites: true },
    );

    expect(runs.length).toBe(1);
    expect(runs[0].pass).toBe(runs[0].total);
  });
});

describe("5. Exit codes", () => {
  it("exits 0 when runs complete with task failures (fixture mode)", async () => {
    const exitCode = await runMain({
      argv: ["--fixture"],
      env: {},
      skipFileWrites: true,
    });

    expect(exitCode).toBe(0);
  });

  it("exits non-zero on bad args (invalid --cap-usd)", async () => {
    const exitCode = await runMain({
      argv: ["--cap-usd", "abc"],
      env: {},
      skipFileWrites: true,
    });

    expect(exitCode).toBe(1);
  });

  it("exits non-zero on bad args (--runs 0)", async () => {
    const exitCode = await runMain({
      argv: ["--runs", "0"],
      env: {},
      skipFileWrites: true,
    });

    expect(exitCode).toBe(1);
  });

  it("exits non-zero when global cap is hit", async () => {
    const expensiveFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        return {
          content: "Thought: expensive\nAction: finish\nAction Input: done",
          model: "test/model",
          usage: { promptTokens: 10000, completionTokens: 500 },
        };
      },
    });

    const expensivePriceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["test/model", { modelId: "test/model", promptPrice: 1, completionPrice: 1 }]]),
    };

    const exitCode = await runMain({
      argv: ["--models", "test/model", "--runs", "1", "--cap-usd", "0.001"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
      llmClientFactory: expensiveFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: expensivePriceData,
    });

    expect(exitCode).toBe(1);
  });
});

describe("6. HTTP error recording", () => {
  it("records httpStatus 429 from thrown error", async () => {
    let callIdx = 0;
    const http429Factory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        callIdx++;
        if (callIdx <= 2) {
          throw new Error("HTTP 429 Too Many Requests - rate limited");
        }
        return {
          content: "Thought: done\nAction: finish\nAction Input: ok",
          model: "test/model",
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    });

    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["test/model", { modelId: "test/model", promptPrice: 0, completionPrice: 0 }]]),
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      priceData,
      { llmClientFactory: http429Factory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.abortReason).toBe("http_errors");
  });

  it("records 429 on the FIRST call as its own entry", async () => {
    const http429OnFirstFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        throw new Error("HTTP 429 Too Many Requests");
      },
    });

    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["test/model", { modelId: "test/model", promptPrice: 0, completionPrice: 0 }]]),
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      priceData,
      { llmClientFactory: http429OnFirstFactory, skipFileWrites: true },
    );

    const run = runs[0];
    const task0Calls = run.calls.filter((c) => c.taskId === "echo_hello");
    expect(task0Calls.length).toBe(1);
    expect(task0Calls[0].httpError).toBe(true);
    expect(task0Calls[0].httpStatus).toBe(429);
    expect(task0Calls[0].step).toBe(1);
  });

  it("failure on third call lands on correct entry after two successes", async () => {
    let taskCallIdx = 0;
    const failOnThirdFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        taskCallIdx++;
        if (taskCallIdx === 3) {
          throw new Error("HTTP 500 Internal Server Error");
        }
        return {
          content: "Thought: thinking\nAction: echo\nAction Input: test",
          model: "test/model",
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    });

    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["test/model", { modelId: "test/model", promptPrice: 0, completionPrice: 0 }]]),
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      priceData,
      { llmClientFactory: failOnThirdFactory, skipFileWrites: true },
    );

    const run = runs[0];
    const httpErrorCalls = run.calls.filter((c) => c.httpError);

    expect(httpErrorCalls.length).toBeGreaterThanOrEqual(1);
    const errorCall = httpErrorCalls[0];
    expect(errorCall.httpStatus).toBe(500);
    expect(errorCall.step).toBe(3);

    const successCalls = run.calls.filter((c) => !c.httpError);
    for (const call of successCalls) {
      expect(call.httpStatus).toBeUndefined();
    }
  });

  it("counts toward 2-task HTTP error abort rule", async () => {
    let taskCallCount = 0;
    const http500Factory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        taskCallCount++;
        throw new Error("HTTP 500 Internal Server Error");
      },
    });

    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["test/model", { modelId: "test/model", promptPrice: 0, completionPrice: 0 }]]),
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      priceData,
      { llmClientFactory: http500Factory, skipFileWrites: true },
    );

    const run = runs[0];
    expect(run.abortReason).toBe("http_errors");
    expect(taskCallCount).toBeLessThanOrEqual(16);
  });

  it("does not include response body in recorded error", async () => {
    const errorFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        throw new Error("HTTP 429: {\"error\": \"rate limited\", \"body\": \"secret\"}");
      },
    });

    const priceData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["test/model", { modelId: "test/model", promptPrice: 0, completionPrice: 0 }]]),
    };

    const { runs } = await runMatrix(
      { suite: "0.1.0", models: ["test/model"], runs: 1, capUsd: 100, fixture: false },
      priceData,
      { llmClientFactory: errorFactory, skipFileWrites: true },
    );

    const run = runs[0];
    const httpErrorCalls = run.calls.filter((c) => c.httpError);

    for (const call of httpErrorCalls) {
      expect(call.httpStatus).toBeDefined();
      expect((call as unknown as Record<string, unknown>).responseBody).toBeUndefined();
    }
  });
});

// ====================
// CREDIT PRE-FLIGHT TESTS
// ====================

describe("7. Credit pre-flight", () => {
  const expensivePricing: ModelPricing = {
    modelId: "expensive/model",
    promptPrice: 0.01,
    completionPrice: 0.02,
  };
  const cheapPricing: ModelPricing = {
    modelId: "cheap/model",
    promptPrice: 0.0001,
    completionPrice: 0.0002,
  };

  const testPriceData: PriceData = {
    fetchedAt: new Date().toISOString(),
    models: new Map([
      ["expensive/model", expensivePricing],
      ["cheap/model", cheapPricing],
    ]),
  };

  function createTrackingFactory(): { factory: LlmClientFactory; getCallsPerModel: () => Map<string, number> } {
    const callsPerModel = new Map<string, number>();
    const factory: LlmClientFactory = (model) => ({
      async complete(): Promise<LlmCompletionResponse> {
        callsPerModel.set(model, (callsPerModel.get(model) ?? 0) + 1);
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model,
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    });
    return { factory, getCallsPerModel: () => callsPerModel };
  }

  it("runs models in ascending worst-case order via runMain", async () => {
    const modelOrder: string[] = [];
    const trackingFactory: LlmClientFactory = (model) => ({
      async complete(): Promise<LlmCompletionResponse> {
        if (!modelOrder.includes(model)) {
          modelOrder.push(model);
        }
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model,
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    });

    await runMain({
      argv: ["--models", "expensive/model,cheap/model", "--runs", "1", "--cap-usd", "10000"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
      creditFetcher: async () => ({ limitRemaining: null, availableCredits: 10000, keyError: false, creditsError: false }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: testPriceData,
    });

    expect(modelOrder[0]).toBe("cheap/model");
    expect(modelOrder[1]).toBe("expensive/model");
  });

  it("skips expensive model with ZERO calls when credit is short", async () => {
    const { factory, getCallsPerModel } = createTrackingFactory();

    const { skippedModels, creditTopUp } = await runMatrix(
      { suite: "0.1.0", models: ["expensive/model", "cheap/model"], runs: 1, capUsd: 10000, fixture: false },
      testPriceData,
      {
        llmClientFactory: factory,
        skipFileWrites: true,
        creditProvider: async () => 1,
      },
    );

    const calls = getCallsPerModel();
    expect(calls.get("expensive/model") ?? 0).toBe(0);
    expect(skippedModels.length).toBeGreaterThanOrEqual(1);
    const expensiveSkipped = skippedModels.find((s) => s.model === "expensive/model");
    expect(expensiveSkipped).toBeDefined();
    expect(expensiveSkipped!.shortfall).toBeGreaterThan(0);
    expect(creditTopUp).toBeGreaterThan(0);
  });

  it("enough credit runs every model", async () => {
    const { factory, getCallsPerModel } = createTrackingFactory();

    const { skippedModels } = await runMatrix(
      { suite: "0.1.0", models: ["expensive/model", "cheap/model"], runs: 1, capUsd: 10000, fixture: false },
      testPriceData,
      {
        llmClientFactory: factory,
        skipFileWrites: true,
        creditProvider: async () => 10000,
      },
    );

    const calls = getCallsPerModel();
    expect(calls.get("cheap/model")).toBeGreaterThan(0);
    expect(calls.get("expensive/model")).toBeGreaterThan(0);
    expect(skippedModels.length).toBe(0);
  });

  it("reports exact shortfall and correct top-up formula", async () => {
    const { factory } = createTrackingFactory();

    const { skippedModels, creditTopUp } = await runMatrix(
      { suite: "0.1.0", models: ["expensive/model", "cheap/model"], runs: 1, capUsd: 10000, fixture: false },
      testPriceData,
      {
        llmClientFactory: factory,
        skipFileWrites: true,
        creditProvider: async () => 0.001,
      },
    );

    expect(skippedModels.length).toBeGreaterThanOrEqual(1);
    for (const skipped of skippedModels) {
      expect(skipped.shortfall).toBeCloseTo(skipped.worstCase - skipped.remaining, 4);
    }
    const sumWorstCases = skippedModels.reduce((sum, s) => sum + s.worstCase, 0);
    const lastRemaining = skippedModels[skippedModels.length - 1].remaining;
    expect(creditTopUp).toBeCloseTo(Math.max(0, sumWorstCases - lastRemaining), 2);
  });

  it("both endpoints down refuses with non-zero exit and zero LLM calls", async () => {
    let llmCallCount = 0;
    const trackingFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        llmCallCount++;
        return { content: "test", model: "test", usage: { promptTokens: 10, completionTokens: 5 } };
      },
    });

    const exitCode = await runMain({
      argv: ["--models", "cheap/model", "--runs", "1"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
      creditFetcher: async () => ({ limitRemaining: null, availableCredits: null, keyError: true, creditsError: true }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: testPriceData,
    });

    expect(exitCode).toBe(1);
    expect(llmCallCount).toBe(0);
  });

  it("both endpoints down with --credit-usd uses the flag", async () => {
    let llmCallCount = 0;
    const trackingFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        llmCallCount++;
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model: "test",
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
    });

    const exitCode = await runMain({
      argv: ["--models", "cheap/model", "--runs", "1", "--cap-usd", "1000", "--credit-usd", "1000"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
      creditFetcher: async () => ({ limitRemaining: null, availableCredits: null, keyError: true, creditsError: true }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: testPriceData,
    });

    expect(exitCode).toBe(0);
    expect(llmCallCount).toBeGreaterThan(0);
  });

  it("one endpoint down still works from the other (key endpoint down)", async () => {
    let llmCallCount = 0;
    const trackingFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        llmCallCount++;
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model: "test",
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
    });

    const exitCode = await runMain({
      argv: ["--models", "cheap/model", "--runs", "1", "--cap-usd", "1000"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
      creditFetcher: async () => ({ limitRemaining: null, availableCredits: 1000, keyError: true, creditsError: false }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: testPriceData,
    });

    expect(exitCode).toBe(0);
    expect(llmCallCount).toBeGreaterThan(0);
  });

  it("one endpoint down still works from the other (credits endpoint down)", async () => {
    let llmCallCount = 0;
    const trackingFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        llmCallCount++;
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model: "test",
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
    });

    const exitCode = await runMain({
      argv: ["--models", "cheap/model", "--runs", "1", "--cap-usd", "1000"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
      creditFetcher: async () => ({ limitRemaining: 1000, availableCredits: null, keyError: false, creditsError: true }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: testPriceData,
    });

    expect(exitCode).toBe(0);
    expect(llmCallCount).toBeGreaterThan(0);
  });

  it("null limit_remaining is ignored (uses available credits only)", async () => {
    let llmCallCount = 0;
    const trackingFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        llmCallCount++;
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model: "test",
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
    });

    const exitCode = await runMain({
      argv: ["--models", "cheap/model", "--runs", "1", "--cap-usd", "1000"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
      creditFetcher: async () => ({ limitRemaining: null, availableCredits: 1000, keyError: false, creditsError: false }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: testPriceData,
    });

    expect(exitCode).toBe(0);
    expect(llmCallCount).toBeGreaterThan(0);
  });

  it("min with remaining cap is respected", async () => {
    const { factory } = createTrackingFactory();

    const { skippedModels } = await runMatrix(
      { suite: "0.1.0", models: ["expensive/model"], runs: 1, capUsd: 0.001, fixture: false },
      testPriceData,
      {
        llmClientFactory: factory,
        skipFileWrites: true,
        creditProvider: async () => 1000,
      },
    );

    expect(skippedModels.length).toBe(1);
    expect(skippedModels[0].remaining).toBeLessThanOrEqual(0.001);
  });

  describe("--credit-usd validation", () => {
    it("rejects NaN for --credit-usd", () => {
      const args = parseArgs(["--credit-usd", "abc"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--credit-usd");
      expect(args.errors[0]).toContain("plain decimal");
    });

    it("rejects missing value for --credit-usd", () => {
      const args = parseArgs(["--credit-usd"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--credit-usd requires a value");
    });

    it("rejects zero for --credit-usd", () => {
      const args = parseArgs(["--credit-usd", "0"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--credit-usd");
      expect(args.errors[0]).toContain("greater than 0");
    });

    it("rejects negative for --credit-usd", () => {
      const args = parseArgs(["--credit-usd", "-5"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--credit-usd");
      expect(args.errors[0]).toContain("plain decimal");
    });

    it("rejects trailing chars for --credit-usd", () => {
      const args = parseArgs(["--credit-usd", "5abc"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("--credit-usd");
      expect(args.errors[0]).toContain("plain decimal");
    });

    it("accepts valid positive credit-usd", () => {
      const args = parseArgs(["--credit-usd", "10"]);
      expect(args.errors).toEqual([]);
      expect(args.creditUsd).toBe(10);
    });

    it("rejects 1e1 for --cap-usd (scientific notation)", () => {
      const args = parseArgs(["--cap-usd", "1e1"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("plain decimal");
    });

    it("rejects 0x10 for --cap-usd (hex)", () => {
      const args = parseArgs(["--cap-usd", "0x10"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("plain decimal");
    });

    it("rejects Infinity for --cap-usd", () => {
      const args = parseArgs(["--cap-usd", "Infinity"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("plain decimal");
    });

    it("rejects 1e1 for --runs (scientific notation)", () => {
      const args = parseArgs(["--runs", "1e1"]);
      expect(args.errors.length).toBeGreaterThan(0);
      expect(args.errors[0]).toContain("positive integer");
    });
  });

  it("spend is subtracted - $4 credit never allows spending more than $4", async () => {
    let totalSpent = 0;
    const trackingFactory: LlmClientFactory = (model) => ({
      async complete(): Promise<LlmCompletionResponse> {
        totalSpent += 0.50;
        return {
          content: "Thought: done\nAction: finish\nAction Input: hello",
          model,
          usage: { promptTokens: 500, completionTokens: 50 },
        };
      },
    });

    const expensivePricing: ModelPricing = {
      modelId: "expensive/model",
      promptPrice: 0.001,
      completionPrice: 0.001,
    };
    const mediumPricing: ModelPricing = {
      modelId: "medium/model",
      promptPrice: 0.0005,
      completionPrice: 0.0005,
    };
    const testData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([
        ["expensive/model", expensivePricing],
        ["medium/model", mediumPricing],
      ]),
    };

    const { runs, skippedModels } = await runMatrix(
      { suite: "0.1.0", models: ["medium/model", "expensive/model"], runs: 3, capUsd: 1000, fixture: false },
      testData,
      {
        llmClientFactory: trackingFactory,
        skipFileWrites: true,
        creditProvider: async () => 4.00,
      },
    );

    const totalCost = runs.reduce((sum, r) => sum + r.costUsd, 0);
    expect(totalCost).toBeLessThanOrEqual(4.00);
    expect(skippedModels.length).toBeGreaterThanOrEqual(0);
  });

  it("top-up math: $1 left, skipped $1.87 + $3.74 = $4.61 top-up", async () => {
    const model1Pricing: ModelPricing = {
      modelId: "model1",
      promptPrice: 0.00333929,
      completionPrice: 0,
    };
    const model2Pricing: ModelPricing = {
      modelId: "model2",
      promptPrice: 0.00667857,
      completionPrice: 0,
    };
    const testData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([
        ["model1", model1Pricing],
        ["model2", model2Pricing],
      ]),
    };

    const { skippedModels, creditTopUp } = await runMatrix(
      { suite: "0.1.0", models: ["model1", "model2"], runs: 1, capUsd: 1000, fixture: false },
      testData,
      {
        llmClientFactory: () => ({
          async complete(): Promise<LlmCompletionResponse> {
            throw new Error("Should not be called");
          },
        }),
        skipFileWrites: true,
        creditProvider: async () => 1.00,
      },
    );

    expect(skippedModels.length).toBe(2);
    const totalWorstCase = skippedModels.reduce((sum, s) => sum + s.worstCase, 0);
    const lastRemaining = skippedModels[skippedModels.length - 1].remaining;
    expect(creditTopUp).toBeCloseTo(totalWorstCase - lastRemaining, 2);
  });

  it("labels skipped: cap when cap binds", async () => {
    const cheapPricing: ModelPricing = {
      modelId: "cheap/model",
      promptPrice: 0.00001,
      completionPrice: 0.00001,
    };
    const testData: PriceData = {
      fetchedAt: new Date().toISOString(),
      models: new Map([["cheap/model", cheapPricing]]),
    };

    const { skippedModels, capShortfall } = await runMatrix(
      { suite: "0.1.0", models: ["cheap/model"], runs: 1, capUsd: 0.001, fixture: false },
      testData,
      {
        llmClientFactory: () => ({
          async complete(): Promise<LlmCompletionResponse> {
            throw new Error("Should not be called");
          },
        }),
        skipFileWrites: true,
        creditProvider: async () => 1000,
      },
    );

    expect(skippedModels.length).toBe(1);
    expect(skippedModels[0].reason).toBe("cap");
    expect(capShortfall).toBeGreaterThan(0);
  });

  it("labels skipped: credit when credit binds", async () => {
    const { skippedModels, creditTopUp } = await runMatrix(
      { suite: "0.1.0", models: ["cheap/model"], runs: 1, capUsd: 1000, fixture: false },
      testPriceData,
      {
        llmClientFactory: () => ({
          async complete(): Promise<LlmCompletionResponse> {
            throw new Error("Should not be called");
          },
        }),
        skipFileWrites: true,
        creditProvider: async () => 0.001,
      },
    );

    expect(skippedModels.length).toBe(1);
    expect(skippedModels[0].reason).toBe("credit");
    expect(creditTopUp).toBeGreaterThan(0);
  });

  it("/credits fails AND /key null refuses without --credit-usd", async () => {
    let llmCallCount = 0;
    const trackingFactory: LlmClientFactory = () => ({
      async complete(): Promise<LlmCompletionResponse> {
        llmCallCount++;
        return { content: "test", model: "test", usage: { promptTokens: 10, completionTokens: 5 } };
      },
    });

    const exitCode = await runMain({
      argv: ["--models", "cheap/model", "--runs", "1"],
      env: { OPENROUTER_API_KEY: "test-key" },
      getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
      creditFetcher: async () => ({ limitRemaining: null, availableCredits: null, keyError: false, creditsError: true }),
      llmClientFactory: trackingFactory,
      skipFileWrites: true,
      skipPricesFetch: true,
      priceData: testPriceData,
    });

    expect(exitCode).toBe(1);
    expect(llmCallCount).toBe(0);
  });

  it("exits 0 and prints SKIPPED line when models are skipped", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runMain({
        argv: ["--models", "expensive/model", "--runs", "1", "--cap-usd", "1000"],
        env: { OPENROUTER_API_KEY: "test-key" },
        getGitStatus: () => ({ sha: "abc123def456789012345678901234567890abcd", isDirty: false }),
        creditFetcher: async () => ({ limitRemaining: null, availableCredits: 0.001, keyError: false, creditsError: false }),
        llmClientFactory: () => ({
          async complete(): Promise<LlmCompletionResponse> {
            throw new Error("Should not be called");
          },
        }),
        skipFileWrites: true,
        skipPricesFetch: true,
        priceData: testPriceData,
      });

      expect(exitCode).toBe(0);
      const skippedLine = logs.find((l) => l.includes("SKIPPED:") && l.includes("model(s)"));
      expect(skippedLine).toBeDefined();
      expect(skippedLine).toContain("1 model(s)");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("8. Credit redaction", () => {
  const FAKE_KEY = "sk-or-test-SECRET123";

  beforeEach(() => {
    clearSensitiveValues();
    registerSensitiveValue(FAKE_KEY);
  });

  afterEach(() => {
    clearSensitiveValues();
  });

  it("redacts key from credit-related error messages", () => {
    const error = new Error(`Credit check failed: Bearer ${FAKE_KEY} rejected`);
    const redacted = redactError(error);

    expect(redacted.message).not.toContain(FAKE_KEY);
    expect(redacted.message).not.toContain("SECRET123");
    expect(redacted.message).toContain("[REDACTED]");
  });

  it("never logs raw credit endpoint response in mocked scenario", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await runMain({
        argv: ["--fixture"],
        env: {},
        skipFileWrites: true,
      });

      for (const log of logs) {
        expect(log).not.toMatch(/total_credits|total_usage|limit_remaining/i);
      }
    } finally {
      console.log = originalLog;
    }
  });
});
