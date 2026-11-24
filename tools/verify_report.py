#!/usr/bin/env python3
"""Fail if the numbers in TEST_REPORT.md differ from runs/v1/score.json and runs/v2/score.json."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
report = ROOT / "TEST_REPORT.md"
if not report.exists():
    sys.exit("TEST_REPORT.md is missing")
text = report.read_text(encoding="utf-8")
v1 = json.loads((ROOT / "runs/v1/score.json").read_text())
v2 = json.loads((ROOT / "runs/v2/score.json").read_text())
problems = []


def row(label):
    m = re.search(r"^\|\s*" + re.escape(label) + r"[^|]*\|([^|]*)\|([^|]*)\|", text, re.M)
    if not m:
        problems.append(f"summary row not found: {label}")
        return None, None
    return m.group(1).strip(), m.group(2).strip()


def expect(label, a, b):
    got = row(label)
    if got[0] is None:
        return
    if got[0].split(" (")[0] != a or got[1].split(" (")[0] != b:
        problems.append(f"{label}: report says '{got[0]}' / '{got[1]}', runs say '{a}' / '{b}'")


expect("Emails run", str(v1["n"]), str(v2["n"]))
expect("Intent accuracy", f"{v1['intent_correct']} / {v1['n']}", f"{v2['intent_correct']} / {v2['n']}")
expect("Correct action", f"{v1['action_correct']} / {v1['n']}", f"{v2['action_correct']} / {v2['n']}")
expect("Valid JSON on first try", f"{v1['valid_json_first_try']} / {v1['n']}", f"{v2['valid_json_first_try']} / {v2['n']}")
expect('Emails sent to "needs human"', str(v1["needs_human_count"]), str(v2["needs_human_count"]))

# Per-email marks must match the score files.
for eid, v in v2["emails"].items():
    m = re.search(r"^\|\s*" + eid + r"\s*\|(.*)\|\s*$", text, re.M)
    if not m:
        problems.append(f"{eid}: row missing")
        continue
    cells = [c.strip() for c in m.group(1).split("|")]
    want_v2 = "✅" if v["intent_ok"] and v["action_ok"] else "❌"
    if cells[7] != want_v2:
        problems.append(f"{eid}: v2 mark {cells[7]} but runs say {want_v2}")
    a = v1["emails"].get(eid)
    want_v1 = "—" if a is None else ("✅" if a["intent_ok"] and a["action_ok"] else "❌")
    if cells[4] != want_v1:
        problems.append(f"{eid}: v1 mark {cells[4]} but runs say {want_v1}")

if problems:
    print("REPORT DOES NOT MATCH THE RUNS:")
    for p in problems:
        print(" -", p)
    sys.exit(1)
print("TEST_REPORT.md matches runs/v1/score.json and runs/v2/score.json")
