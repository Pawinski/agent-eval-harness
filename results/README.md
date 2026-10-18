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
