# Running the harness

Every command, option and setting for running the harness. Linked from the [README](../README.md).

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
npm run eval -- --task chain_json_regex_add
```

**Typecheck:**

```bash
npm run typecheck
```

## Running the matrix

The matrix runner evaluates multiple models across multiple runs with cost caps.

**Basic usage:**

```bash
OPENROUTER_API_KEY=... npm run matrix
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

- **Suite**: 0.2.0
- **Runs**: 3 per model
- **Models**: nex-agi/nex-n2.5-pro, openai/gpt-4o-mini, anthropic/claude-haiku-5.5, mistralai/mistral-large-2512, openai/gpt-6.1-sol, anthropic/claude-opus-5.5 (sorted by worst-case cost)
- **Cap**: $35.00

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

## Env

See `.env.example`:

- `OPENROUTER_API_KEY` — required for live LLM score
- `MODEL` — pluggable model id (OpenRouter format)
- `OPENROUTER_BASE_URL` — optional API base override
- `MAX_TOKENS` — max tokens per completion (default 512)
- `AGENT_EVAL_CACHE_BREAKPOINT` — enable cache breakpoint (default off)
