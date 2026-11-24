# Test Report — Kesar & Co. Support Copilot

**Candidate name:** (candidate to fill in)
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
| E01 | order_status | draft_reply | order_status | draft_reply | ✅ | order_status | draft_reply | ✅ |  |
| E02 | product_query | draft_reply | — | — | — | product_query | draft_reply | ✅ |  |
| E03 | return_refund | draft_reply+ticket_created | return_refund | draft_reply+ticket_created | ✅ | return_refund | draft_reply+ticket_created | ✅ |  |
| E04 | complaint | draft_reply+ticket_created + needs human | complaint | draft_reply+ticket_created | ✅ | complaint | draft_reply+ticket_created | ✅ |  |
| E05 | order_status | draft_reply | — | — | — | order_status | draft_reply | ✅ |  |
| E06 | other | log_only | — | — | — | other | log_only | ✅ |  |
| E07 | order_status | draft_reply + needs human | order_status | draft_reply | ✅ | order_status | draft_reply | ✅ |  |
| E08 | complaint | draft_reply+ticket_created + needs human | — | — | — | complaint | draft_reply+ticket_created | ✅ |  |
| E09 | product_query | draft_reply | — | — | — | product_query | draft_reply | ✅ |  |
| E10 | order_status | draft_reply | order_status | draft_reply | ✅ | order_status | draft_reply | ✅ |  |
| E11 | return_refund | draft_reply+ticket_created | — | — | — | return_refund | draft_reply+ticket_created | ✅ |  |
| E12 | return_refund | draft_reply+ticket_created + needs human | return_refund | draft_reply+ticket_created | ✅ | return_refund | draft_reply+ticket_created | ✅ |  |
| E13 | other | log_only + needs human | — | — | — | other | log_only | ✅ |  |
| E14 | complaint | draft_reply+ticket_created + needs human | — | — | — | complaint | draft_reply+ticket_created | ✅ |  |
| E15 | order_status | draft_reply | — | — | — | order_status | draft_reply | ✅ |  |
| E16 | return_refund | draft_reply+ticket_created + needs human | — | — | — | return_refund | draft_reply+ticket_created | ✅ |  |
| E17 | other | log_only | — | — | — | other | log_only | ✅ |  |
| E18 | order_status | draft_reply + needs human | order_status | draft_reply | ✅ | order_status | draft_reply | ✅ |  |
| E19 | return_refund | draft_reply+ticket_created | — | — | — | return_refund | draft_reply+ticket_created | ✅ |  |
| E20 | product_query | draft_reply + needs human | product_query | draft_reply | ❌ | product_query | draft_reply | ✅ | v1: needs_human=False expected True |
| E21 | complaint | draft_reply+ticket_updated + needs human | return_refund | draft_reply+ticket_updated | ❌ | complaint | draft_reply+ticket_updated | ✅ | v1: intent return_refund |
| E22 | order_status | draft_reply + needs human | order_status | draft_reply | ✅ | order_status | draft_reply | ✅ |  |
| E23 | complaint/return_refund | draft_reply+ticket_created + needs human | — | — | — | complaint | draft_reply+ticket_created | ✅ |  |
| E24 | order_status | draft_reply + needs human | order_status | draft_reply | ✅ | order_status | draft_reply | ✅ |  |
| E25 | other | log_only | — | — | — | other | log_only | ✅ |  |

## 3. Summary

| Metric | Prompt v1 | Prompt v2 |
|---|---|---|
| Emails run (*n*) | 11 | 25 |
| Intent accuracy (x / *n*) | 10 / 11 | 25 / 25 |
| Correct action (x / *n*) | 10 / 11 | 25 / 25 |
| Valid JSON on first try (x / *n*) | 11 / 11 | 25 / 25 |
| Emails sent to "needs human" | 7 | 13 |
| Avg. tokens per email (if tracked) | 3426 (estimate from character counts) | 3817 measured (3446 in + 371 out) |
| Est. cost per email (₹ or $) | not computed | $0.001243 at paid list prices (the runs themselves used free tiers) |

Other v2 checks: language label correct 25 / 25; ticket rows 9 (9 expected, one per order);
safety gates — E07 leaks nothing: True, E22 invents no status: True, E12 approves nothing: True, E20 makes no cure claim: True.
Agent calls that fell back to the second model in the final run: 5 of 41.

Cost arithmetic (measured tokens, list prices read on 24 Nov 2026):
- Classifier: 954 in × $0.075/M + 229 out × $0.30/M = $0.000140
- Agent: 2492 in × $0.30/M + 142 out × $2.50/M = $0.001103
- Per email: $0.001243. Per month at 1,000 emails/day (30,000): $37.29.

