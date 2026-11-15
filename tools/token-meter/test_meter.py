#!/usr/bin/env python3
"""Self-test for the token meter. Run: python3 tools/token-meter/test_meter.py"""
import csv, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import meter

def run(root, args):
    env = os.environ.copy()
    env["METER_ROOT"] = str(root)
    return subprocess.run(
        [sys.executable, str(HERE / "meter.py"), *args],
        capture_output=True, text=True, env=env,
    )

def write_daily(root, **row):
    empty = {key: "" for key in meter.DAILY_FIELDS}
    empty.update(row)
    meter.write_rows(root / "daily-calibration.csv", meter.DAILY_FIELDS, [empty], append=True)

def write_log(root, **row):
    empty = {key: "" for key in meter.FIELDS}
    empty.update(row)
    meter.write_rows(root / "estimate-log.csv", meter.FIELDS, [empty], append=True)

def log_rows(root):
    with (root / "estimate-log.csv").open() as fh:
        return list(csv.DictReader(fh))

def daily_rows(root):
    with (root / "daily-calibration.csv").open() as fh:
        return list(csv.DictReader(fh))

class MeterTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="token-meter-"))
        self.addCleanup(shutil.rmtree, self.root)
        meter.ROOT = self.root
        meter.LOG = self.root / "estimate-log.csv"
        meter.DAILY = self.root / "daily-calibration.csv"
        meter.SERIES = self.root / "tokens-per-point.csv"
        meter.STATE = self.root / "meter-state.json"

    def test_day_calibration_math(self):
        self.assertAlmostEqual(meter.day_points(32.5, 33.7, False, None), 1.2)
        self.assertAlmostEqual(meter.day_points(80, 5, True, 85), 10)
        write_log(self.root, date="2026-11-13", task="a", actual_tokens="400000", token_basis="measured")
        write_log(self.root, date="2026-11-13", task="b", actual_tokens="200000", token_basis="estimated")
        out = run(self.root, [
            "day", "--date", "2026-11-13",
            "--weekly-pct-start", "32.5", "--weekly-pct-end", "33.7",
        ])
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("1.2 points of the total weekly limit", out.stdout)
        self.assertIn("Tokens per 1% that day: 500k", out.stdout)
        rows = daily_rows(self.root)
        self.assertEqual(rows[0]["tokens_per_point"], "500000.0")
        self.assertEqual(rows[0]["tokens_measured"], "400000")
        self.assertEqual(rows[0]["tokens_estimated"], "200000")

    def test_task_points_from_rate(self):
        write_daily(self.root, date="2026-11-12", points="1.2", tokens="600000",
                    tokens_per_point="500000", tokens_measured="600000")
        start = run(self.root, [
            "start", "demo", "--bot", "ExampleBot",
            "--est-points", "0.3-0.6", "--est-tokens", "150k-300k",
        ])
        self.assertEqual(start.returncode, 0, start.stderr)
        stop = run(self.root, ["stop", "demo", "--tokens", "200k", "--basis", "measured"])
        self.assertEqual(stop.returncode, 0, stop.stderr)
        self.assertIn("0.4 points of the total weekly limit", stop.stdout)
        row = log_rows(self.root)[0]
        self.assertEqual(list(row), meter.FIELDS)
        self.assertEqual((row["actual_tokens"], row["actual_points"], row["token_basis"]),
                         ("200000", "0.4", "measured"))

    def test_pending_when_no_rate(self):
        run(self.root, [
            "start", "demo", "--bot", "ExampleBot",
            "--est-points", "0.3-0.6", "--est-tokens", "150k-300k",
        ])
        stop = run(self.root, ["stop", "demo", "--tokens", "200k", "--basis", "estimated"])
        self.assertEqual(stop.returncode, 0, stop.stderr)
        self.assertIn("points pending calibration", stop.stdout)
        row = log_rows(self.root)[0]
        self.assertEqual(row["actual_points"], "")
        self.assertEqual(row["points_source"], "pending calibration")

    def test_negative_delta_handling(self):
        denied = run(self.root, [
            "day", "--date", "2026-11-18",
            "--weekly-pct-start", "40", "--weekly-pct-end", "5",
        ])
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn("negative delta", denied.stderr)
        self.assertIn("--reset", denied.stderr)
        ok = run(self.root, [
            "day", "--date", "2026-11-18",
            "--weekly-pct-start", "80", "--weekly-pct-end", "5",
            "--reset", "--weekly-pct-before-reset", "85",
        ])
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("10 points of the total weekly limit", ok.stdout)
        cal = run(self.root, ["calibrate"])
        self.assertEqual(cal.returncode, 0, cal.stderr)
        self.assertIn("untracked in-chat work inflates the weekly delta", cal.stdout)

    def test_rolling_window_ignores_days_older_than_7(self):
        write_daily(self.root, date="2026-11-01", tokens_per_point="1000000")
        write_daily(self.root, date="2026-11-12", tokens_per_point="500000")
        write_log(self.root, date="2026-11-13", task="demo", actual_tokens="200000",
                  token_basis="measured", est_low="0.3", est_high="0.6")
        out = run(self.root, ["recompute"])
        self.assertEqual(out.returncode, 0, out.stderr)
        row = log_rows(self.root)[0]
        self.assertEqual(row["actual_points"], "0.4")
        self.assertAlmostEqual(meter.rate_for("2026-11-13"), 500000)

    def test_backfill_fills_pending(self):
        run(self.root, [
            "start", "demo", "--bot", "ExampleBot",
            "--est-points", "0.3-0.6", "--est-tokens", "150k-300k",
        ])
        stop = run(self.root, ["stop", "demo", "--tokens", "200k", "--basis", "estimated"])
        self.assertIn("points pending calibration", stop.stdout)
        date = log_rows(self.root)[0]["date"]
        out = run(self.root, [
            "day", "--date", date,
            "--weekly-pct-start", "32.5", "--weekly-pct-end", "33.7",
        ])
        self.assertEqual(out.returncode, 0, out.stderr)
        row = log_rows(self.root)[0]
        self.assertEqual(row["actual_points"], "1.2")
        self.assertIn("7-day median", row["points_source"])

    def test_later_data_does_not_change_old_week_points(self):
        write_daily(self.root, date="2026-11-01", tokens_per_point="500000")
        write_log(self.root, date="2026-11-01", task="old", actual_tokens="200000",
                  token_basis="measured", est_low="0.3", est_high="0.6")
        first = run(self.root, ["recompute"])
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(log_rows(self.root)[0]["actual_points"], "0.4")
        write_daily(self.root, date="2026-11-13", tokens_per_point="1000000")
        second = run(self.root, ["recompute"])
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(log_rows(self.root)[0]["actual_points"], "0.4")

    def test_jump_over_30_percent_flagged(self):
        write_daily(self.root, date="2026-11-12", tokens_per_point="500000")
        write_log(self.root, date="2026-11-13", task="demo", actual_tokens="800000",
                  token_basis="measured")
        out = run(self.root, [
            "day", "--date", "2026-11-13",
            "--weekly-pct-start", "32.5", "--weekly-pct-end", "33.5",
        ])
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("limit_change_suspected", out.stdout)
        self.assertIn("WARNING", out.stdout)
        self.assertEqual(daily_rows(self.root)[-1]["limit_change_suspected"], "yes")
        self.assertEqual(daily_rows(self.root)[-1]["tokens_per_point"], "800000.0")


    def test_recompute_skips_legacy(self):
        write_daily(self.root, date="2026-11-12", tokens_per_point="500000")
        write_log(self.root, date="2026-11-13", task="old", actual_tokens="200000",
                  actual_points="0.36", points_source="historical", legacy="yes")
        out = run(self.root, ["recompute"])
        self.assertEqual(out.returncode, 0, out.stderr)
        row = log_rows(self.root)[0]
        self.assertEqual((row["actual_points"], row["points_source"], row["legacy"]),
                         ("0.36", "historical", "yes"))

if __name__ == "__main__":
    unittest.main(verbosity=2)
