/**
 * CLI: multi-model matrix runner with cost caps.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... npm run matrix
 *   OPENROUTER_API_KEY=... npm run matrix -- --suite 0.2.0
 *   npm run matrix -- --fixture
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchModelPrices,
  validatePricesForModels,
  createFixturePrices,
  sortModelsByCost,
  runMatrix,
  getGitSha7,
  getTodayDate,
  sanitizeModelId,
  registerSensitiveValue,
  redactError,
  safeStringify,
  DEFAULT_MODELS,
  DEFAULT_SUITE,
  DEFAULT_RUNS,
  SUITE_CONFIGS,
  getDefaultCapUsd,
  getSuiteTasks,
  type RunResult,
  type PriceData,
} from "./matrix/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS_DIR = path.join(ROOT, "results");

interface CliArgs {
  suite: string;
  models: string[];
  runs: number;
  capUsd?: number;
  fixture: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    suite: DEFAULT_SUITE,
    models: [...DEFAULT_MODELS],
    runs: DEFAULT_RUNS,
    fixture: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture" || a === "-f") {
      args.fixture = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--suite" || a === "-s") {
      args.suite = argv[++i];
    } else if (a === "--models" || a === "-m") {
      args.models = argv[++i].split(",").map((m) => m.trim());
    } else if (a === "--runs" || a === "-r") {
      args.runs = parseInt(argv[++i], 10);
    } else if (a === "--cap-usd" || a === "-c") {
      args.capUsd = parseFloat(argv[++i]);
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
  --models, -m    Comma-separated model list (default: cheapest-first from default list)
  --runs, -r      Runs per model (default: ${DEFAULT_RUNS})
  --cap-usd, -c   Global cost cap in USD (default: $10 for 0.1.0, $35 for 0.2.0)
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

function computeModelStats(runs: RunResult[]): Map<string, { passes: number[]; mean: number; spread: number; totalCost: number; totalIn: number; totalOut: number; totalCached: number | null }> {
  const byModel = new Map<string, RunResult[]>();
  for (const run of runs) {
    const list = byModel.get(run.model) ?? [];
    list.push(run);
    byModel.set(run.model, list);
  }

  const stats = new Map<string, { passes: number[]; mean: number; spread: number; totalCost: number; totalIn: number; totalOut: number; totalCached: number | null }>();
  for (const [model, modelRuns] of byModel) {
    const passes = modelRuns.map((r) => r.pass);
    const mean = passes.reduce((a, b) => a + b, 0) / passes.length;
    const spread = Math.max(...passes) - Math.min(...passes);
    const totalCost = modelRuns.reduce((a, r) => a + r.costUsd, 0);
    const totalIn = modelRuns.reduce((a, r) => a + r.tokensIn, 0);
    const totalOut = modelRuns.reduce((a, r) => a + r.tokensOut, 0);
    let totalCached: number | null = null;
    for (const r of modelRuns) {
      if (r.tokensCached !== null) {
        totalCached = (totalCached ?? 0) + r.tokensCached;
      }
    }
    stats.set(model, { passes, mean, spread, totalCost, totalIn, totalOut, totalCached });
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
  console.log("| Model | Runs | Mean | Spread | Total In | Total Out | Cached | Total Cost |");
  console.log("|-------|------|------|--------|----------|-----------|--------|------------|");

  for (const [model, s] of stats) {
    const passStr = s.passes.map((p) => `${p}/${taskCount}`).join(", ");
    const cached = s.totalCached !== null ? String(s.totalCached) : "-";
    console.log(
      `| ${model} | ${passStr} | ${s.mean.toFixed(2)} | ${s.spread} | ${s.totalIn} | ${s.totalOut} | ${cached} | $${s.totalCost.toFixed(6)} |`,
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
): Promise<{ jsonPath: string; mdPath: string }> {
  const sha7 = getGitSha7();
  const date = getTodayDate();
  const summaryDir = path.join(RESULTS_DIR, suite);
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

  await writeFile(mdPath, mdLines.join("\n") + "\n", "utf8");

  return { jsonPath, mdPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let tasks;
  try {
    tasks = getSuiteTasks(args.suite);
  } catch {
    console.error(`Error: Suite "${args.suite}" does not exist yet.`);
    console.error(`Available suites: ${Object.keys(SUITE_CONFIGS).join(", ")}`);
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!args.fixture) {
    if (!apiKey || apiKey.trim() === "") {
      console.error("Error: Set OPENROUTER_API_KEY for live mode.");
      process.exit(1);
    }
    registerSensitiveValue(apiKey);
  }

  const capUsd = args.capUsd ?? getDefaultCapUsd(args.suite);

  console.log(`basilisk-eval matrix runner`);
  console.log(`Suite: ${args.suite}`);
  console.log(`Models: ${args.models.join(", ")}`);
  console.log(`Runs: ${args.runs}`);
  console.log(`Cap: $${capUsd.toFixed(2)}`);
  console.log(`Mode: ${args.fixture ? "fixture" : "live"}`);
  console.log("---");

  let priceData: PriceData;

  if (args.fixture) {
    priceData = createFixturePrices(args.models);
    console.log("Using fixture prices ($0 for all models)");
  } else {
    console.log("Fetching model prices from OpenRouter...");
    try {
      priceData = await fetchModelPrices(args.models);
    } catch (err) {
      const redacted = redactError(err);
      console.error(`Error fetching prices: ${redacted.message}`);
      process.exit(1);
    }

    const validation = validatePricesForModels(priceData, args.models);
    if (!validation.valid) {
      console.error(`Error: Missing pricing for models: ${validation.missing.join(", ")}`);
      console.error("These models may not exist or have no pricing data.");
      process.exit(1);
    }

    console.log(`Prices fetched at: ${priceData.fetchedAt}`);
  }

  const sortedModels = sortModelsByCost(args.models, priceData);
  console.log(`Running models (cheapest first): ${sortedModels.join(", ")}`);
  console.log("---");

  const config = {
    suite: args.suite,
    models: sortedModels,
    runs: args.runs,
    capUsd,
    fixture: args.fixture,
  };

  const { runs, globalAbort } = await runMatrix(config, priceData, {
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
    onGlobalAbort: () => {
      console.log("GLOBAL CAP REACHED - halting matrix");
    },
  });

  if (globalAbort) {
    console.log("\n*** Matrix halted due to global cost cap ***");
  }

  printSummaryToConsole(runs, args.suite, capUsd, tasks.length);

  const { jsonPath, mdPath } = await writeSummaryFiles(runs, args.suite, priceData, capUsd, globalAbort, tasks.length);

  console.log("\n--- Output Files ---");
  console.log(`Summary JSON: ${jsonPath}`);
  console.log(`Summary MD:   ${mdPath}`);

  const resultFiles: string[] = [];
  for (const run of runs) {
    const sha7 = getGitSha7();
    const fileName = `${sha7}-${sanitizeModelId(run.model)}-run${run.runN}.json`;
    resultFiles.push(path.join(RESULTS_DIR, args.suite, fileName));
  }

  console.log(`Per-run results:`);
  for (const f of resultFiles) {
    console.log(`  ${f}`);
  }

  const totalPassed = runs.every((r) => r.pass === r.total && !r.abortReason);
  process.exit(totalPassed ? 0 : 1);
}

main().catch((err) => {
  const redacted = redactError(err);
  console.error(redacted.message);
  process.exit(1);
});
