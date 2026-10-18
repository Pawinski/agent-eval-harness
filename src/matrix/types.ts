/**
 * Types for the multi-model matrix runner.
 */

export interface ModelPricing {
  modelId: string;
  promptPrice: number;
  completionPrice: number;
}

export interface PriceData {
  fetchedAt: string;
  models: Map<string, ModelPricing>;
}

export interface SuiteConfig {
  version: string;
  taskCount: number;
  maxSteps: number;
  maxInputTokens: number;
  defaultCapUsd: number;
}

export const SUITE_CONFIGS: Record<string, SuiteConfig> = {
  "0.1.0": {
    version: "0.1.0",
    taskCount: 7,
    maxSteps: 8,
    maxInputTokens: 3000,
    defaultCapUsd: 10.0,
  },
};

export const DEFAULT_CAP_USD: Record<string, number> = {
  "0.1.0": 10.0,
  "0.2.0": 35.0,
};

export const DEFAULT_MODELS = [
  "nex-agi/nex-n2.5-pro",
  "openai/gpt-4o-mini",
  "anthropic/claude-haiku-5.5",
  "mistralai/mistral-large-2512",
  "openai/gpt-6.1-sol",
  "anthropic/claude-opus-5.5",
];

export const DEFAULT_SUITE = "0.1.0";
export const DEFAULT_RUNS = 3;

export function getDefaultMaxInputTokens(maxSteps: number): number {
  if (maxSteps === 12) {
    return 4700;
  }
  return 3750;
}

export function getDefaultIMax(suiteVersion: string, maxSteps: number): number {
  if (suiteVersion === "0.1.0") {
    return 2410;
  }
  if (maxSteps === 12) {
    return 3750;
  }
  return 3750;
}

export function getDefaultCapUsd(suiteVersion: string): number {
  return DEFAULT_CAP_USD[suiteVersion] ?? 10.0;
}

export interface MatrixRunConfig {
  suite: string;
  models: string[];
  runs: number;
  capUsd?: number;
  fixture: boolean;
}

export interface CallUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  costUsd: number;
}

export interface CallResult {
  taskId: string;
  step: number;
  usage: CallUsage;
  empty: boolean;
  httpError: boolean;
}

export type AbortReason =
  | "cost_exceeded"
  | "completion_tokens_exceeded"
  | "prompt_tokens_exceeded"
  | "http_errors"
  | "global_cap";

export interface RunResult {
  model: string;
  runN: number;
  pass: number;
  total: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number | null;
  costUsd: number;
  abortReason?: AbortReason;
  emptyTasks: string[];
  calls: CallResult[];
}

export interface MatrixResult {
  sha: string;
  suite: string;
  priceData: PriceData;
  runs: RunResult[];
  globalAbort: boolean;
}

export interface ResultRow {
  sha: string;
  suite: string;
  model: string;
  run_n: number;
  pass: number;
  total: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number | null;
  cost_usd: number;
  date: string;
}
