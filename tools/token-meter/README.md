# Spend meter

1 point = 1% of that week's total usage limit. A task's points = its gross tokens divided by the median tokens-per-point of daily calibration rows in the 7 days ending on the task's date. If that lookback is empty, the nearest later days still within 7 days after the task date are used. Later data does not rewrite old weeks. No per-task weekly readings.

Set `METER_ROOT` to the directory that holds the logs (`estimate-log.csv`, `daily-calibration.csv`, and `tokens-per-point.csv`). If `METER_ROOT` is unset, the meter writes under `logs/token-meter/` in this repository (`logs/` is gitignored).

```
python3 tools/token-meter/meter.py start <task> --bot "<exact name>" --est-points <lo-hi> --est-tokens <lo-hi>
python3 tools/token-meter/meter.py stop <task> --tokens <full-count> --basis measured|estimated
python3 tools/token-meter/meter.py day --date YYYY-MM-DD --weekly-pct-start X --weekly-pct-end Y
python3 tools/token-meter/meter.py recompute
python3 tools/token-meter/meter.py calibrate
```

`day` takes one usage-report reading per date, sums that day's stop-row tokens, and appends tokens per 1% to `daily-calibration.csv` under `METER_ROOT`. If weekly % fell, it rejects the delta unless you pass `--reset --weekly-pct-before-reset` (last old-week reading). If that day's rate differs from the prior 7-day median by more than 30%, the row is marked `limit_change_suspected` and a warning is printed. `day` then runs `recompute`, which fills or refreshes every task row (including pending ones) from the 7-day window ending on that task's own date. `calibrate` writes `tokens-per-point.csv` (all-days median and band; task points still use the 7-day window). Untracked in-chat work inflates the weekly delta and makes tokens-per-point read low. Agents: see `agent-usage.md`. Earlier log rows marked `legacy` are not recomputed. Self-test: `python3 tools/token-meter/test_meter.py`
