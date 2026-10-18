/**
 * Types for the multi-model matrix runner.
 */

import { TASKS_V2, type SuiteTask, type SuiteTaskV2 } from "../suite/index.js";

export interface ModelPricing {
  modelId: string;
  promptPrice: number;
  completionPrice: number;
}

export type AbortReason =
  | "cost_exceeded"
  | "completion_tokens_exceeded"
  | "prompt_tokens_exceeded"
  | "http_errors"
  | "global_cap"
  | "skipped_credit"
  | "rate_limited"
  | "provider_error";

export type SkipReason = "credit" | "cap" | "rate_limited";

export interface SkippedModel {
  model: string;
  worstCase: number;
  remaining: number;
  shortfall: number;
  reason: SkipReason;
  retries?: number;
}

export class MatrixAbort extends Error {
  readonly reason: AbortReason;

  constructor(reason: AbortReason, message?: string) {
    super(message ?? `Matrix abort: ${reason}`);
    this.name = "MatrixAbort";
    this.reason = reason;
  }
}

export function getSuiteTasks(version: string): SuiteTask[] {
  if (version === "0.2.0") {
    return TASKS_V2.map((t) => ({
      id: t.id,
      description: t.description,
      prompt: t.prompt,
      expectedTools: t.expectedTools,
      check: t.check,
      fixtureAnswer: t.fixtureAnswer,
    }));
  }
  throw new Error(`Unknown suite version: ${version}`);
}

export function getSuiteTasksV2(version: string): SuiteTaskV2[] {
  if (version === "0.2.0") {
    return TASKS_V2;
  }
  throw new Error(`Suite ${version} does not have v2 task metadata`);
}

/** Get total calls per run using per-task maxSteps for suite 0.2.0, or taskCount × maxSteps for other suites */
export function getCallsPerRun(suite: string): number {
  if (suite === "0.2.0") {
    return TASKS_V2.reduce((sum, t) => sum + (t.maxSteps ?? 8), 0);
  }
  const config = SUITE_CONFIGS[suite];
  if (!config) {
    return 7 * 8; // fallback for 0.1.0
  }
  return config.taskCount * config.maxSteps;
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
  "0.2.0": {
    version: "0.2.0",
    taskCount: 16,
    maxSteps: 12,
    maxInputTokens: 4700,
    defaultCapUsd: 35.0,
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

export const DEFAULT_SUITE = "0.2.0";
export const DEFAULT_RUNS = 3;

export const SUITE_0_1_0_RETIRED_MSG = "Suite 0.1.0 was retired from main; reproduce it at commit e61f639 (see README).";

export function getDefaultMaxInputTokens(maxSteps: number): number {
  if (maxSteps === 12) {
    return 4700;
  }
  return 3750;
}

export function getDefaultIMax(suiteVersion: string, maxSteps: number): number {
  if (suiteVersion === "0.1.0") {
    return 3000;
  }
  if (maxSteps === 12) {
    return 4700;
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
  httpStatus?: number;
  errorCode?: string;
  retries?: number;
  droppedParameters?: string[];
  providerError?: { code?: string; type?: string };
  temperatureSent?: boolean;
}

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
  emptyCount: number;
  calls: CallResult[];
  retries: number;
  /** true/false in live runs (was supported_parameters available from /models); null in fixture mode */
  parametersFetched: boolean | null;
  /** true/false if every call agreed, "mixed" otherwise, null if no call recorded it */
  temperatureSent?: boolean | "mixed" | null;
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
