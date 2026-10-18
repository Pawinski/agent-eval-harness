/**
 * Matrix runner: run eval loop per model and per run, sequentially.
 * Implements abort rules and cost tracking with per-call enforcement.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { ReactAgent, type ReactLogEntry } from "../agent/react.js";
import {
  createLlmClient,
  ProviderError,
  RateLimitExhaustedError,
  type LlmClient,
  type LlmCompletionResponse,
  type LlmCallMeta,
} from "../llm/index.js";
import {
  createDefaultMcpClient,
  InProcessMcpClient,
  createToolsV2Context,
  createToolsV2Options,
  type McpToolClient,
} from "../mcp/index.js";
import { runCheck, type SuiteTask, TASKS_V2 } from "../suite/index.js";
import {
  calculateCallCost,
  calculateWorstCaseCost,
  type ModelPricing,
  type PriceData,
} from "./prices.js";
import {
  type AbortReason,
  type CallResult,
  type MatrixRunConfig,
  type ResultRow,
  type RunResult,
  type SkippedModel,
  MatrixAbort,
  SUITE_CONFIGS,
  getDefaultIMax,
  getDefaultMaxInputTokens,
  getSuiteTasks,
  getCallsPerRun,
} from "./types.js";
import { calculateModelFullWorstCaseWithCallsPerRun, type PriceDataWithParams } from "./prices.js";
import { safeStringify } from "./redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const RESULTS_DIR = path.join(ROOT, "results");
const RESULTS_FIXTURE_DIR = path.join(ROOT, "results-fixture");

export const MAX_COMPLETION_TOKENS = 512;

export interface GitStatus {
  sha: string;
  isDirty: boolean;
  error?: string;
}

export function checkGitStatus(): GitStatus {
  let sha: string;
  try {
    sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return { sha: "", isDirty: true, error: "git rev-parse HEAD failed" };
  }

  try {
    const status = execSync("git status --porcelain", { encoding: "utf8" });
    const lines = status.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("?? results/")) return false;
      if (trimmed.startsWith("?? results-fixture/")) return false;
      if (trimmed.includes(" results/")) return false;
      if (trimmed.includes(" results-fixture/")) return false;
      return true;
    });
    return { sha, isDirty: lines.length > 0 };
  } catch {
    return { sha, isDirty: true, error: "git status --porcelain failed" };
  }
}

export function getGitSha(): string {
  const status = checkGitStatus();
  return status.sha || "0000000000000000000000000000000000000000";
}

export function getGitSha7(): string {
  return getGitSha().slice(0, 7);
}

export function getResultsDir(fixture: boolean): string {
  return fixture ? RESULTS_FIXTURE_DIR : RESULTS_DIR;
}

function isEmptyContent(content: string): boolean {
  return !content || !content.trim();
}

function isMaxStepsExceeded(answer: string): boolean {
  return answer === "(max steps exceeded)";
}

function getTaskMaxSteps(task: SuiteTask, suite: string, suiteMaxSteps: number): number {
  if (suite === "0.2.0") {
    const v2Task = TASKS_V2.find((t) => t.id === task.id);
    if (v2Task?.maxSteps) {
      return Math.min(v2Task.maxSteps, 12);
    }
  }
  return suiteMaxSteps;
}

export function sanitizeModelId(modelId: string): string {
  return modelId.replace(/\//g, "__");
}

export function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

interface TaskRunResult {
  taskId: string;
  pass: boolean;
  detail: string;
  finalAnswer: string;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number | null;
  costUsd: number;
  empty: boolean;
  hadHttpError: boolean;
  calls: CallResult[];
  abortReason?: AbortReason;
  retries: number;
  rateLimitExhausted?: boolean;
  providerError?: { code?: string; type?: string };
}

interface RunContext {
  model: string;
  runN: number;
  pricing: ModelPricing;
  maxSteps: number;
  maxInputTokens: number;
  iMax: number;
  cumulativeCost: number;
  globalCapUsd?: number;
  fixture: boolean;
  suite: string;
  toolsFactory?: () => McpToolClient;
  maxObservationChars?: number;
  supportedParameters?: Map<string, Set<string>>;
}

export interface MatrixLlmClientConfig {
  pricing: ModelPricing;
  maxInputTokens: number;
  iMax: number;
  globalCapUsd?: number;
  worstCasePerRun: number;
  getCumulativeCost: () => number;
  getRunCostSoFar: () => number;
  getTaskCostSoFar: () => number;
  onCall: (usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
    costUsd: number;
    empty: boolean;
    _meta?: LlmCallMeta;
  }) => void;
}

export class MatrixLlmClient implements LlmClient {
  private readonly inner: LlmClient;
  private readonly config: MatrixLlmClientConfig;
  public callCount = 0;

  constructor(inner: LlmClient, config: MatrixLlmClientConfig) {
    this.inner = inner;
    this.config = config;
  }

  /** Global-cap and per-run worst-case checks. Runs before every call AND before every 429 retry. */
  checkBudget(): void {
    const { pricing, iMax, globalCapUsd, worstCasePerRun } = this.config;
    const cumulativeCost = this.config.getCumulativeCost();
    const runCostSoFar = this.config.getRunCostSoFar();
    const taskCostSoFar = this.config.getTaskCostSoFar();

    const oneCallWorstCase = calculateWorstCaseCost(1, iMax, MAX_COMPLETION_TOKENS, pricing);

    if (globalCapUsd !== undefined) {
      const projectedTotal = cumulativeCost + runCostSoFar + taskCostSoFar + oneCallWorstCase;
      if (projectedTotal > globalCapUsd) {
        throw new MatrixAbort("global_cap", `Global cap would be exceeded: $${projectedTotal.toFixed(6)} > $${globalCapUsd}`);
      }
    }

    const projectedRunCost = runCostSoFar + taskCostSoFar + oneCallWorstCase;
    if (projectedRunCost > worstCasePerRun) {
      throw new MatrixAbort("cost_exceeded", `Run cost would exceed worst case: $${projectedRunCost.toFixed(6)} > $${worstCasePerRun.toFixed(6)}`);
    }
  }

  async complete(
    req: Parameters<LlmClient["complete"]>[0],
  ): Promise<LlmCompletionResponse> {
    this.checkBudget();
    const { pricing, maxInputTokens } = this.config;
    const result = await this.inner.complete(req);
    this.callCount++;

    const promptTokens = result.usage?.promptTokens ?? 0;
    const completionTokens = result.usage?.completionTokens ?? 0;
    const cachedTokens = result.usage?.cachedTokens ?? null;
    const costUsd = calculateCallCost(promptTokens, completionTokens, pricing);
    const empty = isEmptyContent(result.content);

    this.config.onCall({ promptTokens, completionTokens, cachedTokens, costUsd, empty, _meta: result._meta });

    if (completionTokens > MAX_COMPLETION_TOKENS) {
      throw new MatrixAbort("completion_tokens_exceeded", `Completion tokens exceeded: ${completionTokens} > ${MAX_COMPLETION_TOKENS}`);
    }

    if (promptTokens > maxInputTokens) {
      throw new MatrixAbort("prompt_tokens_exceeded", `Prompt tokens exceeded: ${promptTokens} > ${maxInputTokens}`);
    }

    return result;
  }
}

