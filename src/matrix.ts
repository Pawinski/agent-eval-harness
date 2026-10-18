/**
 * CLI: multi-model matrix runner with cost caps.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... npm run matrix
 *   OPENROUTER_API_KEY=... npm run matrix -- --suite 0.2.0
 *   npm run matrix -- --fixture
 */

import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  fetchModelPrices,
  validatePricesForModels,
  createFixturePrices,
  sortModelsByFullWorstCase,
  runMatrix,
  getGitSha7,
  getTodayDate,
  sanitizeModelId,
  getResultsDir,
  checkGitStatus,
  registerSensitiveValue,
  redactError,
  safeStringify,
  fetchCreditInfo,
  getDefaultIMax,
  DEFAULT_MODELS,
  DEFAULT_SUITE,
  DEFAULT_RUNS,
  SUITE_CONFIGS,
  getDefaultCapUsd,
  getSuiteTasks,
  MAX_COMPLETION_TOKENS,
  type RunResult,
  type PriceData,
  type GitStatus,
  type LlmClientFactory,
  type CreditProvider,
  type SkippedModel,
} from "./matrix/index.js";

interface CliArgs {
  suite: string;
  models: string[];
  runs: number;
  capUsd?: number;
  creditUsd?: number;
  fixture: boolean;
  help: boolean;
}

interface ParsedCliArgs extends CliArgs {
  errors: string[];
}

export function parseArgs(argv: string[]): ParsedCliArgs {
  const args: ParsedCliArgs = {
    suite: DEFAULT_SUITE,
    models: [...DEFAULT_MODELS],
    runs: DEFAULT_RUNS,
    fixture: false,
    help: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture" || a === "-f") {
      args.fixture = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--suite" || a === "-s") {
      const val = argv[++i];
      if (val === undefined || val.startsWith("-")) {
        args.errors.push("--suite requires a value");
        i--;
      } else {
        args.suite = val;
      }
    } else if (a === "--models" || a === "-m") {
      const val = argv[++i];
      if (val === undefined || val.startsWith("-")) {
        args.errors.push("--models requires a value");
        i--;
      } else {
        args.models = val.split(",").map((m) => m.trim());
      }
    } else if (a === "--runs" || a === "-r") {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) {
        args.errors.push("--runs requires a value");
        if (val !== undefined) i--;
      } else {
        const parsed = Number(val);
        if (!Number.isFinite(parsed)) {
          args.errors.push(`--runs must be an integer, got: ${val}`);
        } else if (!Number.isInteger(parsed)) {
          args.errors.push(`--runs must be an integer, got: ${val}`);
        } else if (parsed < 1) {
          args.errors.push(`--runs must be at least 1, got: ${parsed}`);
        } else {
          args.runs = parsed;
        }
      }
    } else if (a === "--cap-usd" || a === "-c") {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) {
        args.errors.push("--cap-usd requires a value");
        if (val !== undefined) i--;
      } else {
        const parsed = Number(val);
        if (!Number.isFinite(parsed)) {
          args.errors.push(`--cap-usd must be a finite number, got: ${val}`);
        } else if (parsed <= 0) {
          args.errors.push(`--cap-usd must be greater than 0, got: ${parsed}`);
        } else {
          args.capUsd = parsed;
        }
      }
    } else if (a === "--credit-usd") {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) {
        args.errors.push("--credit-usd requires a value");
        if (val !== undefined) i--;
      } else {
        const parsed = Number(val);
        if (!Number.isFinite(parsed)) {
          args.errors.push(`--credit-usd must be a finite number, got: ${val}`);
        } else if (parsed <= 0) {
          args.errors.push(`--credit-usd must be greater than 0, got: ${parsed}`);
        } else {
          args.creditUsd = parsed;
        }
      }
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`basilisk-eval matrix runner

Usage:
  OPENROUTER_API_KEY=... npm run matrix
  OPENROUTER_API_KEY=... npm run matrix -- --suite 0.2.0
  npm run matrix -- --fixture

Options:
  --suite, -s     Suite version (default: ${DEFAULT_SUITE})
  --models, -m    Comma-separated model list (default: sorted by worst-case cost)
  --runs, -r      Runs per model (default: ${DEFAULT_RUNS})
  --cap-usd, -c   Global cost cap in USD (default: $10 for 0.1.0, $35 for 0.2.0)
  --credit-usd    Override credit check with fixed value (use if endpoints fail)
  --fixture, -f   Use fixture answers (no LLM, $0 cost, no API key required)
  --help, -h      Show help

Environment:
  OPENROUTER_API_KEY  Required for live mode (not fixture)

Examples:
  OPENROUTER_API_KEY=... npm run matrix
  OPENROUTER_API_KEY=... npm run matrix -- --suite 0.2.0
  OPENROUTER_API_KEY=... npm run matrix -- --models openai/gpt-4o-mini --runs 1 --cap-usd 5
  npm run matrix -- --fixture
`);
}

