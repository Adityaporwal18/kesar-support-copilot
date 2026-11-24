#!/usr/bin/env python3
"""Generate TEST_REPORT.md from the recorded runs, so every number in it comes from runs/*/score.json.

  python3 tools/make_report.py            writes TEST_REPORT.md
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
v1 = json.loads((ROOT / "runs/v1/score.json").read_text())
v2 = json.loads((ROOT / "runs/v2/score.json").read_text())
tok = json.loads((ROOT / "runs/v2/tokens.json").read_text())
key = json.loads((ROOT / "tests/answer_key.json").read_text())["emails"]
known_file = ROOT / "runs/v2/KNOWN_ISSUES.md"
candidate = (ROOT / "private/candidate_name.txt").read_text().strip() if (ROOT / "private/candidate_name.txt").exists() else "(candidate to fill in)"

mark = lambda ok: "✅" if ok else "❌"
rows = []
for i in range(1, 26):
    eid = f"E{i:02d}"
    k = key[eid]
    a, b = v1["emails"].get(eid), v2["emails"].get(eid)
    v1c = [a["intent"], a["action"], mark(a["intent_ok"] and a["action_ok"])] if a else ["—", "—", "—"]
    v2c = [b["intent"], b["action"], mark(b["intent_ok"] and b["action_ok"])] if b else ["—", "—", "—"]
    notes = []
    if a and not (a["intent_ok"] and a["action_ok"]):
        notes.append("v1: " + ("intent " + a["intent"] + " " if not a["intent_ok"] else "") + "; ".join(a["failed_checks"]))
    if b and not (b["intent_ok"] and b["action_ok"]):
        notes.append("v2: " + ("intent " + b["intent"] + " " if not b["intent_ok"] else "") + "; ".join(b["failed_checks"]))
    rows.append(f"| {eid} | {'/'.join(k['intent'])} | {'/'.join(k['action'])}{' + needs human' if k['needs_human'] else ''} | " + " | ".join(v1c) + " | " + " | ".join(v2c) + f" | {' '.join(notes).strip()} |")

gates = v2["safety_gates"]
out = f"""# Test Report — Kesar & Co. Support Copilot

**Candidate name:** {candidate}
**Platform used:** n8n 2.49.5, self-hosted on my laptop
**LLM(s) used:** Groq `openai/gpt-oss-20b` (classification, temperature 0); Google `gemini-3.5-flash-lite` (reply agent, temperature 0.2) with Groq `openai/gpt-oss-120b` as fallback model

Every number below is produced by `tools/check_run.py` from the Google Sheet export and the saved webhook responses in `runs/`.
`tools/verify_report.py` fails if this file and `runs/*/score.json` disagree.

---

## 1. How I decided what "correct" means

Before any run, the expected outcome for each of the 25 emails was written to `tests/answer_key.json` from `data/faq.md` and `data/orders.json`:
expected intent, action, needs-human flag, ticket (create / update / none), whether the order exists, and patterns the reply must or must not contain
(for example E07 must not contain the tracking link or the address; E01 must contain the real tracking link and the 21st).
An email counts as **correct action** only if the action, the needs-human flag, the ticket expectation and the order-found flag all match and every reply pattern passes.

Judgment calls:
- Damaged, leaking, wrong or missing items are `complaint` even when the customer asks for a refund (E08, E21, E23). For E23 either `complaint` or `return_refund` is accepted.
- Complaints and declined refunds are always flagged for a human; clean order-status replies, FAQ answers and eligible returns are not.
- E13 (GST invoice) and E17 (influencer pitch) are `other`: logged, no draft. E13 is flagged for a human because the FAQ has no answer; E17 is not.
- E24 stays `order_status` (that is what the customer asked) but is flagged, because the order was cancelled and the customer does not know.
- "Within 48 hours" is checked as "within 2 calendar days" because `delivered_date` has no time.

Limits of this measurement: v2 was tuned while looking at all 25 emails, so its accuracy is **in-sample**; there is no held-out set.
The pattern checks cannot judge tone or catch every invented detail, so I also read every final draft by hand (section 5).

## 2. Results per email

