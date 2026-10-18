/**
 * Matrix runner module exports.
 */

export {
  fetchModelPrices,
  validatePricesForModels,
  calculateCallCost,
  calculateWorstCaseCost,
  createFixturePrices,
  sortModelsByCost,
} from "./prices.js";

export {
  runMatrix,
  getGitSha,
  getGitSha7,
  sanitizeModelId,
  getTodayDate,
  type MatrixRunnerCallbacks,
} from "./runner.js";

export {
  type ModelPricing,
  type PriceData,
  type SuiteConfig,
  type MatrixRunConfig,
  type CallUsage,
  type CallResult,
  type AbortReason,
  type RunResult,
  type ResultRow,
  SUITE_CONFIGS,
  DEFAULT_MODELS,
  DEFAULT_SUITE,
  DEFAULT_RUNS,
  DEFAULT_CAP_USD,
  getDefaultCapUsd,
  getDefaultIMax,
  getDefaultMaxInputTokens,
} from "./types.js";

export {
  registerSensitiveValue,
  clearSensitiveValues,
  redactString,
  redactObject,
  redactError,
  safeStringify,
} from "./redact.js";