function formatSummaryTable(runs: RunResult[]): string {
  const lines: string[] = [];
  lines.push("| Model | Run | Pass/N | Tokens In | Tokens Out | Cached | Cost USD | Empty | Abort |");
  lines.push("|-------|-----|--------|-----------|------------|--------|----------|-------|-------|");

  for (const run of runs) {
    const empty = run.emptyTasks.length > 0 ? run.emptyTasks.join(", ") : "-";
    const abort = run.abortReason ?? "-";
    const cached = run.tokensCached !== null ? String(run.tokensCached) : "-";
    lines.push(
      `| ${run.model} | ${run.runN} | ${run.pass}/${run.total} | ${run.tokensIn} | ${run.tokensOut} | ${cached} | $${run.costUsd.toFixed(6)} | ${empty} | ${abort} |`,
    );
  }

  return lines.join("\n");
}

interface ModelStats {
  passes: number[];
  mean: number;
  spread: number;
  totalCost: number;
  totalIn: number;
  totalOut: number;
  totalCached: number | null;
  totalEmpty: number;
}

function computeModelStats(runs: RunResult[]): Map<string, ModelStats> {
  const byModel = new Map<string, RunResult[]>();
  for (const run of runs) {
    const list = byModel.get(run.model) ?? [];
    list.push(run);
    byModel.set(run.model, list);
  }

  const stats = new Map<string, ModelStats>();
  for (const [model, modelRuns] of byModel) {
    const passes = modelRuns.map((r) => r.pass);
    const mean = passes.reduce((a, b) => a + b, 0) / passes.length;
    const spread = Math.max(...passes) - Math.min(...passes);
    const totalCost = modelRuns.reduce((a, r) => a + r.costUsd, 0);
    const totalIn = modelRuns.reduce((a, r) => a + r.tokensIn, 0);
    const totalOut = modelRuns.reduce((a, r) => a + r.tokensOut, 0);
    const totalEmpty = modelRuns.reduce((a, r) => a + r.emptyCount, 0);
    let totalCached: number | null = null;
    for (const r of modelRuns) {
      if (r.tokensCached !== null) {
        totalCached = (totalCached ?? 0) + r.tokensCached;
      }
    }
    stats.set(model, { passes, mean, spread, totalCost, totalIn, totalOut, totalCached, totalEmpty });
  }

  return stats;
}

function printSummaryToConsole(runs: RunResult[], suite: string, capUsd: number, taskCount: number): void {
  console.log("\n=== Matrix Summary ===");
  console.log(`Suite: ${suite} | Cap: $${capUsd.toFixed(2)} | Tasks: ${taskCount}`);
  console.log("");
  console.log(formatSummaryTable(runs));

  const stats = computeModelStats(runs);
  console.log("\n--- Per-Model Summary ---");
  console.log("| Model | Runs | Mean | Spread | Total In | Total Out | Cached | Empty | Total Cost |");
  console.log("|-------|------|------|--------|----------|-----------|--------|-------|------------|");

  for (const [model, s] of stats) {
    const passStr = s.passes.map((p) => `${p}/${taskCount}`).join(", ");
    const cached = s.totalCached !== null ? String(s.totalCached) : "-";
    console.log(
      `| ${model} | ${passStr} | ${s.mean.toFixed(2)} | ${s.spread} | ${s.totalIn} | ${s.totalOut} | ${cached} | ${s.totalEmpty} | $${s.totalCost.toFixed(6)} |`,
    );
  }
}