async function runOneTaskWithTracking(
  task: SuiteTask,
  ctx: RunContext,
  runCostSoFar: number,
  llmClientFactory?: LlmClientFactory,
): Promise<TaskRunResult> {
  const calls: CallResult[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached: number | null = null;
  let costUsd = 0;
  let hadHttpError = false;
  let httpStatus: number | undefined;
  let errorCode: string | undefined;
  let abortReason: AbortReason | undefined;
  let allCallsEmpty = true;
  let totalRetries = 0;
  let rateLimitExhausted = false;
  let providerError: { code?: string; type?: string } | undefined;

  const callsPerRunForTask = getCallsPerRun(ctx.suite);
  const worstCasePerRun = calculateWorstCaseCost(
    callsPerRunForTask,
    ctx.iMax,
    MAX_COMPLETION_TOKENS,
    ctx.pricing,
  );

  const taskMaxSteps = getTaskMaxSteps(task, ctx.suite, ctx.maxSteps);

  if (ctx.fixture) {
    const fixtureAnswer = task.fixtureAnswer ?? "";
    const check = runCheck(fixtureAnswer, 0, task.check);
    const isEmpty = isEmptyContent(fixtureAnswer);
    return {
      taskId: task.id,
      pass: check.pass,
      detail: check.detail,
      finalAnswer: fixtureAnswer,
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: null,
      costUsd: 0,
      empty: isEmpty,
      hadHttpError: false,
      calls: [],
      retries: 0,
    };
  }

  const tools = ctx.toolsFactory ? ctx.toolsFactory() : createDefaultMcpClient();
  // Late-bound so every 429 retry in the production client goes through the same budget check.
  let budgetRef: MatrixLlmClient | undefined;
  const baseLlm = llmClientFactory
    ? llmClientFactory(ctx.model, MAX_COMPLETION_TOKENS)
    : createLlmClient({
        defaultModel: ctx.model,
        maxTokens: MAX_COMPLETION_TOKENS,
        supportedParameters: ctx.supportedParameters,
        retryConfig: { preRetryCheck: () => budgetRef?.checkBudget() },
      });
  const agentLog: unknown[] = [];

  let callStep = 0;
  const wrappedLlm = new MatrixLlmClient(baseLlm, {
    pricing: ctx.pricing,
    maxInputTokens: ctx.maxInputTokens,
    iMax: ctx.iMax,
    globalCapUsd: ctx.globalCapUsd,
    worstCasePerRun,
    getCumulativeCost: () => ctx.cumulativeCost,
    getRunCostSoFar: () => runCostSoFar,
    getTaskCostSoFar: () => costUsd,
    onCall: (usage) => {
      callStep++;
      tokensIn += usage.promptTokens;
      tokensOut += usage.completionTokens;
      if (usage.cachedTokens !== null) {
        tokensCached = (tokensCached ?? 0) + usage.cachedTokens;
      }
      costUsd += usage.costUsd;

      if (!usage.empty) {
        allCallsEmpty = false;
      }

      const callRetries = usage._meta?.retries ?? 0;
      totalRetries += callRetries;

      calls.push({
        taskId: task.id,
        step: callStep,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          costUsd: usage.costUsd,
        },
        empty: usage.empty,
        httpError: false,
        retries: callRetries > 0 ? callRetries : undefined,
        droppedParameters: usage._meta?.droppedParameters,
        providerError: usage._meta?.providerError,
      });
    },
  });
  budgetRef = wrappedLlm;

  let finalAnswer = "";
  let steps = 0;

  try {
    const agent = new ReactAgent({
      llm: wrappedLlm,
      tools,
      maxSteps: taskMaxSteps,
      onLog: (e: ReactLogEntry) => {
        agentLog.push(e);
      },
      expectedTools: task.expectedTools,
      maxObservationChars: ctx.maxObservationChars,
    });

    const result = await agent.run(task.prompt);
    finalAnswer = result.finalAnswer;
    steps = result.steps;
  } catch (err) {
    if (err instanceof MatrixAbort) {
      abortReason = err.reason;
    } else if (err instanceof RateLimitExhaustedError) {
      rateLimitExhausted = true;
      abortReason = "rate_limited";
      totalRetries += err.retries;
      callStep++;
      calls.push({
        taskId: task.id,
        step: callStep,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: null,
          costUsd: 0,
        },
        empty: false,
        httpError: false,
        retries: err.retries,
      });
    } else if (err instanceof ProviderError) {
      // HTTP-class: counts toward the 2-task HTTP abort rule, not Empty, and does not abort on its own.
      providerError = { code: err.code, type: err.type };
      hadHttpError = true;
      errorCode = err.code ?? err.type ?? "provider_error";
      callStep++;
      calls.push({
        taskId: task.id,
        step: callStep,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: null,
          costUsd: 0,
        },
        empty: false,
        httpError: true,
        errorCode,
        providerError: { code: err.code, type: err.type },
      });
    } else {
      hadHttpError = true;
      const errMsg = err instanceof Error ? err.message : String(err);
      const httpMatch = errMsg.match(/HTTP\s*(\d{3})/i);
      if (httpMatch) {
        httpStatus = parseInt(httpMatch[1], 10);
      }
      const codeMatch = errMsg.match(/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET)\b/i);
      if (codeMatch) {
        errorCode = codeMatch[1].toUpperCase();
      }
      callStep++;
      calls.push({
        taskId: task.id,
        step: callStep,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: null,
          costUsd: 0,
        },
        empty: false,
        httpError: true,
        httpStatus,
        errorCode,
      });
    }
  }

  const check = runCheck(finalAnswer, 0, task.check);
  const isTaskEmpty = (calls.length > 0 && allCallsEmpty) || isMaxStepsExceeded(finalAnswer) || isEmptyContent(finalAnswer);

  return {
    taskId: task.id,
    pass: check.pass,
    detail: check.detail,
    finalAnswer,
    steps,
    tokensIn,
    tokensOut,
    tokensCached,
    costUsd,
    empty: isTaskEmpty,
    hadHttpError,
    calls,
    abortReason,
    retries: totalRetries,
    rateLimitExhausted,
    providerError,
  };
}

