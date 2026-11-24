#!/usr/bin/env python3
"""Build the workflows from source and load them into the local n8n through its public API.

  python3 tools/deploy.py deploy practice v1      build + create/update + activate everything
  python3 tools/deploy.py deploy main v2
  python3 tools/deploy.py errors 5                show the last 5 executions and any error
  python3 tools/deploy.py export                  save the live workflows into workflow/

Reads N8N_URL and N8N_API_KEY from .env. Never prints them.
"""
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "out"
CRED_NAMES = {"groqApi": "Groq (Kesar)", "googlePalmApi": "Gemini (Kesar)", "googleApi": "Google SA (Kesar)"}
TOOL_FILES = {"Kesar tool: get_order": "kesar_tool_get_order.json", "Kesar tool: search_faq": "kesar_tool_search_faq.json",
              "Kesar admin: reset sheet": "kesar_admin_reset_sheet.json", "Kesar admin: setup sheet": "kesar_admin_setup_sheet.json"}


def load_env():
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env()


def api(method, path, body=None):
    url = ENV.get("N8N_URL", "http://localhost:5678").rstrip("/") + "/api/v1" + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"X-N8N-API-KEY": ENV.get("N8N_API_KEY", ""), "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode("utf-8")
            return r.status, (json.loads(text) if text.strip() else {})
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, {"message": text[:500]}


def sheet_id(url):
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", url or "")
    return m.group(1) if m else ""


def list_all(path):
    items, cursor = [], None
    while True:
        status, res = api("GET", path + ("&" if "?" in path else "?") + "limit=100" + (f"&cursor={cursor}" if cursor else ""))
        if status != 200:
            sys.exit(f"GET {path} failed: {status} {str(res)[:300]}")
        items += res.get("data", [])
        cursor = res.get("nextCursor")
        if not cursor:
            return items


def context(agent_primary=None):
    creds = {}
    all_creds = list_all("/credentials")
    for ctype, name in CRED_NAMES.items():
        match = [c for c in all_creds if c.get("type") == ctype and c.get("name") == name] or [c for c in all_creds if c.get("type") == ctype]
        if not match:
            sys.exit(f"Missing n8n credential of type {ctype} (expected name '{name}'). Create it in the n8n UI.")
        creds[ctype] = {"id": match[0]["id"], "name": match[0]["name"]}
    gemini = ENV.get("GEMINI_MODEL", "")
    rpd, rpm = int(ENV.get("GEMINI_RPD") or 0), int(ENV.get("GEMINI_RPM") or 0)
    groq_big = {"provider": "groq", "model": "openai/gpt-oss-120b"}
    gem = {"provider": "gemini", "model": gemini} if gemini else None
    if agent_primary is None:
        agent_primary = "gemini" if gem and rpd >= 500 and rpm >= 10 else "groq"
    models = {"classify": {"provider": "groq", "model": "openai/gpt-oss-20b"}, "classify_fallback": gem,
              "agent": gem if agent_primary == "gemini" and gem else groq_big,
              "agent_fallback": groq_big if agent_primary == "gemini" and gem else gem}
    prices = json.loads((ROOT / "build" / "prices.json").read_text()) if (ROOT / "build" / "prices.json").exists() else None
    workflows = {w["name"]: w["id"] for w in list_all("/workflows")}
    ctx = {"credentials": creds, "models": models, "prices": prices, "workflows": workflows,
           "sheets": {"practice": sheet_id(ENV.get("SHEET_URL_PRACTICE")), "main": sheet_id(ENV.get("SHEET_URL_MAIN"))}}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "context.json").write_text(json.dumps(ctx, indent=2), encoding="utf-8")
    return ctx


