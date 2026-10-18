/**
 * Matrix runner module exports.
 */

export {
  fetchModelPrices,
  fetchModelPricesWithParams,
  validatePricesForModels,
  calculateCallCost,
  calculateWorstCaseCost,
  createFixturePrices,
  sortModelsByCost,
  fetchCreditInfo,
  calculateModelFullWorstCase,
  calculateModelFullWorstCaseWithCallsPerRun,
  sortModelsByFullWorstCase,
  type CreditCheckResult,
  type PriceDataWithParams,
} from "./prices.js";

export {
  runMatrix,
  getGitSha,
  getGitSha7,
  sanitizeModelId,
  getTodayDate,
  getResultsDir,
  checkGitStatus,
  MAX_COMPLETION_TOKENS,
  MatrixLlmClient,
  type MatrixLlmClientConfig,
  type MatrixRunnerCallbacks,
  type MatrixRunnerOptions,
  type MatrixRunResult,
  type LlmClientFactory,
  type CreditProvider,
  type GitStatus,
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
  type SkippedModel,
  type SkipReason,
  MatrixAbort,
  SUITE_CONFIGS,
  DEFAULT_MODELS,
  DEFAULT_SUITE,
  DEFAULT_RUNS,
  DEFAULT_CAP_USD,
  getDefaultCapUsd,
  getDefaultIMax,
  getDefaultMaxInputTokens,
  getSuiteTasks,
  getSuiteTasksV2,
  getCallsPerRun,
} from "./types.js";

export {
  registerSensitiveValue,
  clearSensitiveValues,
  redactString,
  redactObject,
  redactError,
  safeStringify,
} from "./redact.js";
