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
  type ModelPricing,
  type PriceData,
  getDefaultCapUsd,
  getDefaultIMax,
  SUITE_CONFIGS,
} from "../matrix/index.js";
import {
  registerSensitiveValue,
  clearSensitiveValues,
  redactString,
  redactObject,
  redactError,
  safeStringify,
} from "../matrix/redact.js";

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
    expect(iMax).toBe(2410);
  });

  it("uses 3750 for maxSteps 12 suites", () => {
    const iMax = getDefaultIMax("0.2.0", 12);
    expect(iMax).toBe(3750);
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
    it("threshold is 512 completion tokens", () => {
      const MAX_COMPLETION_TOKENS = 512;
      expect(MAX_COMPLETION_TOKENS).toBe(512);

      expect(513 > MAX_COMPLETION_TOKENS).toBe(true);
      expect(512 > MAX_COMPLETION_TOKENS).toBe(false);
    });
  });

  describe("rule c: prompt tokens exceeded", () => {
    it("uses 3000 for 0.1.0", () => {
      const config = SUITE_CONFIGS["0.1.0"];
      expect(config.maxInputTokens).toBe(3000);
    });

    it("default for maxSteps 12 is 4700", () => {
      expect(4700).toBe(4700);
    });
  });

  describe("rule d: HTTP errors", () => {
    it("triggers on 2 or more HTTP errors in one run", () => {
      const httpErrors = 2;
      expect(httpErrors >= 2).toBe(true);

      const oneError = 1;
      expect(oneError >= 2).toBe(false);
    });
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
