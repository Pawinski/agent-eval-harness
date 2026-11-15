#!/usr/bin/env python3
"""Meter for points of the total weekly usage limit.

1 point = 1% of that week's total limit. Task points = tokens / the
median tokens-per-point of daily rows in the 7 days ending on the
task's date (if none, later days within 7 days after it).
"""
import argparse, csv, json, os, statistics, sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/Toronto")
# Default data directory: logs/token-meter under the repository root
# (logs/ is gitignored). Override with METER_ROOT for a shared log directory.
_REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ROOT = Path(os.environ.get("METER_ROOT", str(_REPOSITORY_ROOT / "logs" / "token-meter")))
LOG, DAILY, SERIES = ROOT / "estimate-log.csv", ROOT / "daily-calibration.csv", ROOT / "tokens-per-point.csv"
STATE = ROOT / "meter-state.json"
UNIT = "points of the total weekly limit"
FIELDS = [
    "date", "task", "product", "est_low", "est_high", "est_kind", "est_basis",
    "actual_tokens", "actual_basis", "actual_points", "points_source",
    "ratio", "pairable", "status", "source", "note", "token_basis", "calls", "avg_context",
    "legacy",
]
DAILY_FIELDS = [
    "date", "weekly_pct_start", "weekly_pct_end", "points", "tokens",
    "tokens_per_point", "tokens_measured", "tokens_estimated", "reset", "note",
    "limit_change_suspected",
]
def parse_num(text, tokens=False):
    s = str(text).strip().lower().replace(",", "").replace("%", "")
    if tokens and s.endswith("m"):
        return float(s[:-1]) * 1_000_000
    if tokens and s.endswith("k"):
        return float(s[:-1]) * 1_000
    return float(s)
def parse_range(text, tokens=False):
    parts = text.replace("–", "-").split("-", 1)
    lo = parse_num(parts[0], tokens)
    hi = parse_num(parts[1], tokens) if len(parts) == 2 else lo
    if lo > hi:
        raise ValueError(f"range {text!r}: low > high")
    return lo, hi
def fmt_tok(n):
    a = abs(n)
    if a >= 1_000_000:
        v = n / 1_000_000
        return (f"{v:.1f}M" if abs(v) < 10 else f"{v:.0f}M").replace(".0M", "M")
    if a >= 1000:
        v = n / 1000
        return (f"{v:.1f}k" if abs(v) < 10 else f"{v:.0f}k").replace(".0k", "k")
    return str(int(n) if n == int(n) else n)
def fmt_pts(n):
    digits = 3 if 0 < abs(n) < 0.1 else 2
    raw = int(abs(n) * 10 ** digits + 0.5 + 1e-10) / 10 ** digits
    s = f"{raw:.{digits}f}".rstrip("0").rstrip(".")
    return "-" + s if n < 0 else s
def today():
    return datetime.now(ET).strftime("%Y-%m-%d")
def as_date(text):
    return datetime.strptime(str(text), "%Y-%m-%d").date()
def load_state():
    return json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
def save_state(data):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
def read_csv(path, fields):
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return [{k: r.get(k, "") for k in fields} for r in csv.DictReader(fh)]
def write_rows(path, fields, rows, append=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    fresh = append and (not path.exists() or path.stat().st_size == 0)
    mode = "a" if append else "w"
    with path.open(mode, newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fields)
        if not append or fresh:
            writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})
def posfloat(text):
    try:
        value = float(text or 0)
    except ValueError:
        return 0.0
    return value if value > 0 else 0.0
def dated_rates():
    out = []
    for row in read_csv(DAILY, DAILY_FIELDS):
        value = posfloat(row.get("tokens_per_point"))
        if not value:
            continue
        try:
            out.append((as_date(row["date"]), value))
        except ValueError:
            continue
    return out
def rate_window(task_date, rates=None):
    """7 days ending on the task date; if none, later days within 7 days after it."""
    day = as_date(task_date)
    rates = dated_rates() if rates is None else rates
    earlier = [value for date, value in rates if day - timedelta(days=6) <= date <= day]
    if earlier:
        return earlier
    return [value for date, value in rates if day < date <= day + timedelta(days=6)]
def rate_for(task_date, rates=None):
    window = rate_window(task_date, rates)
    return statistics.median(window) if window else None
def prior_median(day, rates=None):
    day, rates = as_date(day), (dated_rates() if rates is None else rates)
    prior = [value for date, value in rates if day - timedelta(days=7) <= date <= day - timedelta(days=1)]
    return statistics.median(prior) if prior else None
def tokens_that_day(date):
    measured = estimated = 0.0
    for row in read_csv(LOG, FIELDS):
        if row.get("date") != date:
            continue
        tok = posfloat(row.get("actual_tokens"))
        if row.get("token_basis") == "measured":
            measured += tok
        else:
            estimated += tok
    return measured, estimated, measured + estimated
