# How it works

How the harness scores an agent, what a pass means, and how it is built. Linked from the [README](../README.md).

## Approach

Public eval harness (ReAct + MCP + multi-model LLM).

Frozen task suite + deterministic checkers. Publish score as **pass/N on suite version**. Re-score after every change. No human grader. No LLM-as-judge for MVP.

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
| Language | TypeScript (Node ≥ 22) |
| Agent | Minimal **ReAct** loop (Thought / Action / Observation) |
| Tools | **MCP**-shaped tool client (in-process stubs; swappable for real MCP) |
| LLM | OpenRouter-style **multi-model** client (`OPENROUTER_API_KEY`, pluggable `MODEL`) |
| Logging | Loop / LLM / tool I/O under `logs/` |
| Eval | Small diverse **frozen** suite + deterministic checkers |
