#!/usr/bin/env python3
"""Write the first draft of README.md from the recorded runs. Run once; afterwards the candidate edits README.md by hand.

  python3 tools/make_readme.py [--force]
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
target = ROOT / "README.md"
if target.exists() and "--force" not in sys.argv:
    sys.exit("README.md exists. Use --force to overwrite (this discards hand edits).")

v1 = json.loads((ROOT / "runs/v1/score.json").read_text())
v2 = json.loads((ROOT / "runs/v2/score.json").read_text())
tok = json.loads((ROOT / "runs/v2/tokens.json").read_text())
env = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().splitlines() if "=" in l and not l.startswith("#"))
sid = re.search(r"/d/([a-zA-Z0-9_-]+)", env.get("SHEET_URL_MAIN", ""))
sheet_link = f"https://docs.google.com/spreadsheets/d/{sid.group(1)}/edit?usp=sharing" if sid else "(add the Google Sheet link)"
prompt = lambda f: (ROOT / "prompts" / f).read_text().strip()
D = "> **DRAFT - candidate to rewrite.** The facts are real; put this in your own words before submitting."

text = f"""# Kesar & Co. Support Copilot — (your name)

An n8n workflow that reads each support email, classifies it with an LLM, looks up the order, drafts a reply with an AI agent, raises tickets, and logs everything to a Google Sheet. Replies are drafts only; nothing is sent.

- **Google Sheet (view access):** {sheet_link} — tab `Audit Log` has the 25 emails of the final run, tab `Tickets` has the 9 tickets.
- **5-minute recording:** VIDEO_URL_HERE
- **Test results:** [`TEST_REPORT.md`](TEST_REPORT.md)

## 1. Summary

{D}

- What I built (2–3 lines): a support copilot in n8n where the LLM only reads and writes language, and code decides privacy, refund eligibility, dates and duplicate tickets. It ran all 25 test emails end to end without manual fixes.
- Platform and LLM used: n8n 2.49.5 self-hosted on my laptop (Node, no Docker); Groq `openai/gpt-oss-20b` for classification; Google `gemini-3.5-flash-lite` for the reply agent with Groq `openai/gpt-oss-120b` as fallback. All on free tiers.
- Time spent (approx. hours): (fill in your real hours; see section 8 for how the work was split)
- What works / what doesn't: final run (v2) scored {v2['intent_correct']}/{v2['n']} on intent and {v2['action_correct']}/{v2['n']} on action against my own answer key, with valid JSON on the first try {v2['valid_json_first_try']}/{v2['n']} times. These numbers are in-sample (I tuned on the same 25 emails). What does not work well yet is listed in `TEST_REPORT.md` section 5.

## 2. Architecture

![workflow](./screenshots/workflow.png)

One webhook call is one email is one execution, so emails are handled strictly in order and each run is easy to inspect.

