# basilisk-eval

Public Basilisk eval harness (ReAct + MCP + multi-model LLM).

Frozen task suite + deterministic checkers. Publish score as **pass/N on suite version**. Re-score after every change. No human grader. No LLM-as-judge for MVP.

> **Published score:** 7/7 on suite 0.1.0 at `4100fbb`, model `nex-agi/nex-n2.5-pro` (paid), one live run, 4,721 prompt / 1,102 completion tokens.
> Note: `nex-agi/nex-n2.5-pro:free` is no longer listed on OpenRouter (checked 2026-10-17).

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

## Env

See `.env.example`:

- `OPENROUTER_API_KEY` — required for live LLM score
- `MODEL` — pluggable model id (OpenRouter format)
- `OPENROUTER_BASE_URL` — optional API base override
- `MAX_TOKENS` — max tokens per completion (default 512)
- `BASILISK_CACHE_BREAKPOINT` — enable cache breakpoint (default off)

## License

MIT
