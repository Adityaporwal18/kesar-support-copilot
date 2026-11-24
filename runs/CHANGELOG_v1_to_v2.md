# What changed from v1 to v2, and the observed failure behind each change

v1 = first complete version (prompts `classify_v1.md`, `agent_system_v1.md`), written before any model output was seen.
Official v1 run: 11 emails (`runs/v1`). The other 14 emails were then run once on v1 as a development check (not part of the v1 score).
Every change below is tied to something that actually went wrong.

| # | Email | What went wrong in v1 | Cause | Change in v2 |
|---|---|---|---|---|
| 1 | E20 (official v1) | Reply was correct (no cure claim) but the email was NOT flagged for a human. | The classifier did not set the `medical` risk flag; the rule depended on the model. | Code rule: medical or skin-reaction words in the email set the flag without the model (`code/lib/decide_route.js`). Prompt: each risk flag is now defined. |
| 2 | E21 (official v1) | Follow-up about a cracked jar was classified `return_refund` instead of `complaint`. | v1 prompt had no tie-breaker between "item problem" and "wants money back". | Prompt tie-breakers. Code rule: a damaged, leaking, wrong or missing item is routed as a complaint (High priority, human verifies) even if the model says `return_refund`. |
| 3 | E08 (dev check) | Leaking product + refund demand classified `return_refund`; the ticket got Medium priority and the wrong reason (`refund_declined`). | Same as 2. | Same as 2. Now `complaint`, High, with `angry_customer` and `public_threat`. |
| 4 | E13 (dev check) | GST invoice request classified `product_query`; the agent wrote a holding reply. Safe, but the FAQ has no answer, so no draft should be written. | v1 definition of `product_query` was too wide. | Prompt: invoices and paperwork are `other` / `business_request` (logged, flagged for a human, no draft). |
| 5 | E17 (dev check) | Influencer pitch was flagged for a human. | `other_category` values were not defined, so it was not marked `partnership`. | Prompt: each `other_category` value is defined. |
| 6 | E05 (dev check) | Draft said the team would "try their best" to deliver before the customer's trip. Policy promises nothing like that, and the ETA is the travel day. | Agent prompt did not forbid soft promises. | Agent prompt: never promise faster delivery or effort to meet a deadline; say plainly when the ETA does not fit. |
| 7 | E15 (dev check) | COD reply omitted the FAQ's "keep exact change" point. | Agent did not consult the FAQ for a COD order. | Agent prompt: when cash on delivery is mentioned, also check the COD policy. |
| 8 | E12 (official v1) | Handled correctly (declined, ticket created, nothing approved), but the instruction-like text inside the email was not flagged. | The flag depended on the model. | Code rule: text addressed to an AI or trying to override rules sets `embedded_instructions`. It never changes routing or priority. |

Not changed: models, temperatures, the answer key, the pipeline shape.
After these changes the 10 affected emails were re-run once on the practice sheet (`runs/dev4`): 10/10 intent and 10/10 action.