| Step / node | What it does | Why I designed it this way |
|---|---|---|
| Webhook: New Email | Receives one email as JSON and waits for the result. | Sequential processing guarantees a follow-up email sees the ticket created by the first one. |
| Config | Every setting: return window (7 days), damage window (2 days), confidence threshold (0.75), sheet ID, prompt version, list prices. | One place to change behaviour. |
| Normalize Email | Lower-cases the sender, extracts any `KC-####` in the text, wraps the email in `<email>` tags. | The email is treated as data; the extracted IDs let code verify the model never invents one. |
| IF: Bad Input | Returns HTTP 400 for a body with no id or sender. | Bad input should not create audit rows. |
| HTTP: Orders / HTTP: FAQ | Fetch `orders.json` and `faq.md` from the assignment repo. | The "order API" and the only policy source. |
| LLM: Classify | Small model, temperature 0, returns the required JSON. | A narrow job for a cheap, fast model. |
| Validate Classification | Code checks the JSON against the schema, confirms the order ID literally appears in the email, and corrects the language label from the script used. | "Valid every time" is enforced, not assumed. |
| LLM: Repair JSON / Validate Repair | One repair call when the first output is unusable. | Bounded retry. |
| Finalize Classification | Chooses first try, code-fixed, repaired, or a deterministic fallback (`other`, confidence 0, needs human). Records first-try validity. | The run always completes and the metric is honest. |
| Resolve Order | Looks up by order ID, else by sender email, and checks the sender owns the order. | Privacy is decided in code before the model sees any order data. |
| Compute Facts | Days since delivery from the email's `received_at`, return eligibility, refundable amount. | No date maths or policy decisions by the LLM; no wall clock. |
| Decide Route | Route, ticket needed, priority, needs-human reasons, and a verdict-only brief for the agent. Detects medical wording and instruction-like text in code. | Every hard rule in one place; email text cannot change priority or skip a ticket. |
| AI Agent: Draft Reply | Agent with two tools, `get_order` and `search_faq`. It receives verdicts only, so it must call the tools for any fact. | Meets the "agent decides which tools to call" requirement and keeps replies grounded. |
| get_order (sub-workflow tool) | Returns one order, only when the requester is its customer. The requester's email comes from the trigger, not from the model. | The model can never fetch another customer's order or the whole order file. |
| search_faq (sub-workflow tool) | Splits `faq.md` by heading and returns the best-matching section(s) word for word, or "not covered". | The FAQ is ~80 lines; section retrieval is exact and cheap. No vector store needed. |
| Postcheck Reply | Code checks the draft: no order details for a non-owner, no link except the real tracking link, no rupee amount or product size missing from the order/FAQ, no cure claims, no "refund approved". A failure replaces the draft with a neutral holding reply and flags it. | A model can be talked out of a rule; code cannot. |
| Ticket branch | Reads tickets; updates the open ticket for the order, or creates one whose ID comes from the order (`TKT-1052` for `KC-1052`). Idempotent on email ID. | One open ticket per order; no duplicates; two different orders can never get the same ticket ID. |
| Build Audit Row / Sheets: Upsert Audit Row | One row per email, keyed on `email_id|prompt_version`, written even when the agent fails. | Every email is logged; a retry cannot create a second row. |
| Build Response / Respond to Webhook | Returns the result as JSON. | The runner saves each response so runs can be scored. |

Supporting workflows: `Kesar tool: get_order`, `Kesar tool: search_faq`, `Kesar admin: reset sheet` (clears data rows before a run).

Source of truth: rule code in `code/lib/` (17 offline tests in `code/test/`), prompts in `prompts/`. `build/build_workflow.mjs` injects both into the workflow JSON, and `tools/deploy.py` loads it into n8n. The files in `workflow/` are exports from the running instance.

## 3. Setup — how someone else can run this