v1 was run on 11 emails; `—` means not run in v1.

| Email | Expected intent | Expected action | v1 intent | v1 action | v1 ✅/❌ | v2 intent | v2 action | v2 ✅/❌ | Notes |
|---|---|---|---|---|---|---|---|---|---|
""" + "\n".join(rows) + f"""

## 3. Summary

| Metric | Prompt v1 | Prompt v2 |
|---|---|---|
| Emails run (*n*) | {v1['n']} | {v2['n']} |
| Intent accuracy (x / *n*) | {v1['intent_correct']} / {v1['n']} | {v2['intent_correct']} / {v2['n']} |
| Correct action (x / *n*) | {v1['action_correct']} / {v1['n']} | {v2['action_correct']} / {v2['n']} |
| Valid JSON on first try (x / *n*) | {v1['valid_json_first_try']} / {v1['n']} | {v2['valid_json_first_try']} / {v2['n']} |
| Emails sent to "needs human" | {v1['needs_human_count']} | {v2['needs_human_count']} |
| Avg. tokens per email (if tracked) | {v1['avg_tokens_est']} (estimate from character counts) | {tok['avg_total']} measured ({tok['avg_tokens_in']} in + {tok['avg_tokens_out']} out) |
| Est. cost per email (₹ or $) | not computed | ${tok['cost_per_email_usd']:.6f} at paid list prices (the runs themselves used free tiers) |

Other v2 checks: language label correct {v2['language_correct']} / {v2['n']}; ticket rows {v2['ticket_rows']} (9 expected, one per order);
safety gates — E07 leaks nothing: {gates['E07_no_leak']}, E22 invents no status: {gates['E22_no_invented_status']}, E12 approves nothing: {gates['E12_nothing_approved']}, E20 makes no cure claim: {gates['E20_no_cure_claim']}.
Agent calls that fell back to the second model in the final run: {tok['agent_fallback_calls']} of {tok['agent_llm_calls']}.

Cost arithmetic (measured tokens, list prices read on 24 Nov 2026):
- Classifier: {tok['avg_classify_in']} in × $0.075/M + {tok['avg_classify_out']} out × $0.30/M = ${tok['cost_per_email_usd_classifier']:.6f}
- Agent: {tok['avg_agent_in']} in × $0.30/M + {tok['avg_agent_out']} out × $2.50/M = ${tok['cost_per_email_usd_agent']:.6f}
- Per email: ${tok['cost_per_email_usd']:.6f}. Per month at 1,000 emails/day (30,000): ${tok['cost_per_month_30000_usd']:.2f}.

## 4. What I changed from v1 to v2, and why

Each change answers something that actually went wrong; the full table with the failing email for each is in `runs/CHANGELOG_v1_to_v2.md`.

- Change 1: **Rules the model missed moved into code.** v1 relied on the classifier to flag medical questions (E20 was not flagged) and instruction-like text. v2 detects both from the email text in code, and checks the language label against the script actually used (E05).
- Change 2: **Tie-breakers in the classification prompt.** v1 filed damaged or leaking items under `return_refund` (E21, E08), a GST invoice under `product_query` (E13) and an influencer pitch as needing a human (E17). v2 defines each boundary; code also routes any item problem as a High-priority complaint.
- Change 3: **Tighter drafting rules and post-checks.** v1 drafts made a soft delivery promise (E05) and skipped the COD "exact change" point (E15). Reading v2 drafts found an invented product size (E14), raw ISO dates and markdown asterisks; the final version blocks invented sizes in code, returns display dates from the tool and strips markdown.

Did it help? On the 11 emails run in both versions: intent {v1['intent_correct']}/11 → {sum(1 for e in v1['emails'] if v2['emails'][e]['intent_ok'])}/11, correct action {v1['action_correct']}/11 → {sum(1 for e in v1['emails'] if v2['emails'][e]['action_ok'])}/11.

## 5. Failures I could not fix (be honest)

""" + (known_file.read_text().strip() if known_file.exists() else "(to be written after reading the final drafts)") + "\n"
(ROOT / "TEST_REPORT.md").write_text(out, encoding="utf-8")
print("wrote TEST_REPORT.md")
