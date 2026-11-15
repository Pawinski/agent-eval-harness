# Agent usage

The live log is `estimate-log.csv` under `METER_ROOT`. If `METER_ROOT` is unset, the meter writes under `logs/token-meter/` in this repository (`logs/` is gitignored).

At task start, record the estimate (use the bot's exact display name):

```
python3 tools/token-meter/meter.py start <task> --bot "<exact name>" --est-points <lo-hi> --est-tokens <lo-hi>
```

At task stop, record gross tokens, including context re-reads, and whether the count is measured or estimated:

```
python3 tools/token-meter/meter.py stop <task> --tokens <full-count> --basis measured|estimated
```

One person runs `day` once per day, after that day's stops, with weekly % start and end from the usage report:

```
python3 tools/token-meter/meter.py day --date YYYY-MM-DD --weekly-pct-start X --weekly-pct-end Y
```

If weekly % fell because the week reset, pass `--reset --weekly-pct-before-reset` (last old-week reading). `day` also runs `recompute`, which fills pending points from the 7-day rate window ending on each task's date. Earlier log rows marked `legacy` are not recomputed.

Rules: 1 point = 1% of the total weekly limit (not a bot's share; do not use share). Tokens are gross and include re-reads. No code-in-strings (no eval/exec/python -c or bash -c with logic).
