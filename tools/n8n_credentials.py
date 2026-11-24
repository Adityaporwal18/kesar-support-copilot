#!/usr/bin/env python3
"""Create the three n8n credentials from values you put in .env. Prints names only, never values.

.env keys read:  GROQ_API_KEY, GEMINI_API_KEY, GOOGLE_SA_JSON (path to the service-account key file)
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy  # noqa: E402  (loads .env, provides api())

env = deploy.ENV
existing = {(c.get("type"), c.get("name")) for c in deploy.list_all("/credentials")}
todo = []

if env.get("GROQ_API_KEY"):
    todo.append(("groqApi", "Groq (Kesar)", {"apiKey": env["GROQ_API_KEY"]}))
else:
    print("skip Groq: GROQ_API_KEY is empty")
if env.get("GEMINI_API_KEY"):
    todo.append(("googlePalmApi", "Gemini (Kesar)", {"host": "https://generativelanguage.googleapis.com", "apiKey": env["GEMINI_API_KEY"]}))
else:
    print("skip Gemini: GEMINI_API_KEY is empty")
sa_path = env.get("GOOGLE_SA_JSON")
if sa_path:
    p = Path(sa_path).expanduser()
    if not p.exists():
        sys.exit(f"GOOGLE_SA_JSON points to a file that does not exist: {p}")
    if deploy.ROOT in p.resolve().parents:
        sys.exit("Move the service-account key file OUT of the project folder (it must never be committed).")
    sa = json.loads(p.read_text())
    todo.append(("googleApi", "Google SA (Kesar)", {"region": "us-central1", "email": sa["client_email"], "privateKey": sa["private_key"],
                                                    "inpersonate": False, "httpNode": False}))
    print("service account email (share both spreadsheets with this address as Editor):", sa["client_email"])
else:
    print("skip Google: GOOGLE_SA_JSON is empty")

for ctype, name, data in todo:
    if (ctype, name) in existing:
        print(f"exists: {name}")
        continue
    status, res = deploy.api("POST", "/credentials", {"name": name, "type": ctype, "data": data})
    print(f"{'created' if status in (200, 201) else 'FAILED ' + str(status) + ' ' + str(res.get('message'))[:200]}: {name}")
