# agent-eval-harness

## What it is

A public test bench for AI agents that use tools. A small agent works through a fixed set
of tasks (chaining tools, picking the right tool, reading code, fixing a bug with a patch,
querying data, and recovering from tool errors), calling many different language models.
Each answer is checked by a fixed rule, such as an exact string, JSON equality or a regular
expression. There is no human grader and no model acting as judge.

A score is always reported as passes out of tasks on a named suite version. The current
suite, 0.2.0, has 16 tasks per run ([results](results/0.2.0/TABLE.md)).

## Why it matters

- **Reproducible.** Every result file records the commit, suite version, model, token
  counts and cost, so anyone can rerun a score and compare.
- **Objective.** Fixed checks mean a score is a fact, not an opinion.
- **Cost-safe.** Before each model, the runner checks the remaining credit and a spending
  cap, and skips a model it cannot afford instead of overspending.
- **Honest about failures.** A model whose run aborted is shown as not scored, with the
  reason, never as a partial score.

## How to run it

```bash
cp .env.example .env
npm install
npm run eval -- --fixture     # offline check with frozen answers; no key, not a score
npm run matrix -- --fixture   # offline check of the multi-model runner
OPENROUTER_API_KEY=... npm run matrix   # live, paid run across the default models
```

More detail:

- [Running the harness](docs/RUNNING_THE_HARNESS.md): every command, the Node version,
  the spending cap, credit checks, output files and environment settings.
- [How it works](docs/HOW_IT_WORKS.md): what a pass means, offline versus live runs, and
  the stack.
- [Task suites](docs/TASK_SUITES.md): the tasks and tools in each suite, and how to
  reproduce the archived suite.

## Results

Suite 0.2.0 at harness commit `6d216f5`: 3 runs of 16 tasks per model, so 48 tasks per
model. Source: [results/0.2.0/TABLE.md](results/0.2.0/TABLE.md).

| Model | Passed | Status |
|---|---|---|
| nex-agi/nex-n2.5-pro | 47/48 | scored |
| anthropic/claude-haiku-5.5 | 46/48 | scored |
| openai/gpt-4o-mini | 46/48 | scored |
| openai/gpt-6.1-sol | 46/48 | scored |
| mistralai/mistral-large-2512 | n/a | not scored (rate_limited) |
| anthropic/claude-opus-5.5 | n/a | not scored: http_errors (provider content_filter refusal) |

Measured spend for the whole run: $0.328655
([results/0.2.0/TABLE.md](results/0.2.0/TABLE.md)). Per-run files and the full summary are
in [results/0.2.0/](results/0.2.0/).

Archived suite 0.1.0: `nex-agi/nex-n2.5-pro` passed 7/7 in one live run at commit
`4100fbb`, using 4,721 prompt and 1,102 completion tokens
([result file](results/0.1.0/4100fbb-nex-agi__nex-n2.5-pro-run1.json)). Other 0.1.0 rows
are in [results/0.1.0/](results/0.1.0/).

## License

[MIT](LICENSE)
