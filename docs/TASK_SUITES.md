# Task suites

The task suites the harness scores against, and how to reproduce the archived one. Linked from the [README](../README.md).

## Published scores

> **Published score:** 7/7 on suite 0.1.0 at `4100fbb`, model `nex-agi/nex-n2.5-pro` (paid), one live run, 4,721 prompt / 1,102 completion tokens.
> Note: `nex-agi/nex-n2.5-pro:free` is no longer listed on OpenRouter (checked 2026-10-17).

**Suite 0.2.0** is now the default. Suite 0.1.0 source was retired from main; reproduce 0.1.0 at commit e61f639 (see below).

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

### Running suite 0.2.0

```bash
npm run eval -- --fixture
npm run matrix -- --fixture
```

Suite 0.2.0 introduces 6 new tools (11 total): `read_file`, `apply_patch`, `run_check`, `csv_query`, `flaky_sum`, `flaky_lookup`. Chain and selection tasks see the full 11-tool catalog; other tasks see only their listed subset (via `expectedTools`).

**Scoring**: Every task, including selection tasks, is scored on the final answer only. The `expectedTools` field limits the visible tool catalog but does not affect scoring.

### Suite 0.2.0 defaults

- **Tasks**: 16
- **Max steps per task**: 6–12 (task-dependent, default 8)
- **Cost cap**: $35.00
- **Prompt threshold**: 4,700 tokens

### Node version requirement

Suite 0.2.0 requires **Node >= 22** with permission model support. Patch verification executes model-generated code in a separate permission-restricted Node process with a hard timeout. A preflight check runs at startup and exits with an error if the permission model is unavailable.

## Suite 0.1.0 (archived)

Suite 0.1.0 source is retired from main. The `results/0.1.0/e61f639-*` rows came from the live matrix at commit e61f639. To reproduce them:

```bash
git checkout e61f639 && npm ci && OPENROUTER_API_KEY=... npm run matrix -- --suite 0.1.0
```

Offline check at the same commit (no key, $0): `npm run matrix -- --suite 0.1.0 --fixture` (7/7 per run).