1. Accounts/credentials needed (no actual keys!): a Groq API key, a Google AI Studio (Gemini) API key, and a Google service account (Sheets API and Drive API enabled) with Editor access to a Google Sheet that has tabs `Audit Log` and `Tickets` (headers in `setup/`).
2. How to import the workflow: run n8n 2.49.5 (`bash tools/start_n8n.sh`, or any n8n 2.x). Import in this order: `workflow/kesar_tool_get_order.json`, `workflow/kesar_tool_search_faq.json`, `workflow/kesar_admin_reset_sheet.json`, `workflow/kesar_support_copilot.json`. Publish all four. In the main workflow, re-select the two sub-workflows in the `get_order` and `search_faq` tool nodes (workflow IDs differ per instance).
3. Where to configure environment variables / credentials: create three n8n credentials named `Groq (Kesar)`, `Gemini (Kesar)`, `Google SA (Kesar)` and select them on the model and Google Sheets nodes. Put your sheet ID in the `Config` node (`SHEET_ID`). Alternatively copy `.env.example` to `.env`, fill it, and run `python3 tools/n8n_credentials.py` then `python3 tools/deploy.py deploy main v2`, which builds and loads everything.
4. How to run the 25 test emails: `python3 tools/run_emails.py --url http://localhost:5678/webhook/kesar-support --delay 10 --out runs/mine` (or the assignment's `scripts/send_test_emails.py`). Score with `python3 tools/snapshot_sheet.py --sheet-url <sheet url> --out runs/mine` and `python3 tools/check_run.py --run runs/mine`.

Offline checks that need no accounts: `node --test code/test/rules.test.js`.

## 4. Prompts

Model settings: classifier Groq `openai/gpt-oss-20b`, temperature 0; agent Gemini `gemini-3.5-flash-lite`, temperature 0.2, max 5 iterations, fallback Groq `openai/gpt-oss-120b`. The email is always passed inside `<email>` tags. v1 prompts are in `prompts/classify_v1.md` and `prompts/agent_system_v1.md`.

**Classification (v2, `prompts/classify_v2.md`)**

```
{prompt('classify_v2.md')}
```

**Agent system prompt (v2, `prompts/agent_system_v2.md`)**

```
{prompt('agent_system_v2.md')}
```

The agent's user message is a `FACTS` block built by code (intent, reply language, order-lookup verdict, days since delivery, eligibility verdict, photos attached) followed by the email in `<email>` tags.

## 5. Key decisions and assumptions

- How I handle low-confidence classifications: `needs_human` is TRUE when confidence is below 0.75 **or** any rule fires: order not found, sender is not the order's customer, angry customer, medical wording, instruction-like text, declined refund, any complaint, cancelled order, out-of-scope request, FAQ gap, agent error, failed post-check. The rules carry the weight because the model's confidence is poorly calibrated: it reported 0.95 for almost every email, including the two-line "Where is it???". 0.75 is a safety net, not the main control.
- How I avoid duplicate tickets: before writing, the flow reads the Tickets tab and looks for a row with the same order ID whose status is not Closed. If found it appends the email ID and a dated note; otherwise it creates a ticket whose ID is derived from the order (`TKT-1052`). Re-sending an email already listed changes nothing. I learned the hard way that a counter-based ID is unsafe: in one test run two emails overlapped and one ticket overwrote another (see `runs/CHANGELOG_v1_to_v2.md`, change 14). Emails are processed strictly one at a time.
- How I make sure order details only go to the right customer: three layers, all in code. (1) The lookup returns no order data unless the sender's email equals the order's `customer_email`. (2) The `get_order` tool applies the same check, with the requester's email supplied by the workflow, not the model. (3) A post-check replaces any draft that still contains the order's tracking link, courier, address or dates.
- How I keep answers grounded in the FAQ: the agent gets no policy text up front; it must call `search_faq`, which returns FAQ sections word for word or says the topic is not covered. Post-checks reject links, rupee amounts and product sizes that are not in the order or the FAQ. Requests the FAQ does not cover (the GST invoice) get no draft and go to a human.
- Other assumptions:
  - Scenario date: all date logic uses each email's `received_at`; the wall clock is used only for `processed_at`.
  - "Within 48 hours" for damaged items is checked as 2 calendar days because `delivered_date` has no time.
  - Refundable amount on an ordinary return is the item subtotal (shipping and COD fees excluded), computed in code.
  - Customer email text is untrusted: it is wrapped as data, and ticket creation, priority and eligibility are decided in code, so text inside an email cannot change them.
  - Sheet writes use RAW mode so email text can never run as a spreadsheet formula.
  - `other` emails get no draft. Partnership pitches are logged with the FAQ's partnerships contact in the notes.
  - Development and the v1 run used a separate practice copy of the sheet; the main sheet holds only the final v2 run.
  - Stretch goals done: replies in the customer's language (Hindi and Hinglish), eligibility in a code node, token and cost estimate per email in the audit log (an estimate from character counts; measured usage is in `runs/v2/tokens.json`). Not done: custom backoff (I used n8n's Retry On Fail and paced the sender).

## 6. Scaling to 1,000 emails/day

