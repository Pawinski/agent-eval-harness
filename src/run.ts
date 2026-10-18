/**
 * CLI: run frozen suite, write logs/, print pass/N + suite version.
 *
 * Usage:
 *   npm run eval                 # live LLM if OPENROUTER_API_KEY set, else dry-run stub
 *   npm run eval -- --fixture    # use fixture answers (no LLM) for offline smoke
 *   npm run eval -- --task chain_json_regex_add
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReactAgent } from "./agent/react.js";
import { createLlmClient, OpenRouterClient, parseRetryDelaysEnv } from "./llm/index.js";
import { PROJECT_NAME } from "./name.js";
import { fetchModelPricesWithParams } from "./matrix/prices.js";
import {
  createDefaultMcpClient,
  InProcessMcpClient,
  createToolsV2Context,
  createToolsV2Options,
  runPreflight,
  type McpToolClient,
} from "./mcp/index.js";
import {
  getSuiteVersionPath,
  runCheck,
  SUITE_VERSION,
  TASKS_V2,
  type SuiteTask,
} from "./suite/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");

type CliArgs = {
  fixture: boolean;
  taskId?: string;
  suite: string;
  help: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { fixture: false, help: false, suite: "0.2.0" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture" || a === "-f") out.fixture = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--task" || a === "-t") {
      out.taskId = argv[++i];
    } else if (a === "--suite" || a === "-s") {
      out.suite = argv[++i];
    }
  }
  return out;
}

type TaskOutcome = {
  id: string;
  pass: boolean;
  detail: string;
  finalAnswer: string;
  steps: number;
  logPath: string;
};

interface RunOneTaskOpts {
  fixture: boolean;
  runId: string;
  suite: string;
  toolsFactory?: () => McpToolClient;
  maxSteps?: number;
  supportedParameters?: Map<string, Set<string>>;
  maxObservationChars?: number;
}

async function runOneTask(
  task: SuiteTask,
  opts: RunOneTaskOpts,
): Promise<TaskOutcome> {
  const tools = opts.toolsFactory ? opts.toolsFactory() : createDefaultMcpClient();
  const llm = createLlmClient(
    opts.supportedParameters ? { supportedParameters: opts.supportedParameters } : undefined,
  );
  const agentLog: unknown[] = [];

  let finalAnswer: string;
  let steps: number;
  let transcript = "";

  const maxSteps = opts.maxSteps ?? 8;

  if (opts.fixture) {
    finalAnswer = task.fixtureAnswer ?? "";
    steps = 0;
    transcript = `[fixture] ${finalAnswer}`;
    agentLog.push({ type: "fixture", finalAnswer });
  } else {
    const agent = new ReactAgent({
      llm,
      tools,
      maxSteps,
      onLog: (e) => {
        agentLog.push(e);
      },
      expectedTools: task.expectedTools,
      maxObservationChars: opts.maxObservationChars,
    });
    const result = await agent.run(task.prompt);
    finalAnswer = result.finalAnswer;
    steps = result.steps;
    transcript = result.rawTranscript;
  }

  const check = runCheck(finalAnswer, 0, task.check);
  const logPath = path.join(LOGS_DIR, opts.runId, `${task.id}.json`);
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(
    logPath,
    JSON.stringify(
      {
        taskId: task.id,
        suiteVersion: SUITE_VERSION,
        pass: check.pass,
        check: { kind: check.kind, detail: check.detail },
        finalAnswer,
        steps,
        fixture: opts.fixture,
        model:
          llm instanceof OpenRouterClient
            ? `${llm.modelId}${llm.isDryRun ? "#dry-run" : ""}`
            : "unknown",
        transcript,
        log: agentLog,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    id: task.id,
    pass: check.pass,
    detail: check.detail,
    finalAnswer,
    steps,
    logPath,
  };
}

function printHelp(): void {
  console.log(`${PROJECT_NAME} — suite ${SUITE_VERSION}

Usage:
  npm run eval -- [--fixture] [--task <id>] [--suite <version>]

Options:
  --fixture, -f   Use frozen fixture answers (no LLM / offline smoke)
  --task, -t      Run a single task id
  --suite, -s     Suite version (default: 0.2.0)
  --help, -h      Show help

Env:
  OPENROUTER_API_KEY  Live multi-model calls (OpenRouter-style)
  MODEL               Pluggable model id (default openai/gpt-4o-mini)

Score: pass/N on suite version. Deterministic checkers only (no human grader).
`);
}

function getSuiteTasksList(suite: string): SuiteTask[] {
  if (suite === "0.2.0") {
    return TASKS_V2.map((t) => ({
      id: t.id,
      description: t.description,
      prompt: t.prompt,
      expectedTools: t.expectedTools,
      check: t.check,
      fixtureAnswer: t.fixtureAnswer,
    }));
  }
  throw new Error(`Unknown suite version: ${suite}`);
}

function getV2TaskMaxSteps(taskId: string): number {
  const task = TASKS_V2.find((t) => t.id === taskId);
  return task?.maxSteps ?? 8;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const suiteVersion = args.suite;
  let allTasks: SuiteTask[];
  try {
    allTasks = getSuiteTasksList(suiteVersion);
  } catch {
    console.error(`Unknown suite version: ${suiteVersion}`);
    console.error(`Available suites: 0.2.0`);
    process.exit(2);
  }

  if (suiteVersion === "0.2.0") {
    runPreflight();
  }

  const retryDelaysRaw = process.env.RETRY_DELAYS_MS;
  if (retryDelaysRaw !== undefined && retryDelaysRaw !== "") {
    const parsed = parseRetryDelaysEnv(retryDelaysRaw);
    if (!parsed) {
      console.error(`Error: RETRY_DELAYS_MS is invalid (must be comma-separated positive integers, no empty pieces).`);
      process.exit(1);
    }
  }

  const tasks = args.taskId
    ? allTasks.filter((t) => t.id === args.taskId)
    : allTasks;

  if (tasks.length === 0) {
    console.error(`No tasks matched${args.taskId ? `: ${args.taskId}` : ""}`);
    console.error(`Known ids: ${allTasks.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(path.join(LOGS_DIR, runId), { recursive: true });

  const mode = args.fixture
    ? "fixture"
    : process.env.OPENROUTER_API_KEY
      ? "live"
      : "dry-run";

  let toolsFactory: (() => McpToolClient) | undefined;
  let maxObservationChars: number | undefined;

  if (suiteVersion === "0.2.0") {
    toolsFactory = () => {
      const v2Ctx = createToolsV2Context();
      return new InProcessMcpClient(createToolsV2Options(v2Ctx));
    };
    maxObservationChars = 4096;
  }

  console.log(`${PROJECT_NAME} suite ${suiteVersion}`);
  console.log(`versionSource=${getSuiteVersionPath()}`);
  console.log(`mode=${mode} tasks=${tasks.length}`);
  console.log("---");

  // Live only: fetch supported_parameters once per run. On failure behaviour is unchanged (no filter).
  let supportedParameters: Map<string, Set<string>> | undefined;
  let parametersFetched: boolean | null = null;
  if (mode === "live") {
    const liveModel = new OpenRouterClient().modelId;
    const base = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    try {
      const p = await fetchModelPricesWithParams([liveModel], `${base}/models`);
      parametersFetched = p.parametersFetched;
      supportedParameters = p.parametersFetched ? p.supportedParameters : undefined;
    } catch {
      parametersFetched = false;
    }
  }

  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) {
    const maxSteps = suiteVersion === "0.2.0" ? getV2TaskMaxSteps(task.id) : 8;
    const outcome = await runOneTask(task, {
      fixture: args.fixture,
      runId,
      suite: suiteVersion,
      toolsFactory,
      maxSteps,
      maxObservationChars,
      supportedParameters,
    });
    outcomes.push(outcome);
    const mark = outcome.pass ? "PASS" : "FAIL";
    console.log(
      `[${mark}] ${outcome.id}  steps=${outcome.steps}  ${outcome.detail}`,
    );
  }

  const passed = outcomes.filter((o) => o.pass).length;
  const total = outcomes.length;
  const summaryPath = path.join(LOGS_DIR, runId, "summary.json");
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        suiteVersion,
        versionSource: getSuiteVersionPath(),
        mode,
        parametersFetched,
        passed,
        total,
        score: `${passed}/${total}`,
        tasks: outcomes.map((o) => ({
          id: o.id,
          pass: o.pass,
          detail: o.detail,
          logPath: o.logPath,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("---");
  console.log(`Score: ${passed}/${total}  suite ${suiteVersion}`);
  console.log(`Logs:  ${path.join(LOGS_DIR, runId)}`);
  console.log(`(Re-score after every change. Deterministic checks only.)`);

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
