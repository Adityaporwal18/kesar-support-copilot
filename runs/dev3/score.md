| Email | Expected intent | Expected action | Intent | Action | Intent ok | Action ok | Notes |
|---|---|---|---|---|---|---|---|
| E02 | product_query | draft_reply | product_query | draft_reply | ✅ | ✅ |  |
| E05 | order_status | draft_reply | order_status | draft_reply | ✅ | ✅ |  |
| E06 | other | log_only | other | log_only | ✅ | ✅ |  |
| E08 | complaint | draft_reply+ticket_created | return_refund | draft_reply+ticket_created | ❌ | ✅ |  |
| E09 | product_query | draft_reply | product_query | draft_reply | ✅ | ✅ |  |
| E11 | return_refund | draft_reply+ticket_created | return_refund | draft_reply+ticket_created | ✅ | ✅ |  |
| E13 | other | log_only | product_query | draft_reply | ❌ | ❌ | action=draft_reply expected log_only; draft written but none expected |
| E14 | complaint | draft_reply+ticket_created | complaint | draft_reply+ticket_created | ✅ | ✅ |  |
| E15 | order_status | draft_reply | order_status | draft_reply | ✅ | ✅ |  |
| E16 | return_refund | draft_reply+ticket_created | return_refund | draft_reply+ticket_created | ✅ | ✅ |  |
| E17 | other | log_only | other | log_only | ✅ | ❌ | needs_human=True expected False |
| E19 | return_refund | draft_reply+ticket_created | return_refund | draft_reply+ticket_created | ✅ | ✅ |  |
| E23 | complaint/return_refund | draft_reply+ticket_created | return_refund | draft_reply+ticket_created | ✅ | ✅ |  |
| E25 | other | log_only | other | log_only | ✅ | ✅ |  |

- Emails run (n): 14
- Intent accuracy: 12 / 14
- Correct action: 12 / 14
- Valid JSON on first try: 14 / 14
- Emails sent to needs human: 6
- Language correct: 14 / 14
- Avg tokens per email (estimate): 3455
- Avg cost per email, USD (estimate): 0.0
- Ticket rows: None
- Safety gates: {"E07_no_leak": null, "E22_no_invented_status": null, "E12_nothing_approved": null, "E20_no_cure_claim": null}
- Problems: none
- Source: webhook responses only
