# Results Schema

Each JSON file in `results/<suite>/` contains one eval run result with these fields:

- `sha`: 40-character hex string; the commit SHA the suite was run against.
- `suite`: string; the suite version (e.g. "0.1.0").
- `model`: string; the model identifier (e.g. "nex-agi/nex-n2.5-pro").
- `run_n`: integer ≥ 1; the run number for this model/suite combination.
- `pass`: integer; the number of tasks that passed.
- `total`: integer; the total number of tasks (pass ≤ total).
- `tokens_in`: integer; the total prompt/input tokens across all tasks.
- `tokens_out`: integer; the total completion/output tokens across all tasks.
- `tokens_cached`: integer or null; the total cached tokens, or null when the provider does not report cached tokens.
- `cost_usd`: number ≥ 0; the estimated cost in USD, computed from list price (not billed).
- `date`: string; the run date in YYYY-MM-DD format.

Baseline row `0.1.0/4100fbb-nex-agi__nex-n2.5-pro-run1.json`: `cost_usd` computed at the 2026-10-17 OpenRouter list price ($0.075 per M input, $0.25 per M output): 4,721 × 0.075e-6 + 1,102 × 0.25e-6 = $0.00063. Not billed. Source: live run log 2026-10-04T18:37:51Z at 4100fbb.

## Suite 0.1.0 Reproducibility

Suite 0.1.0 result rows compare only with other 0.1.0 rows; cross-suite comparisons are not valid. To reproduce 0.1.0 results, check out commit e61f639, which all 0.1.0 result rows cite.
