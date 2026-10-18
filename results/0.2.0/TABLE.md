# Suite 0.2.0 results (harness 6d216f5)

- SHA: 6d216f5e0c9f44d0be5d248f539adc1e638813ed (6d216f5), Node v22.23.3, npm 10.9.9
- Command: `RETRY_DELAYS_MS=60000,180000,600000 npm run matrix -- --suite 0.2.0 --runs 3 --cap-usd 35 --credit-usd 14.845`
- Run window: started 2026-10-18 02:47 PDT, ended 03:53 PDT. 16 tasks per run, 3 runs, so N=48 per model.
- Prices fetched 2026-10-18 02:46:22 PDT (09:46:22Z). All 6 models' prompt/completion prices in _meta match https://openrouter.ai/api/v1/models as re-checked at 03:55 PDT.
- Runner cost ignores cache-read discounts, so it overstates slightly: runner sum $0.337329 vs. key-measured $0.328655.

| Model | Pass / N (of 48) | Mean per run (/16) | Spread | Tokens in | Tokens out | Cost (runner) | SHA | Status |
|---|---|---|---|---|---|---|---|---|
| nex-agi/nex-n2.5-pro | 47/48 | 15.67 (16,15,16) | 1 | 113,721 | 16,290 | $0.012602 | 6d216f5 | scored |
| anthropic/claude-haiku-5.5 | 46/48 | 15.33 (16,16,14) | 2 | 90,077 | 10,429 | $0.014222 | 6d216f5 | scored (no temperature sent) |
| openai/gpt-4o-mini | 46/48 | 15.33 (15,15,16) | 1 | 72,963 | 7,042 | $0.015170 | 6d216f5 | scored; 2 single empties (chain_word_count_multiply, runs 1 & 2) counted as fails |
| openai/gpt-6.1-sol | 46/48 | 15.33 (15,16,15) | 1 | 70,243 | 13,422 | $0.274706 | 6d216f5 | scored (no temperature sent) |
| mistralai/mistral-large-2512 | not scored (15/16 in run 1 only) | n/a | n/a | 27,067 | 4,731 | $0.020630 | 6d216f5 | **not scored (rate_limited)**: run 1 was 15/16 (1 empty); run 2 was rate-limited after 3 retries at 60/180/600 s and aborted; run 3 never ran |
| anthropic/claude-opus-5.5 | not scored | n/a | n/a | 0 | 0 | $0.000000 | 6d216f5 | **not scored (http_errors; provider refused the first 2 tasks)**: missing_usage on the first 2 tasks, aborted (http_errors) at $0. The raw call got a 200 with finish_reason content_filter (provider refusal) |

Total runner cost: $0.337329. Key-measured spend for this run: $0.328655 (usage $0.039101 → $0.367756).

SKIPPED line: `SKIPPED: 1 model(s), retries 3` (mistralai/mistral-large-2512, rate_limited). No pre-flight credit skips.