async function writeSummaryFiles(
  runs: RunResult[],
  suite: string,
  priceData: PriceData,
  capUsd: number,
  globalAbort: boolean,
  taskCount: number,
  fixture: boolean,
  skippedModels: SkippedModel[] = [],
  topUpNeeded: number = 0,
): Promise<{ jsonPath: string; mdPath: string }> {
  const sha7 = getGitSha7();
  const date = getTodayDate();
  const resultsDir = getResultsDir(fixture);
  const summaryDir = path.join(resultsDir, suite);
  await mkdir(summaryDir, { recursive: true });

  const baseName = `_summary-${sha7}-${date}`;
  const jsonPath = path.join(summaryDir, `${baseName}.json`);
  const mdPath = path.join(summaryDir, `${baseName}.md`);

  const stats = computeModelStats(runs);
  const modelSummaries: Record<string, unknown> = {};
  for (const [model, s] of stats) {
    modelSummaries[model] = {
      passes: s.passes,
      mean: s.mean,
      spread: s.spread,
      totalCost: s.totalCost,
      totalIn: s.totalIn,
      totalOut: s.totalOut,
      totalCached: s.totalCached,
    };
  }

  const summaryJson = {
    suite,
    sha: sha7,
    date,
    capUsd,
    globalAbort,
    pricesFetchedAt: priceData.fetchedAt,
    taskCount,
    runs: runs.map((r) => ({
      model: r.model,
      run_n: r.runN,
      pass: r.pass,
      total: r.total,
      tokens_in: r.tokensIn,
      tokens_out: r.tokensOut,
      tokens_cached: r.tokensCached,
      cost_usd: r.costUsd,
      empty_tasks: r.emptyTasks,
      abort_reason: r.abortReason ?? null,
    })),
    modelSummaries,
    skippedModels: skippedModels.map((s) => ({
      model: s.model,
      worst_case: s.worstCase,
      remaining: s.remaining,
      shortfall: s.shortfall,
    })),
    topUpNeeded,
  };

  await writeFile(jsonPath, safeStringify(summaryJson, 2), "utf8");

  const mdLines: string[] = [];
  mdLines.push(`# Matrix Summary: ${suite}`);
  mdLines.push("");
  mdLines.push(`- **SHA**: ${sha7}`);
  mdLines.push(`- **Date**: ${date}`);
  mdLines.push(`- **Cap**: $${capUsd.toFixed(2)}`);
  mdLines.push(`- **Tasks**: ${taskCount}`);
  mdLines.push(`- **Global Abort**: ${globalAbort ? "Yes" : "No"}`);
  mdLines.push("");
  mdLines.push("## Per-Run Results");
  mdLines.push("");
  mdLines.push(formatSummaryTable(runs));
  mdLines.push("");
  mdLines.push("## Per-Model Summary");
  mdLines.push("");
  mdLines.push("| Model | Runs | Mean | Spread | Total Cost |");
  mdLines.push("|-------|------|------|--------|------------|");

  for (const [model, s] of stats) {
    const passStr = s.passes.map((p) => `${p}/${taskCount}`).join(", ");
    mdLines.push(`| ${model} | ${passStr} | ${s.mean.toFixed(2)} | ${s.spread} | $${s.totalCost.toFixed(6)} |`);
  }

  if (skippedModels.length > 0) {
    mdLines.push("");
    mdLines.push("## Skipped Models (insufficient credit)");
    mdLines.push("");
    mdLines.push("| Model | Worst Case | Remaining | Shortfall |");
    mdLines.push("|-------|------------|-----------|-----------|");
    for (const s of skippedModels) {
      mdLines.push(`| ${s.model} | $${s.worstCase.toFixed(4)} | $${s.remaining.toFixed(4)} | $${s.shortfall.toFixed(4)} |`);
    }
    mdLines.push("");
    mdLines.push(`**Top-up needed**: $${topUpNeeded.toFixed(2)}`);
  }

  await writeFile(mdPath, mdLines.join("\n") + "\n", "utf8");

  return { jsonPath, mdPath };
}

export interface CreditFetcher {
  (apiKey: string): Promise<{ limitRemaining: number | null; availableCredits: number | null; keyError: boolean; creditsError: boolean }>;
}