import type { SkipReason } from "./types.js";

export interface MatrixRunnerCallbacks {
  onRunStart?: (model: string, runN: number) => void;
  onTaskComplete?: (model: string, runN: number, taskId: string, pass: boolean) => void;
  onRunComplete?: (result: RunResult) => void;
  onModelAbort?: (model: string, reason: AbortReason) => void;
  onModelSkipped?: (model: string, worstCase: number, remaining: number, shortfall: number, reason: SkipReason, retries?: number) => void;
  onGlobalAbort?: () => void;
}

export interface LlmClientFactory {
  (model: string, maxTokens: number): LlmClient;
}

export interface CreditProvider {
  (cumulativeSpend: number): Promise<number | null>;
}

export interface MatrixRunnerOptions {
  callbacks?: MatrixRunnerCallbacks;
  llmClientFactory?: LlmClientFactory;
  skipFileWrites?: boolean;
  creditProvider?: CreditProvider;
}

export interface MatrixRunResult {
  runs: RunResult[];
  globalAbort: boolean;
  skippedModels: SkippedModel[];
  creditTopUp: number;
  capShortfall: number;
}

export async function runMatrix(
  config: MatrixRunConfig,
  priceData: PriceData,
  options?: MatrixRunnerOptions,
): Promise<MatrixRunResult> {
  const callbacks = options?.callbacks;
  const llmClientFactory = options?.llmClientFactory;
  const skipFileWrites = options?.skipFileWrites ?? false;
  const creditProvider = options?.creditProvider;
  const sha = getGitSha();
  const sha7 = getGitSha7();

  const tasks = getSuiteTasks(config.suite);
  const taskCount = tasks.length;

  const suiteConfig = SUITE_CONFIGS[config.suite] ?? {
    version: config.suite,
    taskCount,
    maxSteps: 8,
    maxInputTokens: getDefaultMaxInputTokens(8),
  };

  const maxSteps = suiteConfig.maxSteps;
  const maxInputTokens = suiteConfig.maxInputTokens;
  const iMax = getDefaultIMax(config.suite, maxSteps);

  let toolsFactory: (() => McpToolClient) | undefined;
  let maxObservationChars: number | undefined;

  if (config.suite === "0.2.0") {
    toolsFactory = () => {
      const v2Ctx = createToolsV2Context();
      return new InProcessMcpClient(createToolsV2Options(v2Ctx));
    };
    maxObservationChars = 4096;
  }

  const runs: RunResult[] = [];
  const skippedModels: SkippedModel[] = [];
  let cumulativeCost = 0;
  let globalAbort = false;

  const callsPerRun = getCallsPerRun(config.suite);
  const paramData = priceData as Partial<PriceDataWithParams>;
  const supportedParameters = config.fixture ? undefined : paramData.supportedParameters;
  const parametersFetched: boolean | null = config.fixture ? null : paramData.parametersFetched === true;

  for (const modelId of config.models) {
    const pricing = priceData.models.get(modelId);
    if (!pricing) {
      throw new Error(`Missing pricing for model: ${modelId}`);
    }

    const modelFullWorstCase = calculateModelFullWorstCaseWithCallsPerRun(
      config.runs,
      callsPerRun,
      iMax,
      pricing,
    );

    if (creditProvider && !config.fixture) {
      const startingCredit = await creditProvider(cumulativeCost);
      const remainingCredit = startingCredit !== null ? startingCredit - cumulativeCost : null;
      const remainingCap = (config.capUsd ?? Infinity) - cumulativeCost;

      let remaining: number;
      let reason: SkipReason;
      if (remainingCredit !== null && remainingCredit <= remainingCap) {
        remaining = remainingCredit;
        reason = "credit";
      } else {
        remaining = remainingCap;
        reason = "cap";
      }

      if (remaining < modelFullWorstCase) {
        const shortfall = modelFullWorstCase - remaining;
        skippedModels.push({ model: modelId, worstCase: modelFullWorstCase, remaining, shortfall, reason });
        callbacks?.onModelSkipped?.(modelId, modelFullWorstCase, remaining, shortfall, reason);
        continue;
      }
    }

    let modelAbortReason: AbortReason | undefined;

    for (let runN = 1; runN <= config.runs; runN++) {
      if (globalAbort || modelAbortReason) {
        break;
      }

      callbacks?.onRunStart?.(modelId, runN);

      const ctx: RunContext = {
        model: modelId,
        runN,
        pricing,
        maxSteps,
        maxInputTokens,
        iMax,
        cumulativeCost,
        globalCapUsd: config.capUsd,
        fixture: config.fixture,
        suite: config.suite,
        toolsFactory,
        maxObservationChars,
        supportedParameters,
      };

      let pass = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let tokensCached: number | null = null;
      let costUsd = 0;
      const emptyTasks: string[] = [];
      const allCalls: CallResult[] = [];
      let tasksWithHttpErrors = 0;
      let totalRetries = 0;

      for (const task of tasks) {
        if (modelAbortReason || globalAbort) {
          break;
        }

        const taskResult = await runOneTaskWithTracking(task, ctx, costUsd, llmClientFactory);

        if (taskResult.pass) pass++;
        tokensIn += taskResult.tokensIn;
        tokensOut += taskResult.tokensOut;
        if (taskResult.tokensCached !== null) {
          tokensCached = (tokensCached ?? 0) + taskResult.tokensCached;
        }
        costUsd += taskResult.costUsd;
        allCalls.push(...taskResult.calls);
        totalRetries += taskResult.retries;

        if (taskResult.empty && !taskResult.hadHttpError) {
          emptyTasks.push(task.id);
        }

        if (taskResult.hadHttpError) {
          tasksWithHttpErrors++;
        }
        if (tasksWithHttpErrors >= 2) {
          modelAbortReason = "http_errors";
        }

        if (taskResult.abortReason) {
          if (taskResult.abortReason === "global_cap") {
            globalAbort = true;
            callbacks?.onGlobalAbort?.();
          } else if (taskResult.abortReason === "rate_limited") {
            modelAbortReason = "rate_limited";
            skippedModels.push({
              model: modelId,
              worstCase: modelFullWorstCase,
              remaining: (config.capUsd ?? Infinity) - cumulativeCost,
              shortfall: 0,
              reason: "rate_limited",
              retries: taskResult.retries,
            });
            callbacks?.onModelSkipped?.(modelId, modelFullWorstCase, 0, 0, "rate_limited", taskResult.retries);
          } else {
            modelAbortReason = taskResult.abortReason;
          }
        }

        callbacks?.onTaskComplete?.(modelId, runN, task.id, taskResult.pass);
      }

      cumulativeCost += costUsd;

      const emptyCount = emptyTasks.length;

      const runResult: RunResult = {
        model: modelId,
        runN,
        pass,
        total: taskCount,
        tokensIn,
        tokensOut,
        tokensCached,
        costUsd,
        abortReason: modelAbortReason,
        emptyTasks,
        emptyCount,
        calls: allCalls,
        retries: totalRetries,
        parametersFetched,
      };

      runs.push(runResult);
      callbacks?.onRunComplete?.(runResult);

      if (!skipFileWrites) {
        const resultRow: ResultRow = {
          sha,
          suite: config.suite,
          model: modelId,
          run_n: runN,
          pass,
          total: taskCount,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          tokens_cached: tokensCached,
          cost_usd: costUsd,
          date: getTodayDate(),
        };

        const resultsDir = getResultsDir(config.fixture);
        const resultPath = path.join(
          resultsDir,
          config.suite,
          `${sha7}-${sanitizeModelId(modelId)}-run${runN}.json`,
        );
        await mkdir(path.dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify(resultRow, null, 2), "utf8");

        const metaPath = path.join(
          resultsDir,
          config.suite,
          "_meta",
          `${sha7}-${sanitizeModelId(modelId)}-run${runN}.json`,
        );
        await mkdir(path.dirname(metaPath), { recursive: true });
        await writeFile(
          metaPath,
          safeStringify(
            {
              sha,
              suite: config.suite,
              model: modelId,
              run_n: runN,
              pricesFetchedAt: priceData.fetchedAt,
              pricing: {
                promptPrice: pricing.promptPrice,
                completionPrice: pricing.completionPrice,
              },
              emptyTasks,
              emptyCount,
              abortReason: modelAbortReason,
              calls: allCalls,
              retries: totalRetries,
              parametersFetched,
            },
            2,
          ),
          "utf8",
        );
      }
    }

    if (modelAbortReason && modelAbortReason !== "global_cap") {
      callbacks?.onModelAbort?.(modelId, modelAbortReason);
    }
  }

  // Top-up / shortfall calculation:
  // Sum of skipped worst cases minus the final remaining (at time of last skip), floored at 0
  // Separate by reason: credit-bound skips -> creditTopUp, cap-bound skips -> capShortfall
  const creditSkipped = skippedModels.filter((m) => m.reason === "credit");
  const capSkipped = skippedModels.filter((m) => m.reason === "cap");

  const creditTopUp = creditSkipped.length > 0
    ? Math.max(0, creditSkipped.reduce((sum, m) => sum + m.worstCase, 0) - creditSkipped[creditSkipped.length - 1].remaining)
    : 0;
  const capShortfall = capSkipped.length > 0
    ? Math.max(0, capSkipped.reduce((sum, m) => sum + m.worstCase, 0) - capSkipped[capSkipped.length - 1].remaining)
    : 0;

  return { runs, globalAbort, skippedModels, creditTopUp, capShortfall };
}