What breaks first, in order:
1. **Google Sheets as the database.** Each email reads the whole Tickets tab and the upsert takes about 13 seconds per write in my runs. There is no locking, so two emails about the same order arriving together could both create a ticket. I would move tickets and the audit log to Postgres with a unique constraint on (order_id, open), and keep a Sheet only as a read-only view.
2. **LLM rate limits.** Free tiers throttled my last run (some replies took over a minute). At volume: a paid tier, a queue in front of the workflow with a fixed concurrency, and exponential backoff on 429.
3. **One execution per email is fine**, but n8n should run in queue mode with workers, and the webhook should acknowledge immediately instead of holding the connection.
4. **Idempotency.** Key every email on its message ID so a redelivered email cannot be processed twice (the audit upsert already does this per version).
5. **Monitoring.** Alert on error rate, needs-human rate, first-try JSON validity and post-check failures; keep the 25 emails (plus new ones) as a regression suite run on every prompt change.
6. **Cost.** About ${tok['cost_per_month_30000_usd']:.0f} a month at list prices (section 7), so cost is not the constraint; human review time is.
7. **Data.** Fetching the whole order file per email must become a real order API lookup by ID.

## 7. Product-thinking questions (≤150 words each)

{D}

1. **Auto-send vs. draft:** Facts to use: in the final run {v2['n'] - v2['needs_human_count']} of {v2['n']} emails were not flagged (clean order status, FAQ answers, eligible returns, spam and thanks); {v2['needs_human_count']} were flagged. The model's own confidence was 0.95 on nearly everything, so it cannot be the gate by itself. A cautious position: auto-send only order-status replies where the order was found, the sender owns it, and every post-check passed; keep everything involving money, complaints, privacy, medical wording or a missing order as drafts; start with 100% drafts for a week and measure how often a human sends them unchanged.

2. **Cost:** Measured in the final run: {tok['avg_tokens_in']} input and {tok['avg_tokens_out']} output tokens per email on average. Classifier: {tok['avg_classify_in']} × $0.075/M + {tok['avg_classify_out']} × $0.30/M = ${tok['cost_per_email_usd_classifier']:.6f}. Agent: {tok['avg_agent_in']} × $0.30/M + {tok['avg_agent_out']} × $2.50/M = ${tok['cost_per_email_usd_agent']:.6f}. Total ${tok['cost_per_email_usd']:.6f} per email; × 30,000 emails = ${tok['cost_per_month_30000_usd']:.2f} per month at paid list prices (read 24 Nov 2026). Add roughly 10% for retries. The assignment itself cost nothing (free tiers).

3. **Success metric:** Candidate metric: share of drafts a human sends without editing. Switch-off triggers worth naming: any order detail sent to a non-owner, any invented fact or promise reaching a customer, or the unedited-send rate staying low.

4. **Failure experience:** Facts: every reply is a draft; risky cases are flagged with a reason; a failed post-check swaps in a neutral holding reply; every email has an audit row. The realistic failure is a wrong or robotic draft that a human must catch, or an email logged as `other` that nobody answers.

5. **Don't automate:** Candidates from this build: approving a refund or replacement (needs photo verification and has fraud risk); answering anything about skin conditions or reactions.

## 8. How I used AI tools

{D}

Honest account of what happened, to rewrite in your own words:
- An AI coding agent (Claude, running in the OpenCode terminal tool) wrote and tested the workflow, the rule code, the unit tests, the prompts, the build and scoring scripts, and the first drafts of this README and the test report, working on my laptop under my direction. It also ran the test emails and read the results.
- What I did myself: (list truthfully, for example: created the Groq, Gemini and Google Cloud accounts and keys, created and shared the Google Sheets, enabled the APIs, reviewed and approved the expected answers, walked through every node, made practice changes by hand, wrote sections 1, 7 and 8, took the screenshots, recorded the video).
- Where I relied on my own judgment: (fill in, for example which emails should be flagged for a human, what to auto-send, which weaknesses to disclose).

## 9. If I had one more week

- Replace Google Sheets with a database for tickets and the audit log (locking, uniqueness, speed).
- Build a held-out test set of new emails and run each email several times to measure how stable the classification is.
- Track real token usage per email in the audit log (n8n exposes it in execution data) instead of a character-count estimate.
- Add automated failure tests (model down, sheet down, malformed input) to the test suite.
- A proper review screen for the human: approve, edit or reject each draft, and log the edit distance as the quality metric.
- Look at attached photos with a vision model before a human does, to pre-sort damage claims.
"""
target.write_text(text, encoding="utf-8")
print("wrote README.md")