def day_points(start, end, reset, before):
    if reset:
        if before is None:
            raise SystemExit("--reset needs --weekly-pct-before-reset (last reading of the old week)")
        if before < start:
            raise SystemExit("weekly % before reset is below the day's start reading")
        return (before - start) + end
    delta = end - start
    if delta < 0:
        raise SystemExit(
            "weekly % fell (negative delta). If a weekly reset happened, pass --reset "
            "and --weekly-pct-before-reset. Otherwise check the readings."
        )
    return delta
def assign_points(row, rate):
    tokens = posfloat(row.get("actual_tokens"))
    points = tokens / rate
    lo, hi = posfloat(row.get("est_low")), posfloat(row.get("est_high"))
    mid = (lo + hi) / 2 if (lo or hi) else 0
    row["actual_points"] = str(round(points, 3))
    row["points_source"] = f"tokens / 7-day median ending {row.get('date')} ({fmt_tok(rate)} per point)"
    row["ratio"] = str(round(points / mid, 3)) if mid else ""
    row["pairable"] = "yes" if mid else "no"
    return points
def cmd_start(ns):
    plo, phi = parse_range(ns.est_points)
    tlo, thi = parse_range(ns.est_tokens, tokens=True)
    data = load_state()
    if ns.task in data:
        raise SystemExit(f"task {ns.task} is already running")
    data[ns.task] = {"bot": ns.bot, "est_points_lo": plo, "est_points_hi": phi, "est_tokens_lo": tlo, "est_tokens_hi": thi}
    save_state(data)
    print(f"Started {ns.task} for {ns.bot}.")
    print(f"Estimate {fmt_pts(plo)}–{fmt_pts(phi)} {UNIT} ({fmt_tok(tlo)}–{fmt_tok(thi)} tokens); 70% stop at {fmt_pts(0.7 * phi)}.")
def cmd_stop(ns):
    data = load_state()
    task = data.get(ns.task)
    if not task:
        raise SystemExit(f"no running task named {ns.task}")
    tokens = parse_num(ns.tokens, tokens=True)
    if tokens <= 0:
        raise SystemExit("stop requires a token figure (--tokens), full count with re-reads")
    date, cap = today(), task["est_points_hi"]
    tok = int(tokens) if tokens == int(tokens) else tokens
    row = {k: "" for k in FIELDS}
    row.update({
        "date": date, "task": ns.task, "est_low": task["est_points_lo"], "est_high": cap,
        "est_kind": "range" if task["est_points_lo"] != cap else "point", "est_basis": "points",
        "actual_tokens": tok, "actual_basis": f"gross ({ns.basis})",
        "actual_points": "", "points_source": "pending calibration",
        "ratio": "", "pairable": "no", "status": "done", "source": f"meter:{task['bot']}",
        "note": f"est tokens {fmt_tok(task['est_tokens_lo'])}–{fmt_tok(task['est_tokens_hi'])}",
        "token_basis": ns.basis,
    })
    rate = rate_for(date)
    points = assign_points(row, rate) if rate else None
    shown = f"{fmt_pts(points)} {UNIT}" if points is not None else "points pending calibration"
    print(f"Stopped {ns.task}.")
    print(f"Tokens: {fmt_tok(tokens)} ({ns.basis})")
    print(shown)
    if points is not None and cap and points >= cap:
        print(f"WARNING: {fmt_pts(points)} is at or over the {fmt_pts(cap)} {UNIT} cap.")
    elif points is not None and cap and points >= 0.7 * cap:
        print(f"WARNING: {fmt_pts(points)} is at or over 70% of the {fmt_pts(cap)} {UNIT} cap.")
    write_rows(LOG, FIELDS, [row], append=True)
    del data[ns.task]
    save_state(data)
    print(f"Appended a row to {LOG}")
def cmd_recompute(_ns=None):
    rates, rows, n = dated_rates(), read_csv(LOG, FIELDS), 0
    if not rows:
        print("Recomputed points for 0 task row(s).")
        return
    for row in rows:
        if str(row.get("legacy") or "").strip().lower() in {"yes", "y", "true", "1"}:
            continue
        if not posfloat(row.get("actual_tokens")) or not row.get("date"):
            continue
        rate = rate_for(row["date"], rates)
        if not rate:
            continue
        before = (row.get("actual_points"), row.get("points_source"), row.get("ratio"), row.get("pairable"))
        assign_points(row, rate)
        if before != (row.get("actual_points"), row.get("points_source"), row.get("ratio"), row.get("pairable")):
            n += 1
    if n:
        write_rows(LOG, FIELDS, rows)
    print(f"Recomputed points for {n} task row(s) using 7-day windows ending on each task date.")