def build(env, pv, only):
    r = subprocess.run(["node", "build/build_workflow.mjs", "--env", env, "--prompt-version", pv, "--only", only], cwd=ROOT, capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        sys.exit("build failed: " + r.stderr[-800:])


def upsert(file):
    wf = json.loads((OUT / file).read_text(encoding="utf-8"))
    existing = {w["name"]: w["id"] for w in list_all("/workflows")}
    body = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"], "settings": wf["settings"]}
    if wf["name"] in existing:
        wid = existing[wf["name"]]
        status, res = api("PUT", f"/workflows/{wid}", body)
    else:
        status, res = api("POST", "/workflows", body)
        wid = res.get("id")
    if status not in (200, 201):
        sys.exit(f"upsert {wf['name']} failed: {status} {json.dumps(res)[:600]}")
    api("POST", f"/workflows/{wid}/deactivate")
    status, res = api("POST", f"/workflows/{wid}/activate")
    state = "active" if status == 200 else f"NOT active ({status} {str(res.get('message', res))[:200]})"
    print(f"  {wf['name']}: id={wid} {state}")
    return wid


def cmd_deploy(env, pv, agent_primary=None):
    if not ENV.get("N8N_API_KEY"):
        sys.exit("N8N_API_KEY is empty in .env")
    ctx = context(agent_primary)
    if not ctx["sheets"][env]:
        sys.exit(f"SHEET_URL_{env.upper()} is empty in .env")
    print(f"models: classify={ctx['models']['classify']['model']} agent={ctx['models']['agent']['model']} "
          f"fallback={(ctx['models']['agent_fallback'] or {}).get('model')}")
    build(env, pv, "tools")
    for name, file in TOOL_FILES.items():
        upsert(file)
    context(agent_primary)  # refresh sub-workflow ids for the tool nodes
    build(env, pv, "main")
    upsert(f"kesar_support_copilot_{env}.json")


def cmd_errors(n=5):
    status, res = api("GET", f"/executions?limit={n}&includeData=true")
    if status != 200:
        sys.exit(f"{status} {str(res)[:300]}")
    names = {w["id"]: w["name"] for w in list_all("/workflows")}
    for ex in res.get("data", []):
        rd = ((ex.get("data") or {}).get("resultData") or {})
        err = rd.get("error") or {}
        print(f"#{ex.get('id')} {names.get(ex.get('workflowId'), ex.get('workflowId'))} status={ex.get('status')} last={rd.get('lastNodeExecuted')}")
        if err:
            node = (err.get("node") or {}).get("name")
            print(f"   ERROR at {node}: {str(err.get('message'))[:300]} | {str(err.get('description') or '')[:300]}")
        for node, runs in (rd.get("runData") or {}).items():
            for run in runs:
                if run.get("error"):
                    e = run["error"]
                    print(f"   node '{node}' error: {str(e.get('message'))[:300]} | {str(e.get('description') or '')[:200]}")


def cmd_export():
    names = {"Kesar Support Copilot": "kesar_support_copilot.json", "Kesar tool: get_order": "kesar_tool_get_order.json",
             "Kesar tool: search_faq": "kesar_tool_search_faq.json", "Kesar admin: reset sheet": "kesar_admin_reset_sheet.json"}
    live = {w["name"]: w["id"] for w in list_all("/workflows")}
    (ROOT / "workflow").mkdir(exist_ok=True)
    for name, file in names.items():
        if name not in live:
            print(f"  (not found) {name}")
            continue
        status, wf = api("GET", f"/workflows/{live[name]}")
        keep = {k: wf.get(k) for k in ("name", "nodes", "connections", "settings")}
        (ROOT / "workflow" / file).write_text(json.dumps(keep, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  exported {name} -> workflow/{file} ({len(keep['nodes'])} nodes)")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == "deploy":
        primary = a[a.index("--agent-primary") + 1] if "--agent-primary" in a else None
        cmd_deploy(a[1], a[2], primary)
    elif a[0] == "errors":
        cmd_errors(int(a[1]) if len(a) > 1 else 5)
    elif a[0] == "export":
        cmd_export()
    elif a[0] == "api":
        s, r = api(a[1], a[2], json.loads(a[3]) if len(a) > 3 else None)
        print(s, json.dumps(r, indent=1)[:4000])
    else:
        sys.exit(__doc__)
