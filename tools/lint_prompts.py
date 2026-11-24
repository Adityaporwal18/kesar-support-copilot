#!/usr/bin/env python3
"""Check the prompt files: required content is present, and no text was copied from the test emails."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
d = Path(sys.argv[sys.argv.index("--dir") + 1]) if "--dir" in sys.argv else ROOT / "prompts"
problems = []
need = {"classify_v1.md": ["intent", "secondary_intent", "order_id", "sentiment", "language", "confidence", "summary",
                           "order_status", "product_query", "return_refund", "complaint", "other"],
        "agent_system_v1.md": ["Warm regards", "get_order", "search_faq"], "classify_repair.md": ["JSON"]}
need["classify_v2.md"], need["agent_system_v2.md"] = need["classify_v1.md"], need["agent_system_v1.md"]
for name, words in need.items():
    f = d / name
    if not f.exists():
        problems.append(f"missing {name}")
        continue
    text = f.read_text(encoding="utf-8")
    problems += [f"{name}: lacks '{w}'" for w in words if w not in text]
    if "{" in text or "}" in text:
        problems.append(f"{name}: contains a curly brace (breaks n8n prompt templates)")
bodies = [e["body"] for e in json.loads((ROOT / "assignment/data/test_emails.json").read_text(encoding="utf-8"))["emails"]]
for f in d.glob("*.md"):
    text = " ".join(f.read_text(encoding="utf-8").split())
    for b in bodies:
        b = " ".join(b.split())
        if any(b[i:i + 40] in text for i in range(0, max(1, len(b) - 40), 10)):
            problems.append(f"{f.name}: contains text copied from a test email")
            break
print("\n".join(problems) if problems else "prompts ok")
sys.exit(1 if problems else 0)