export interface RunMainDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  getGitStatus?: () => GitStatus;
  llmClientFactory?: LlmClientFactory;
  creditFetcher?: CreditFetcher;
  skipFileWrites?: boolean;
  skipPricesFetch?: boolean;
  priceData?: PriceData;
}

export async function runMain(deps: RunMainDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const getGitStatus = deps.getGitStatus ?? checkGitStatus;

  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.errors.length > 0) {
    for (const err of args.errors) {
      console.error(`Error: ${err}`);
    }
    return 1;
  }

  let tasks;
  try {
    tasks = getSuiteTasks(args.suite);
  } catch {
    console.error(`Error: Suite "${args.suite}" does not exist yet.`);
    console.error(`Available suites: ${Object.keys(SUITE_CONFIGS).join(", ")}`);
    return 1;
  }

  const apiKey = env.OPENROUTER_API_KEY;

  if (!args.fixture) {
    if (!apiKey || apiKey.trim() === "") {
      console.error("Error: Set OPENROUTER_API_KEY for live mode.");
      return 1;
    }
    registerSensitiveValue(apiKey);

    const gitStatus = getGitStatus();
    if (gitStatus.error) {
      console.error(`Error: ${gitStatus.error}`);
      console.error("Live mode requires a clean git checkout.");
      return 1;
    }
    if (gitStatus.isDirty) {
      console.error("Error: Working directory has uncommitted changes.");
      console.error("Live mode requires a clean git checkout (results/ and results-fixture/ are ignored).");
      return 1;
    }
    console.log(`Git SHA: ${gitStatus.sha}`);
  }

  const capUsd = args.capUsd ?? getDefaultCapUsd(args.suite);

  console.log(`basilisk-eval matrix runner`);
  console.log(`Suite: ${args.suite}`);
  console.log(`Models: ${args.models.join(", ")}`);
  console.log(`Runs: ${args.runs}`);
  console.log(`Cap: $${capUsd.toFixed(2)}`);
  console.log(`Mode: ${args.fixture ? "fixture" : "live"}`);
  if (!args.fixture) {
    console.log(`max_tokens: ${MAX_COMPLETION_TOKENS} (forced)`);
  }
  console.log("---");

  let priceData: PriceData;

  if (args.fixture) {
    priceData = createFixturePrices(args.models);
    console.log("Using fixture prices ($0 for all models)");
  } else if (deps.skipPricesFetch && deps.priceData) {
    priceData = deps.priceData;
  } else {
    console.log("Fetching model prices from OpenRouter...");
    try {
      priceData = await fetchModelPrices(args.models);
    } catch (err) {
      const redacted = redactError(err);
      console.error(`Error fetching prices: ${redacted.message}`);
      return 1;
    }

    const validation = validatePricesForModels(priceData, args.models);
    if (!validation.valid) {
      console.error(`Error: Missing pricing for models: ${validation.missing.join(", ")}`);
      console.error("These models may not exist or have no pricing data.");
      return 1;
    }

    console.log(`Prices fetched at: ${priceData.fetchedAt}`);
  }

  const suiteConfig = SUITE_CONFIGS[args.suite] ?? { maxSteps: 8 };
  const maxSteps = suiteConfig.maxSteps;
  const iMax = getDefaultIMax(args.suite, maxSteps);

  const sortedModels = sortModelsByFullWorstCase(
    args.models,
    priceData,
    args.runs,
    tasks.length,
    maxSteps,
    iMax,
  );
  console.log(`Running models (ascending worst-case): ${sortedModels.join(", ")}`);

  let creditProvider: CreditProvider | undefined;
  let initialCredit: number | null = null;

  if (!args.fixture) {
    const creditFetcher = deps.creditFetcher ?? fetchCreditInfo;

    if (args.creditUsd !== undefined) {
      initialCredit = args.creditUsd;
      console.log(`Credit (from --credit-usd): $${initialCredit.toFixed(2)}`);
    } else {
      console.log("Checking credit...");
      const creditResult = await creditFetcher(apiKey!);

      if (creditResult.keyError && creditResult.creditsError) {
        console.error("Error: Both credit endpoints failed.");
        console.error("Use --credit-usd to override.");
        return 1;
      }

      const values: number[] = [];
      if (creditResult.limitRemaining !== null) {
        values.push(creditResult.limitRemaining);
        console.log(`  Limit remaining: $${creditResult.limitRemaining.toFixed(2)}`);
      } else {
        console.log(`  Limit remaining: unlimited`);
      }
      if (creditResult.availableCredits !== null) {
        values.push(creditResult.availableCredits);
        console.log(`  Available credits: $${creditResult.availableCredits.toFixed(2)}`);
      }

      if (values.length > 0) {
        initialCredit = Math.min(...values);
        console.log(`  Effective credit: $${initialCredit.toFixed(2)}`);
      }
    }

    if (initialCredit !== null) {
      const effectiveCredit = initialCredit;
      creditProvider = async () => effectiveCredit;
    }
  }

  console.log("---");

  const config = {
    suite: args.suite,
    models: sortedModels,
    runs: args.runs,
    capUsd,
    fixture: args.fixture,
  };

  const { runs, globalAbort, skippedModels, topUpNeeded } = await runMatrix(config, priceData, {
    callbacks: {
      onRunStart: (model, runN) => {
        console.log(`Starting: ${model} run ${runN}`);
      },
      onTaskComplete: (_model, _runN, taskId, pass) => {
        const mark = pass ? "PASS" : "FAIL";
        console.log(`  [${mark}] ${taskId}`);
      },
      onRunComplete: (result) => {
        console.log(`Completed: ${result.model} run ${result.runN} - ${result.pass}/${result.total} ($${result.costUsd.toFixed(6)})`);
        if (result.emptyTasks.length > 0) {
          console.log(`  Empty answers: ${result.emptyTasks.join(", ")}`);
        }
        if (result.abortReason) {
          console.log(`  Aborted: ${result.abortReason}`);
        }
      },
      onModelAbort: (model, reason) => {
        console.log(`Model aborted: ${model} - ${reason}`);
      },
      onModelSkipped: (model, worstCase, remaining, shortfall) => {
        console.log(`Skipped: ${model} (worst case $${worstCase.toFixed(4)} > remaining $${remaining.toFixed(4)}, shortfall $${shortfall.toFixed(4)})`);
      },
      onGlobalAbort: () => {
        console.log("GLOBAL CAP REACHED - halting matrix");
      },
    },
    llmClientFactory: deps.llmClientFactory,
    skipFileWrites: deps.skipFileWrites,
    creditProvider,
  });

  if (globalAbort) {
    console.log("\n*** Matrix halted due to global cost cap ***");
  }

  if (skippedModels.length > 0) {
    console.log("\n--- Skipped Models (insufficient credit) ---");
    for (const skipped of skippedModels) {
      console.log(`  ${skipped.model}: worst case $${skipped.worstCase.toFixed(4)}, remaining $${skipped.remaining.toFixed(4)}, shortfall $${skipped.shortfall.toFixed(4)}`);
    }
    // Top-up formula: sum of shortfalls, floored at 0
    console.log(`\nTop-up needed: $${topUpNeeded.toFixed(2)}`);
  }

  printSummaryToConsole(runs, args.suite, capUsd, tasks.length);

  if (!deps.skipFileWrites) {
    const { jsonPath, mdPath } = await writeSummaryFiles(runs, args.suite, priceData, capUsd, globalAbort, tasks.length, args.fixture, skippedModels, topUpNeeded);

    console.log("\n--- Output Files ---");
    console.log(`Summary JSON: ${jsonPath}`);
    console.log(`Summary MD:   ${mdPath}`);

    const resultsDir = getResultsDir(args.fixture);
    const resultFiles: string[] = [];
    for (const run of runs) {
      const sha7 = getGitSha7();
      const fileName = `${sha7}-${sanitizeModelId(run.model)}-run${run.runN}.json`;
      resultFiles.push(path.join(resultsDir, args.suite, fileName));
    }

    console.log(`Per-run results:`);
    for (const f of resultFiles) {
      console.log(`  ${f}`);
    }
  }

  if (globalAbort) {
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  const exitCode = await runMain();
  process.exit(exitCode);
}

function isMainModule(): boolean {
  try {
    const realArgv1 = realpathSync(process.argv[1]);
    return import.meta.url === pathToFileURL(realArgv1).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    const redacted = redactError(err);
    console.error(redacted.message);
    process.exit(1);
  });
}