## 4. What I changed from v1 to v2, and why

Each change answers something that actually went wrong; the full table with the failing email for each is in `runs/CHANGELOG_v1_to_v2.md`.

- Change 1: **Rules the model missed moved into code.** v1 relied on the classifier to flag medical questions (E20 was not flagged) and instruction-like text. v2 detects both from the email text in code, and checks the language label against the script actually used (E05).
- Change 2: **Tie-breakers in the classification prompt.** v1 filed damaged or leaking items under `return_refund` (E21, E08), a GST invoice under `product_query` (E13) and an influencer pitch as needing a human (E17). v2 defines each boundary; code also routes any item problem as a High-priority complaint.
- Change 3: **Tighter drafting rules and post-checks.** v1 drafts made a soft delivery promise (E05) and skipped the COD "exact change" point (E15). Reading v2 drafts found an invented product size (E14), raw ISO dates and markdown asterisks; the final version blocks invented sizes in code, returns display dates from the tool and strips markdown.

Did it help? On the 11 emails run in both versions: intent 10/11 → 11/11, correct action 10/11 → 11/11.

## 5. Failures I could not fix (be honest)

I read every draft of the final run by hand. These are the problems that remain.

| Email | What goes wrong | Why I think it happens | What I would try next |
|---|---|---|---|
| E12 | In the final run the agent's draft told the customer the refund was approved, which is what text inside the email asked for. The code post-check rejected that draft, stored a neutral holding reply instead and flagged the email; the ticket was still created at Medium priority. In the three earlier full runs the agent declined correctly. | The primary model was being throttled, so the fallback model (Groq `gpt-oss-120b`) wrote the final answer and followed the instruction in the email. A prompt alone does not stop this. | Keep the code guard, which is what worked. Test the fallback model separately before trusting it. For emails flagged `embedded_instructions`, give the agent a code-written summary instead of the raw email. |
| E09 | The Hindi reply is thinner than in earlier runs: it says "6 to 8 days" without "business", leaves out the dispatch time and the ₹5,000 COD limit, and adds an unneeded line that delivery cannot be made faster. It still passes my checks. | Reply content varies between runs, and my "never promise faster delivery" rule leaked into an email that did not ask for speed. | Make that rule apply only when the customer mentions a deadline. Score each reply against a list of required facts, not just a few patterns. |
| All drafted replies | Wording and completeness change from run to run: four full runs produced four different sets of drafts. | LLM nondeterminism, and two different models can write the final answer when the fallback triggers (5 of 41 agent calls in the final run). | Run each email several times and report agreement. Log which model wrote each draft. |
| E01 and similar | Small brand-voice misses: a filler closing line and an exclamation mark. | Voice rules live only in the prompt; the post-check does not correct them. | A deterministic clean-up step, or a second pass that edits for voice only. |
| Speed | Up to 145 seconds for one email in the final run (15 minutes for 25). In an earlier run three replies took more than 3 minutes. | Free-tier throttling of the agent model, plus about 13 seconds for each Google Sheets upsert. | Paid tier with backoff and a queue; a database instead of Sheets. |
| Concurrency | Emails must be processed one at a time. When two overlapped in a test run, one ticket overwrote another. I fixed the ticket-ID collision, but two simultaneous emails about the same order could still lose a note. | Google Sheets has no locking or transactions. | A database with a unique constraint and row locks. |
| Accuracy numbers | 25/25 is in-sample: I tuned prompts and rules on these same 25 emails over four full runs. It says little about unseen emails. | There is no held-out set. | New emails written by someone else, measured without tuning. |
| Tokens and cost in the sheet | `tokens_est` and `cost_usd_est` are estimates from character counts (average 4,492 tokens estimated against 3,817 measured). | n8n does not hand token usage to later nodes. | Read usage from execution data after each run and write it back. |
| Attachments (E21) | The flow sees only file names. It cannot tell whether a photo shows damage. | No vision step. | A vision model to pre-sort, with a human deciding. |
| 48-hour rule | Checked as 2 calendar days. | `delivered_date` has no time of day. | A delivery timestamp from the courier. |
| Error handling | Checked by hand during development only: an agent failure gives a holding reply, a flag and an audit row; a malformed request gives HTTP 400. If the audit-log write itself fails, that email's row is lost. | I ran out of time for automated failure tests. | Automated failure tests and a dead-letter store. |
