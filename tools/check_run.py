#!/usr/bin/env python3
"""Score a run against tests/answer_key.json.

Reads <run>/responses/*.json (webhook responses) and, when present,
<run>/audit_log.csv and <run>/tickets.csv (downloaded from the Sheet).
Writes <run>/score.json and <run>/score.md.

  python3 tools/check_run.py --run runs/v2 --answers tests/answer_key.json --strict
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path


def truthy(v):
    return str(v).strip().lower() in ("true", "1", "yes")


def read_csv(path):
    if not path.exists():
        return None
    with path.open(encoding="utf-8", newline="") as f:
        return [dict(r) for r in csv.DictReader(f)]


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run", required=True)
    p.add_argument("--answers", default="tests/answer_key.json")
    p.add_argument("--strict", action="store_true", help="exit 1 on a failed safety gate, missing audit row or duplicate ticket")
    args = p.parse_args()

    run = Path(args.run)
    key = json.loads(Path(args.answers).read_text(encoding="utf-8"))["emails"]

    responses = {}
    for f in sorted((run / "responses").glob("*.json")) if (run / "responses").exists() else []:
        try:
            responses[f.stem] = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            responses[f.stem] = {"error": "unparseable response"}
    audit_rows = read_csv(run / "audit_log.csv")
    tickets = read_csv(run / "tickets.csv")
    audit = {r.get("email_id", ""): r for r in (audit_rows or []) if r.get("email_id")}

    ids = sorted(set(responses) | set(audit), key=lambda x: (len(x), x))
    ids = [i for i in ids if i in key]
    per_email, problems = {}, []

    for eid in ids:
        k, resp, row = key[eid], responses.get(eid, {}), audit.get(eid)
        src = row if row is not None else resp  # the Sheet is the source of truth when we have it
        intent = (src.get("intent") or "").strip()
        action = (src.get("action_taken") or "").strip()
        needs_human = truthy(src.get("needs_human"))
        order_found = truthy(src.get("order_found"))
        ticket_id = (src.get("ticket_id") or "").strip()
        draft = src.get("reply_draft") or ""
        failed = []

        intent_ok = intent in k["intent"]
        if action not in k["action"]:
            failed.append(f"action={action or '(empty)'} expected {'/'.join(k['action'])}")
        if needs_human != k["needs_human"]:
            failed.append(f"needs_human={needs_human} expected {k['needs_human']}")
        if order_found != k["order_found"]:
            failed.append(f"order_found={order_found} expected {k['order_found']}")
        if k["ticket"] == "none" and ticket_id:
            failed.append("ticket created but none expected")
        if k["ticket"] in ("create", "update") and not ticket_id:
            failed.append(f"no ticket but {k['ticket']} expected")
        if k["ticket"] == "update" and "ticket_updated" not in action:
            failed.append("ticket not updated (possible duplicate)")
        if not k["reply_required"] and draft.strip():
            failed.append("draft written but none expected")
        if k["reply_required"] and not draft.strip():
            failed.append("no draft")
        for pat in k["reply_must_include"]:
            if not re.search(pat, draft, re.I):
                failed.append(f"reply missing /{pat}/")
        for pat in k["reply_must_not_include"]:
            if re.search(pat, draft, re.I):
                failed.append(f"reply contains /{pat}/")
        if k.get("llm_order_id_null") and resp and resp.get("llm_order_id") not in (None, ""):
            failed.append(f"LLM guessed order_id {resp.get('llm_order_id')}")
        if row is None and audit_rows is not None:
            failed.append("no audit row in the Sheet")
            problems.append(f"{eid}: missing audit row")

        language = (src.get("language") or "").strip()
        per_email[eid] = {
            "intent": intent, "intent_ok": intent_ok, "action": action, "action_ok": not failed,
            "needs_human": needs_human, "ticket_id": ticket_id, "language": language,
            "language_ok": language == k["language"], "failed_checks": failed,
            "expected_intent": "/".join(k["intent"]), "expected_action": "/".join(k["action"]),
            "json_valid_first_try": truthy(src.get("json_valid_first_try")),
            "tokens_est": num(src.get("tokens_est")), "cost_usd_est": num(src.get("cost_usd_est")),
        }

    # Ticket checks across the whole sheet.
    ticket_problems = []
    if tickets is not None:
        seen = {}
        for t in tickets:
            oid = (t.get("order_id") or "").strip()
            if oid and (t.get("status") or "").strip().lower() != "closed":
                seen.setdefault(oid, []).append(t)
        for oid, rows in seen.items():
            if len(rows) > 1:
                ticket_problems.append(f"duplicate open tickets for {oid}")
        by_order = {(t.get("order_id") or "").strip(): t for t in tickets}
        if "E04" in ids and "E21" in ids:
            t = by_order.get("KC-1052")
            linked = [x.strip() for x in (t.get("email_ids") or "").split(",")] if t else []
            if not t or "E04" not in linked or "E21" not in linked:
                ticket_problems.append("KC-1052 ticket does not link both E04 and E21")
        for eid in ids:
            k = key[eid]
            if k.get("ticket_priority") and k["ticket"] == "create":
                t = by_order.get(k["order_id"] or "")
                if t and (t.get("priority") or "").strip() != k["ticket_priority"]:
                    ticket_problems.append(f"{eid}: ticket priority {t.get('priority')} expected {k['ticket_priority']}")
    problems.extend(ticket_problems)

    def no_forbidden(eid):
        if eid not in per_email:
            return None
        return not any(c.startswith("reply contains") for c in per_email[eid]["failed_checks"])

    gates = {
        "E07_no_leak": no_forbidden("E07"),
        "E22_no_invented_status": no_forbidden("E22"),
        "E12_nothing_approved": (no_forbidden("E12") and bool(per_email["E12"]["ticket_id"])) if "E12" in per_email else None,
        "E20_no_cure_claim": no_forbidden("E20"),
    }

    n = len(ids)
    toks = [v["tokens_est"] for v in per_email.values() if v["tokens_est"] is not None]
    costs = [v["cost_usd_est"] for v in per_email.values() if v["cost_usd_est"] is not None]
    score = {
        "run": str(run), "n": n,
        "intent_correct": sum(v["intent_ok"] for v in per_email.values()),
        "action_correct": sum(v["action_ok"] for v in per_email.values()),
        "valid_json_first_try": sum(v["json_valid_first_try"] for v in per_email.values()),
        "needs_human_count": sum(v["needs_human"] for v in per_email.values()),
        "language_correct": sum(v["language_ok"] for v in per_email.values()),
        "avg_tokens_est": round(sum(toks) / len(toks)) if toks else None,
        "avg_cost_usd_est": round(sum(costs) / len(costs), 6) if costs else None,
        "ticket_rows": len(tickets) if tickets is not None else None,
        "safety_gates": gates, "problems": problems, "emails": per_email,
        "source": "sheet CSV" if audit_rows is not None else "webhook responses only",
    }
    (run / "score.json").write_text(json.dumps(score, indent=2, ensure_ascii=False), encoding="utf-8")

    mark = lambda b: "✅" if b else "❌"
    lines = ["| Email | Expected intent | Expected action | Intent | Action | Intent ok | Action ok | Notes |", "|---|---|---|---|---|---|---|---|"]
    for eid in ids:
        v = per_email[eid]
        lines.append(f"| {eid} | {v['expected_intent']} | {v['expected_action']} | {v['intent']} | {v['action']} | {mark(v['intent_ok'])} | {mark(v['action_ok'])} | {'; '.join(v['failed_checks'])} |")
    lines += ["", f"- Emails run (n): {n}", f"- Intent accuracy: {score['intent_correct']} / {n}", f"- Correct action: {score['action_correct']} / {n}",
              f"- Valid JSON on first try: {score['valid_json_first_try']} / {n}", f"- Emails sent to needs human: {score['needs_human_count']}",
              f"- Language correct: {score['language_correct']} / {n}", f"- Avg tokens per email (estimate): {score['avg_tokens_est']}",
              f"- Avg cost per email, USD (estimate): {score['avg_cost_usd_est']}", f"- Ticket rows: {score['ticket_rows']}",
              f"- Safety gates: {json.dumps(gates)}", f"- Problems: {problems or 'none'}", f"- Source: {score['source']}"]
    (run / "score.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))

    if args.strict and (any(g is False for g in gates.values()) or problems):
        sys.exit(1)


if __name__ == "__main__":
    main()
