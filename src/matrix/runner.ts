/**
 * Matrix runner: run eval loop per model and per run, sequentially.
 * Implements abort rules and cost tracking.
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
import { TASKS, runCheck, type SuiteTask } from "../suite/index.js";
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
  SUITE_CONFIGS,
  getDefaultIMax,
  getDefaultMaxInputTokens,
} from "./types.js";
import { redactError, safeStringify } from "./redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const RESULTS_DIR = path.join(ROOT, "results");

const MAX_COMPLETION_TOKENS = 512;

export function getGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000000000000000000000000000000000000";
  }
}

export function getGitSha7(): string {
  return getGitSha().slice(0, 7);
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
  httpErrors: number;
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

function isEmptyAnswer(answer: string): boolean {
  return !answer || !answer.trim();
}

class MatrixLlmClient implements LlmClient {
  private readonly inner: LlmClient;
  private readonly pricing: ModelPricing;
  private readonly onCall: (usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
    costUsd: number;
  }) => void;

  constructor(
    inner: LlmClient,
    pricing: ModelPricing,
    onCall: (usage: {
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number | null;
      costUsd: number;
    }) => void,
  ) {
    this.inner = inner;
    this.pricing = pricing;
    this.onCall = onCall;
  }

  async complete(
    req: Parameters<LlmClient["complete"]>[0],
  ): Promise<LlmCompletionResponse> {
    const result = await this.inner.complete(req);

    const promptTokens = result.usage?.promptTokens ?? 0;
    const completionTokens = result.usage?.completionTokens ?? 0;
    const cachedTokens = result.usage?.cachedTokens ?? null;
    const costUsd = calculateCallCost(promptTokens, completionTokens, this.pricing);

    this.onCall({ promptTokens, completionTokens, cachedTokens, costUsd });

    return result;
  }
}

async function runOneTaskWithTracking(
  task: SuiteTask,
  ctx: RunContext,
  runCostSoFar: number,
): Promise<TaskRunResult> {
  const calls: CallResult[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached: number | null = null;
  let costUsd = 0;
  let httpErrors = 0;
  let abortReason: AbortReason | undefined;

  const worstCasePerRun = calculateWorstCaseCost(
    TASKS.length * ctx.maxSteps,
    ctx.iMax,
    MAX_COMPLETION_TOKENS,
    ctx.pricing,
  );

  if (ctx.fixture) {
    return {
      taskId: task.id,
      pass: true,
      detail: "fixture",
      finalAnswer: task.fixtureAnswer ?? "",
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: null,
      costUsd: 0,
      empty: isEmptyAnswer(task.fixtureAnswer ?? ""),
      httpErrors: 0,
      calls: [],
    };
  }

  const tools = createDefaultMcpClient();
  const baseLlm = createLlmClient({ defaultModel: ctx.model });
  const agentLog: unknown[] = [];

  let callStep = 0;
  const wrappedLlm = new MatrixLlmClient(baseLlm, ctx.pricing, (usage) => {
    callStep++;
    tokensIn += usage.promptTokens;
    tokensOut += usage.completionTokens;
    if (usage.cachedTokens !== null) {
      tokensCached = (tokensCached ?? 0) + usage.cachedTokens;
    }
    costUsd += usage.costUsd;

    calls.push({
      taskId: task.id,
      step: callStep,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        costUsd: usage.costUsd,
      },
      empty: false,
      httpError: false,
    });

    if (usage.completionTokens > MAX_COMPLETION_TOKENS) {
      abortReason = "completion_tokens_exceeded";
    }
    if (usage.promptTokens > ctx.maxInputTokens) {
      abortReason = "prompt_tokens_exceeded";
    }
    if (runCostSoFar + costUsd > worstCasePerRun) {
      abortReason = "cost_exceeded";
    }
    if (
      ctx.globalCapUsd !== undefined &&
      ctx.cumulativeCost + runCostSoFar + costUsd > ctx.globalCapUsd
    ) {
      abortReason = "global_cap";
    }
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
    httpErrors++;
    if (calls.length > 0) {
      calls[calls.length - 1].httpError = true;
    }
    const redacted = redactError(err);
    const msg = redacted.message;
    if (msg.includes("HTTP")) {
      httpErrors++;
    }
  }

  const check = runCheck(finalAnswer, 0, task.check);
  const empty = isEmptyAnswer(finalAnswer);

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
    empty,
    httpErrors,
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
  const suiteConfig = SUITE_CONFIGS[config.suite] ?? {
    version: config.suite,
    taskCount: TASKS.length,
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
      let runHttpErrors = 0;

      for (const task of TASKS) {
        if (modelAbortReason || globalAbort) {
          break;
        }

        if (
          config.capUsd !== undefined &&
          !config.fixture
        ) {
          const nextWorstCase = calculateWorstCaseCost(
            1,
            iMax,
            MAX_COMPLETION_TOKENS,
            pricing,
          );
          if (cumulativeCost + costUsd + nextWorstCase > config.capUsd) {
            globalAbort = true;
            callbacks?.onGlobalAbort?.();
            break;
          }
        }

        const taskResult = await runOneTaskWithTracking(task, ctx, costUsd);

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

        runHttpErrors += taskResult.httpErrors;
        if (runHttpErrors >= 2) {
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

      const runResult: RunResult = {
        model: modelId,
        runN,
        pass,
        total: TASKS.length,
        tokensIn,
        tokensOut,
        tokensCached,
        costUsd,
        abortReason: modelAbortReason,
        emptyTasks,
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
        total: TASKS.length,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        tokens_cached: tokensCached,
        cost_usd: costUsd,
        date: getTodayDate(),
      };

      const resultPath = path.join(
        RESULTS_DIR,
        config.suite,
        `${sha7}-${sanitizeModelId(modelId)}-run${runN}.json`,
      );
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(resultPath, JSON.stringify(resultRow, null, 2), "utf8");

      const metaPath = path.join(
        RESULTS_DIR,
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
