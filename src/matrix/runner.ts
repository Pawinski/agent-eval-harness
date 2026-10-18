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
  type LlmClient,
  type LlmCompletionResponse,
} from "../llm/index.js";
import { createDefaultMcpClient } from "../mcp/index.js";
import { runCheck, type SuiteTask } from "../suite/index.js";
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
  MatrixAbort,
  SUITE_CONFIGS,
  getDefaultIMax,
  getDefaultMaxInputTokens,
  getSuiteTasks,
} from "./types.js";
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

  async complete(
    req: Parameters<LlmClient["complete"]>[0],
  ): Promise<LlmCompletionResponse> {
    const { pricing, maxInputTokens, iMax, globalCapUsd, worstCasePerRun } = this.config;
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

    const result = await this.inner.complete(req);
    this.callCount++;

    const promptTokens = result.usage?.promptTokens ?? 0;
    const completionTokens = result.usage?.completionTokens ?? 0;
    const cachedTokens = result.usage?.cachedTokens ?? null;
    const costUsd = calculateCallCost(promptTokens, completionTokens, pricing);
    const empty = isEmptyContent(result.content);

    this.config.onCall({ promptTokens, completionTokens, cachedTokens, costUsd, empty });

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
  taskCount: number,
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

  const worstCasePerRun = calculateWorstCaseCost(
    taskCount * ctx.maxSteps,
    ctx.iMax,
    MAX_COMPLETION_TOKENS,
    ctx.pricing,
  );

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
    };
  }

  const tools = createDefaultMcpClient();
  const baseLlm = createLlmClient({ defaultModel: ctx.model, maxTokens: MAX_COMPLETION_TOKENS });
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
      });
    },
  });

  let finalAnswer = "";
  let steps = 0;

  try {
    const agent = new ReactAgent({
      llm: wrappedLlm,
      tools,
      maxSteps: ctx.maxSteps,
      onLog: (e: ReactLogEntry) => {
        agentLog.push(e);
      },
      expectedTools: task.expectedTools,
    });

    const result = await agent.run(task.prompt);
    finalAnswer = result.finalAnswer;
    steps = result.steps;
  } catch (err) {
    if (err instanceof MatrixAbort) {
      abortReason = err.reason;
    } else {
      hadHttpError = true;
      if (calls.length > 0) {
        calls[calls.length - 1].httpError = true;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const httpMatch = errMsg.match(/HTTP\s*(\d{3})/i);
      if (httpMatch) {
        httpStatus = parseInt(httpMatch[1], 10);
      }
      const codeMatch = errMsg.match(/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET)\b/i);
      if (codeMatch) {
        errorCode = codeMatch[1].toUpperCase();
      }
      if (calls.length > 0) {
        calls[calls.length - 1].httpStatus = httpStatus;
        calls[calls.length - 1].errorCode = errorCode;
      }
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
  };
}

export interface MatrixRunnerCallbacks {
  onRunStart?: (model: string, runN: number) => void;
  onTaskComplete?: (model: string, runN: number, taskId: string, pass: boolean) => void;
  onRunComplete?: (result: RunResult) => void;
  onModelAbort?: (model: string, reason: AbortReason) => void;
  onGlobalAbort?: () => void;
}

export async function runMatrix(
  config: MatrixRunConfig,
  priceData: PriceData,
  callbacks?: MatrixRunnerCallbacks,
): Promise<{ runs: RunResult[]; globalAbort: boolean }> {
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

  const runs: RunResult[] = [];
  let cumulativeCost = 0;
  let globalAbort = false;

  for (const modelId of config.models) {
    const pricing = priceData.models.get(modelId);
    if (!pricing) {
      throw new Error(`Missing pricing for model: ${modelId}`);
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
      };

      let pass = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let tokensCached: number | null = null;
      let costUsd = 0;
      const emptyTasks: string[] = [];
      const allCalls: CallResult[] = [];
      let tasksWithHttpErrors = 0;

      for (const task of tasks) {
        if (modelAbortReason || globalAbort) {
          break;
        }

        const taskResult = await runOneTaskWithTracking(task, ctx, costUsd, taskCount);

        if (taskResult.pass) pass++;
        tokensIn += taskResult.tokensIn;
        tokensOut += taskResult.tokensOut;
        if (taskResult.tokensCached !== null) {
          tokensCached = (tokensCached ?? 0) + taskResult.tokensCached;
        }
        costUsd += taskResult.costUsd;
        allCalls.push(...taskResult.calls);

        if (taskResult.empty) {
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
          } else {
            modelAbortReason = taskResult.abortReason;
          }
        }

        callbacks?.onTaskComplete?.(modelId, runN, task.id, taskResult.pass);
      }

      cumulativeCost += costUsd;

      const emptyCount = allCalls.filter((c) => c.empty).length;

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
      };

      runs.push(runResult);
      callbacks?.onRunComplete?.(runResult);

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
          },
          2,
        ),
        "utf8",
      );
    }

    if (modelAbortReason && modelAbortReason !== "global_cap") {
      callbacks?.onModelAbort?.(modelId, modelAbortReason);
    }
  }

  return { runs, globalAbort };
}
