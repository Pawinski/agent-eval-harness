/**
 * Tests for the configuration system.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  getConfig,
  resetConfigCache,
  parseRetryDelays,
  DEFAULT_CONFIG,
} from "../config/index.js";

describe("config", () => {
  describe("DEFAULT_CONFIG", () => {
    it("has expected LLM defaults", () => {
      expect(DEFAULT_CONFIG.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(DEFAULT_CONFIG.llm.defaultModel).toBe("openai/gpt-4o-mini");
      expect(DEFAULT_CONFIG.llm.maxCompletionTokens).toBe(512);
      expect(DEFAULT_CONFIG.llm.cacheBreakpoint).toBe(false);
    });

    it("has expected retry defaults", () => {
      expect(DEFAULT_CONFIG.retry.delays).toEqual([15_000, 60_000, 180_000]);
    });

    it("has expected agent defaults", () => {
      expect(DEFAULT_CONFIG.agent.defaultMaxSteps).toBe(8);
      expect(DEFAULT_CONFIG.agent.maxInputTokens).toBe(4700);
      expect(DEFAULT_CONFIG.agent.maxObservationChars).toBe(4096);
    });

    it("has expected sandbox defaults", () => {
      expect(DEFAULT_CONFIG.sandbox.childTimeoutMs).toBe(2000);
      expect(DEFAULT_CONFIG.sandbox.preludeTimeoutMs).toBe(50);
      expect(DEFAULT_CONFIG.sandbox.functionTimeoutMs).toBe(50);
      expect(DEFAULT_CONFIG.sandbox.callTimeoutMs).toBe(100);
      expect(DEFAULT_CONFIG.sandbox.permissionProbeTimeoutMs).toBe(5000);
    });

    it("has expected matrix defaults", () => {
      expect(DEFAULT_CONFIG.matrix.defaultSuite).toBe("0.2.0");
      expect(DEFAULT_CONFIG.matrix.defaultRuns).toBe(3);
      expect(DEFAULT_CONFIG.matrix.defaultCapUsd).toBe(35);
      expect(DEFAULT_CONFIG.matrix.defaultModels).toContain("openai/gpt-4o-mini");
      expect(DEFAULT_CONFIG.matrix.defaultModels.length).toBe(6);
    });
  });

  describe("parseRetryDelays", () => {
    it("parses valid comma-separated integers", () => {
      expect(parseRetryDelays("1000,2000,3000")).toEqual([1000, 2000, 3000]);
    });

    it("handles single value", () => {
      expect(parseRetryDelays("5000")).toEqual([5000]);
    });

    it("trims whitespace", () => {
      expect(parseRetryDelays(" 1000 , 2000 , 3000 ")).toEqual([1000, 2000, 3000]);
    });

    it("rejects empty string", () => {
      expect(parseRetryDelays("")).toBeNull();
    });

    it("rejects zero", () => {
      expect(parseRetryDelays("0,1000")).toBeNull();
    });

    it("rejects negative numbers", () => {
      expect(parseRetryDelays("-1000,2000")).toBeNull();
    });

    it("rejects decimals", () => {
      expect(parseRetryDelays("1000.5,2000")).toBeNull();
    });

    it("rejects scientific notation", () => {
      expect(parseRetryDelays("1e3,2000")).toBeNull();
    });

    it("rejects empty pieces", () => {
      expect(parseRetryDelays("1000,,2000")).toBeNull();
      expect(parseRetryDelays(",1000")).toBeNull();
      expect(parseRetryDelays("1000,")).toBeNull();
    });

    it("rejects non-numeric values", () => {
      expect(parseRetryDelays("abc,2000")).toBeNull();
    });
  });

  describe("loadConfig", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = path.join(tmpdir(), `eval-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(testDir, { recursive: true });
      resetConfigCache();
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
      resetConfigCache();
    });

    it("returns defaults when no config file or env vars", () => {
      const config = loadConfig({ cwd: testDir, env: {} });
      expect(config.llm.maxCompletionTokens).toBe(512);
      expect(config.matrix.defaultSuite).toBe("0.2.0");
    });

    it("loads config from JSON file", () => {
      const configPath = path.join(testDir, "eval.config.json");
      writeFileSync(configPath, JSON.stringify({
        llm: {
          defaultModel: "anthropic/claude-3-opus",
          maxCompletionTokens: 1024,
        },
        matrix: {
          defaultRuns: 5,
        },
      }));

      const config = loadConfig({ cwd: testDir, env: {} });
      expect(config.llm.defaultModel).toBe("anthropic/claude-3-opus");
      expect(config.llm.maxCompletionTokens).toBe(1024);
      expect(config.matrix.defaultRuns).toBe(5);
      expect(config.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    });

    it("env vars override file config", () => {
      const configPath = path.join(testDir, "eval.config.json");
      writeFileSync(configPath, JSON.stringify({
        llm: {
          defaultModel: "from-file",
        },
      }));

      const config = loadConfig({
        cwd: testDir,
        env: {
          MODEL: "from-env",
        },
      });
      expect(config.llm.defaultModel).toBe("from-env");
    });

    it("CLI overrides override env vars", () => {
      const config = loadConfig({
        cwd: testDir,
        env: {
          MODEL: "from-env",
        },
        cliOverrides: {
          llm: {
            defaultModel: "from-cli",
          },
        },
      });
      expect(config.llm.defaultModel).toBe("from-cli");
    });

    it("parses RETRY_DELAYS_MS from env", () => {
      const config = loadConfig({
        cwd: testDir,
        env: {
          RETRY_DELAYS_MS: "5000,10000",
        },
      });
      expect(config.retry.delays).toEqual([5000, 10000]);
    });

    it("parses MAX_TOKENS from env", () => {
      const config = loadConfig({
        cwd: testDir,
        env: {
          MAX_TOKENS: "256",
        },
      });
      expect(config.llm.maxCompletionTokens).toBe(256);
    });

    it("parses AGENT_EVAL_CACHE_BREAKPOINT=1 as true", () => {
      const config = loadConfig({
        cwd: testDir,
        env: {
          AGENT_EVAL_CACHE_BREAKPOINT: "1",
        },
      });
      expect(config.llm.cacheBreakpoint).toBe(true);
    });

    it("parses AGENT_EVAL_CACHE_BREAKPOINT=true as true", () => {
      const config = loadConfig({
        cwd: testDir,
        env: {
          AGENT_EVAL_CACHE_BREAKPOINT: "true",
        },
      });
      expect(config.llm.cacheBreakpoint).toBe(true);
    });

    it("uses explicit configPath over search", () => {
      const explicitPath = path.join(testDir, "custom.json");
      writeFileSync(explicitPath, JSON.stringify({
        matrix: { defaultRuns: 99 },
      }));

      const config = loadConfig({
        cwd: testDir,
        env: {},
        configPath: explicitPath,
      });
      expect(config.matrix.defaultRuns).toBe(99);
    });

    it("deep merges nested config", () => {
      const configPath = path.join(testDir, "eval.config.json");
      writeFileSync(configPath, JSON.stringify({
        llm: {
          defaultModel: "custom-model",
        },
      }));

      const config = loadConfig({ cwd: testDir, env: {} });
      expect(config.llm.defaultModel).toBe("custom-model");
      expect(config.llm.maxCompletionTokens).toBe(512);
      expect(config.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    });
  });

  describe("getConfig", () => {
    beforeEach(() => {
      resetConfigCache();
    });

    afterEach(() => {
      resetConfigCache();
    });

    it("caches config when called without options", () => {
      const config1 = getConfig();
      const config2 = getConfig();
      expect(config2).toBe(config1);
    });

    it("does not use cache when options provided", () => {
      const config1 = getConfig();
      const config2 = getConfig({ env: { MODEL: "different-model" } });
      expect(config2.llm.defaultModel).toBe("different-model");
      expect(config1.llm.defaultModel).not.toBe(config2.llm.defaultModel);
    });
  });
});
