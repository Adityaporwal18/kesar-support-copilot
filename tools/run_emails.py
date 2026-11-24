#!/usr/bin/env python3
"""Send test emails to the workflow webhook one at a time and save every response.

Same request as assignment/scripts/send_test_emails.py (one email object per POST),
but strictly sequential (waits for each response) and with the full response saved,
so a run can be scored afterwards with tools/check_run.py.

  python3 tools/run_emails.py --url http://localhost:5678/webhook/kesar-support-practice --only E01,E02 --out runs/dev1
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FILE = ROOT / "assignment" / "data" / "test_emails.json"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", required=True)
    p.add_argument("--file", default=str(DEFAULT_FILE))
    p.add_argument("--only", default="", help="comma-separated ids, sent in the order given here")
    p.add_argument("--delay", type=float, default=45.0, help="seconds between emails (free-tier rate limits)")
    p.add_argument("--timeout", type=float, default=180.0)
    p.add_argument("--out", required=True, help="run directory, e.g. runs/v1")
    args = p.parse_args()

    emails = json.loads(Path(args.file).read_text(encoding="utf-8"))["emails"]
    by_id = {e["id"]: e for e in emails}
    if args.only:
        wanted = [x.strip().upper() for x in args.only.split(",") if x.strip()]
        missing = [w for w in wanted if w not in by_id]
        if missing:
            sys.exit("Unknown email ids: " + ", ".join(missing))
        emails = [by_id[w] for w in wanted]

    out = Path(args.out)
    (out / "responses").mkdir(parents=True, exist_ok=True)
    log = (out / "run_log.jsonl").open("a", encoding="utf-8")
    failed = []
    print(f"Sending {len(emails)} email(s) to {args.url}, {args.delay}s apart")

    for i, email in enumerate(emails, 1):
        body = json.dumps(email, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(args.url, data=body, method="POST",
                                     headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": "kesar-run-emails/1.0"})
        started = time.time()
        status, text = None, ""
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as resp:
                status, text = resp.status, resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read().decode("utf-8", errors="replace")
        except Exception as e:  # connection errors, timeouts
            text = json.dumps({"runner_error": str(e)})
        elapsed = round(time.time() - started, 1)

        (out / "responses" / f"{email['id']}.json").write_text(text, encoding="utf-8")
        ok = status is not None and 200 <= status < 300
        summary = ""
        try:
            j = json.loads(text)
            summary = f"{j.get('intent')} | {j.get('action_taken')} | needs_human={j.get('needs_human')}"
            if j.get("error"):
                summary += f" | error={str(j.get('error'))[:80]}"
        except Exception:
            summary = text[:120].replace("\n", " ")
        log.write(json.dumps({"id": email["id"], "status": status, "seconds": elapsed, "ok": ok}) + "\n")
        log.flush()
        print(f"[{i}/{len(emails)}] {email['id']} -> {status} in {elapsed}s  {summary}")
        if not ok:
            failed.append(email["id"])
        if i < len(emails):
            time.sleep(args.delay)

    log.close()
    if failed:
        print("FAILED: " + ", ".join(failed))
        sys.exit(1)
    print("All requests succeeded.")


if __name__ == "__main__":
    main()
