/**
 * Default configuration values.
 * All magic numbers from the codebase are centralized here.
 */

import type { EvalConfig } from "./types.js";

export const DEFAULT_CONFIG: EvalConfig = {
  llm: {
    apiKey: undefined,
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    maxCompletionTokens: 512,
    cacheBreakpoint: false,
  },

  retry: {
    delays: [15_000, 60_000, 180_000],
  },

  agent: {
    defaultMaxSteps: 8,
    maxInputTokens: 4700,
    maxObservationChars: 4096,
  },

  sandbox: {
    childTimeoutMs: 2000,
    preludeTimeoutMs: 50,
    functionTimeoutMs: 50,
    callTimeoutMs: 100,
    permissionProbeTimeoutMs: 5000,
  },

  matrix: {
    defaultSuite: "0.2.0",
    defaultRuns: 3,
    defaultCapUsd: 35,
    defaultModels: [
      "nex-agi/nex-n2.5-pro",
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku-5.5",
      "mistralai/mistral-large-2512",
      "openai/gpt-6.1-sol",
      "anthropic/claude-opus-5.5",
    ],
  },
};

export const ENV_VAR_MAP = {
  "llm.apiKey": "OPENROUTER_API_KEY",
  "llm.baseUrl": "OPENROUTER_BASE_URL",
  "llm.defaultModel": "MODEL",
  "llm.maxCompletionTokens": "MAX_TOKENS",
  "llm.cacheBreakpoint": "AGENT_EVAL_CACHE_BREAKPOINT",
  "retry.delays": "RETRY_DELAYS_MS",
} as const;

export type EnvVarPath = keyof typeof ENV_VAR_MAP;