def cmd_day(ns):
    date = ns.date
    try:
        as_date(date)
    except ValueError:
        raise SystemExit(f"date {date!r} must be YYYY-MM-DD")
    if any(row.get("date") == date for row in read_csv(DAILY, DAILY_FIELDS)):
        raise SystemExit(f"a day reading for {date} already exists")
    start, end = parse_num(ns.weekly_pct_start), parse_num(ns.weekly_pct_end)
    before = parse_num(ns.weekly_pct_before_reset) if ns.weekly_pct_before_reset else None
    points = day_points(start, end, ns.reset, before)
    measured, estimated, total = tokens_that_day(date)
    tpp = (total / points) if points else ""
    prior = prior_median(date)
    flag = ""
    if tpp != "" and prior and abs(tpp - prior) / prior > 0.3:
        flag = "yes"
        pct = abs(tpp - prior) / prior * 100
        print(
            f"WARNING: day's tokens per 1% ({fmt_tok(tpp)}) differs from the prior "
            f"7-day median ({fmt_tok(prior)}) by {fmt_pts(pct)}% (>30%); marked limit_change_suspected."
        )
    num = lambda n: int(n) if n == int(n) else n
    write_rows(DAILY, DAILY_FIELDS, [{
        "date": date, "weekly_pct_start": start, "weekly_pct_end": end,
        "points": round(points, 3), "tokens": num(total),
        "tokens_per_point": "" if tpp == "" else round(tpp, 1),
        "tokens_measured": num(measured), "tokens_estimated": num(estimated),
        "reset": "yes" if ns.reset else "no",
        "note": "" if total else "no stop rows for this date",
        "limit_change_suspected": flag,
    }], append=True)
    print(f"Day {date}: {fmt_pts(points)} {UNIT} (weekly used {fmt_pts(start)}% → {fmt_pts(end)}%)")
    print(f"Tokens logged: {fmt_tok(total)} (measured {fmt_tok(measured)}, estimated {fmt_tok(estimated)})")
    print("Tokens per 1% that day: " + (fmt_tok(tpp) if tpp != "" else "none (no points or no tokens)"))
    print(f"Appended a row to {DAILY}")
    cmd_recompute()
def cmd_calibrate(_ns=None):
    rows = read_csv(DAILY, DAILY_FIELDS)
    rates, meas, est = [], 0.0, 0.0
    for row in rows:
        meas += posfloat(row.get("tokens_measured"))
        est += posfloat(row.get("tokens_estimated"))
        value = posfloat(row.get("tokens_per_point"))
        if value:
            rates.append(value)
    write_rows(SERIES, DAILY_FIELDS, rows)
    print(f"days: {len(rows)}")
    if rates:
        print(f"tokens per point of the total weekly limit: median {fmt_tok(statistics.median(rates))} (band {fmt_tok(min(rates))}–{fmt_tok(max(rates))}, n={len(rates)})")
    else:
        print("tokens per point of the total weekly limit: no daily rates yet")
    print(f"tokens across days: measured {fmt_tok(meas)}, estimated {fmt_tok(est)}")
    print("task points use the median of the 7 days ending on the task date, not this all-days figure")
    print("note: untracked in-chat work inflates the weekly delta (known gap, makes tokens-per-point read low)")
    print(f"wrote {SERIES}")
def main(argv=None):
    parser = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="1 point = 1% of that week's total limit. Task points = tokens / 7-day tokens-per-point median.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    start = sub.add_parser("start")
    start.add_argument("task")
    start.add_argument("--bot", required=True)
    start.add_argument("--est-points", required=True)
    start.add_argument("--est-tokens", required=True)
    start.set_defaults(func=cmd_start)
    stop = sub.add_parser("stop")
    stop.add_argument("task")
    stop.add_argument("--tokens", required=True, help="Gross tokens, full count with re-reads")
    stop.add_argument("--basis", required=True, choices=["measured", "estimated"])
    stop.set_defaults(func=cmd_stop)
    day = sub.add_parser("day")
    day.add_argument("--date", required=True, help="YYYY-MM-DD")
    day.add_argument("--weekly-pct-start", required=True)
    day.add_argument("--weekly-pct-end", required=True)
    day.add_argument("--reset", action="store_true", help="Day crossed a weekly reset")
    day.add_argument("--weekly-pct-before-reset", help="Last old-week reading; required with --reset")
    day.set_defaults(func=cmd_day)
    sub.add_parser("recompute").set_defaults(func=cmd_recompute)
    sub.add_parser("calibrate").set_defaults(func=cmd_calibrate)
    ns = parser.parse_args(argv)
    ns.func(ns)
if __name__ == "__main__":
    try:
        main()
    except ValueError as exc:
        sys.exit(f"error: {exc}")
