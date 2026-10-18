# agent-eval-harness

Public eval harness (ReAct + MCP + multi-model LLM).

Frozen task suite + deterministic checkers. Publish score as **pass/N on suite version**. Re-score after every change. No human grader. No LLM-as-judge for MVP.

> **Published score:** 7/7 on suite 0.1.0 at `4100fbb`, model `nex-agi/nex-n2.5-pro` (paid), one live run, 4,721 prompt / 1,102 completion tokens.
> Note: `nex-agi/nex-n2.5-pro:free` is no longer listed on OpenRouter (checked 2026-10-17).

Suite 0.1.0 is frozen. It will be retired from main once 0.2.0 lands; reproduce 0.1.0 results at commit e61f639, which 0.1.0 result rows cite.

## Suite version (single source of truth)

**`suite/version.json`** — only place the suite version string is defined.

- Score printer (`src/run.ts`) reads it via `src/suite/version.ts` → `SUITE_VERSION`.
- Bump the suite by editing `suite/version.json` only.

## What “pass” means

- Automated, **deterministic checkers only** (exact string, JSON equality, regex, contains).
- A task **passes** iff the agent’s final answer satisfies that task’s frozen check.
- Suite score = `passed / total` for the frozen task set at this suite version.

### Fixture smoke ≠ live score

| Mode | Command | What it proves |
|------|---------|----------------|
| **Fixture smoke** | `npm run eval -- --fixture` | Wiring + checkers + suite version printer. Injects frozen answers — **not** a published live score. |
| **Live LLM** | set `OPENROUTER_API_KEY` (+ optional `MODEL`) then `npm run eval` | ReAct agent + tools + real model I/O against the frozen suite. **This** is the path for a published pass/N. Re-score after every change. |

Dry-run without a key (no `--fixture`) uses a stub LLM and is expected to fail most tasks — loop exercise only, not for scoring.

## Stack

| Layer | Choice |
|--------|--------|
| Language | TypeScript (Node ≥ 20) |
| Agent | Minimal **ReAct** loop (Thought / Action / Observation) |
| Tools | **MCP**-shaped tool client (in-process stubs; swappable for real MCP) |
| LLM | OpenRouter-style **multi-model** client (`OPENROUTER_API_KEY`, pluggable `MODEL`) |
| Logging | Loop / LLM / tool I/O under `logs/` |
| Eval | Small diverse **frozen** suite + deterministic checkers |

## How to run

```bash
cp .env.example .env
npm install
```

**Offline fixture smoke** (not a live score):

```bash
npm run eval -- --fixture
```

**Live multi-model path**:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
export MODEL=openai/gpt-4o-mini
npm run eval
```

**Single task:**

```bash
npm run eval -- --task echo_hello
```

**Typecheck:**

```bash
npm run typecheck
```

## Running the matrix

The matrix runner evaluates multiple models across multiple runs with cost caps.

**Basic usage (suite 0.1.0):**

```bash
OPENROUTER_API_KEY=... npm run matrix
```

**Suite 0.2.0:**

```bash
OPENROUTER_API_KEY=... npm run matrix -- --suite 0.2.0
```

**Override models, runs, and cap:**

```bash
OPENROUTER_API_KEY=... npm run matrix -- --models openai/gpt-4o-mini --runs 1 --cap-usd 5
```

**Fixture mode** (offline, no API key required):

```bash
npm run matrix -- --fixture
```

### Defaults

- **Suite**: 0.1.0
- **Runs**: 3 per model
- **Models**: nex-agi/nex-n2.5-pro, openai/gpt-4o-mini, anthropic/claude-haiku-5.5, mistralai/mistral-large-2512, openai/gpt-6.1-sol, anthropic/claude-opus-5.5 (sorted by worst-case cost)
- **Cap**: $10.00 for 0.1.0, $35.00 for 0.2.0

### Credit Pre-flight

Before each model, the runner checks available credit:
- GET `/api/v1/key` → `limit_remaining` (null = unlimited)
- GET `/api/v1/credits` → `total_credits - total_usage`

Models run in ascending full-worst-case order (runs × per-run worst case). Before each model, remaining is calculated as:
```
remaining = min(startingCredit - cumulativeSpend, capUsd - cumulativeSpend)
```

If remaining < model worst case, the model is skipped cleanly (zero LLM calls):
- **skipped: credit** — when credit binds (shows credit top-up needed)
- **skipped: cap** — when cap binds (shows cap shortfall)

When models are skipped, the runner prints `SKIPPED: N model(s), credit top-up $X / cap shortfall $Y` and exits 0 (completed runs are valid).

If both credit endpoints fail, OR if `/credits` fails AND `/key` reports null limit, the runner refuses unless `--credit-usd <n>` is given to override.

### Output

Results are written to `results/<suite>/` with per-run JSON files and a summary. The runner prints the exact file paths at the end. Skipped models with their status (skipped: credit or skipped: cap) are shown in the summary tables.

## Task IDs (suite 0.1.0)

| ID | Check |
|----|--------|
| `echo_hello` | exact |
| `add_17_25` | exact |
| `json_get_city` | exact |
| `regex_ticket` | regex |
| `word_count_phrase` | exact |
| `json_equal_payload` | json_equal |
| `contains_basilisk` | contains |

## Suite 0.2.0

Suite 0.2.0 expands coverage to 16 tasks across 6 categories:

| Category | Tasks | Description |
|----------|-------|-------------|
| `chain` | 3 | Multi-step tool chaining (JSON → regex → arithmetic) |
| `selection` | 3 | Select the right tool from the full catalog |
| `code_read` | 3 | Read and analyze code fixtures |
| `patch` | 3 | Fix bugs via patch then verify |
| `data` | 2 | CSV filtering and aggregation |
| `error_recovery` | 2 | Retry after transient errors |

### Using the `--suite` flag

Run eval or matrix against a specific suite version:

```bash
npm run eval -- --suite 0.2.0 --fixture
npm run matrix -- --suite 0.2.0 --fixture
```

Suite 0.2.0 introduces 6 new tools (11 total): `read_file`, `apply_patch`, `run_check`, `csv_query`, `flaky_sum`, `flaky_lookup`. Chain and selection tasks see the full 11-tool catalog; other tasks see only their listed subset (via `expectedTools`).

**Scoring**: Every task, including selection tasks, is scored on the final answer only. The `expectedTools` field limits the visible tool catalog but does not affect scoring.

### Suite 0.2.0 defaults

- **Tasks**: 16
- **Max steps per task**: 6–12 (task-dependent, default 8)
- **Cost cap**: $35.00
- **Prompt threshold**: 4,700 tokens

## Env

See `.env.example`:

- `OPENROUTER_API_KEY` — required for live LLM score
- `MODEL` — pluggable model id (OpenRouter format)
- `OPENROUTER_BASE_URL` — optional API base override
- `MAX_TOKENS` — max tokens per completion (default 512)
- `BASILISK_CACHE_BREAKPOINT` — enable cache breakpoint (default off)

## License

MIT
