#!/usr/bin/env python3
"""Download the Audit Log and Tickets tabs of a link-viewable Google Sheet as CSV.

  python3 tools/snapshot_sheet.py --sheet-url "$SHEET_URL_PRACTICE" --out runs/v1
"""
import argparse
import re
import sys
import urllib.parse
import subprocess
from pathlib import Path

TABS = {"Audit Log": "audit_log.csv", "Tickets": "tickets.csv"}


def sheet_id(url):
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", url)
    if not m:
        sys.exit("Not a Google Sheets URL: expected .../spreadsheets/d/<ID>/...")
    return m.group(1)


def fetch_tab(sid, tab):
    url = (f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?tqx=out:csv&headers=1&sheet="
           + urllib.parse.quote(tab))
    # curl uses the system certificate store; this Python build ships without a CA bundle.
    r = subprocess.run(["curl", "-sL", "--fail", "--max-time", "60", url], capture_output=True)
    if r.returncode != 0:
        sys.exit(f"Could not download tab '{tab}' (curl exit {r.returncode}). Is the sheet shared as 'Anyone with the link can view'?")
    text = r.stdout.decode("utf-8", errors="replace")
    if "<html" in text[:500].lower():
        sys.exit(f"Tab '{tab}' returned a web page, not CSV. Set sharing to 'Anyone with the link can view'.")
    return text


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sheet-url", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()
    sid = sheet_id(args.sheet_url)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for tab, name in TABS.items():
        text = fetch_tab(sid, tab)
        (out / name).write_text(text, encoding="utf-8")
        rows = max(0, len([ln for ln in text.splitlines() if ln.strip()]) - 1)
        print(f"{tab}: saved {out / name} ({rows} data line(s))")


if __name__ == "__main__":
    main()
