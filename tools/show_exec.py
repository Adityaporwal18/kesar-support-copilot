#!/usr/bin/env python3
"""Debug helper: print what each node produced in the most recent run of the main workflow.
  python3 tools/show_exec.py [practice|main] [node name filter ...]"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy
env = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ("practice", "main") else "practice"
filters = [a for a in sys.argv[1:] if a not in ("practice", "main")]
name = "Kesar Support Copilot" + (" (practice)" if env == "practice" else "")
wid = {w["name"]: w["id"] for w in deploy.list_all("/workflows")}[name]
s, r = deploy.api("GET", f"/executions?workflowId={wid}&limit=1&includeData=true")
ex = r["data"][0]; rd = ex["data"]["resultData"]
print("execution", ex["id"], ex["status"], "| last node:", rd.get("lastNodeExecuted"))
for node, runs in rd["runData"].items():
    if filters and not any(f.lower() in node.lower() for f in filters):
        continue
    for run in runs:
        if run.get("error"):
            print(f"  {node}: ERROR {str(run['error'].get('message'))[:300]} | {str(run['error'].get('description') or '')[:300]}")
            continue
        outs = run.get("data") or {}
        key = [k for k in outs if outs[k]][:1]
        items = outs[key[0]][0] if key and outs[key[0]] and outs[key[0]][0] else []
        j = items[0].get("json") if items else None
        print(f"  {node}: {json.dumps(j, ensure_ascii=False)[:900] if j is not None else '(no items)'}")
