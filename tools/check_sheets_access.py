#!/usr/bin/env python3
"""Check that the service account can read both spreadsheets through the Google Sheets API.
Prints status only (no secrets). Exit 0 when both are reachable."""
import base64, json, os, re, subprocess, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy
env = deploy.ENV
sa = json.load(open(os.path.expanduser(env["GOOGLE_SA_JSON"])))
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
now = int(time.time())
unsigned = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()) + "." + b64(json.dumps({
    "iss": sa["client_email"], "scope": "https://www.googleapis.com/auth/spreadsheets.readonly",
    "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 600}).encode())
with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
    f.write(sa["private_key"]); keyfile = f.name
sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", keyfile], input=unsigned.encode(), capture_output=True).stdout
os.unlink(keyfile)
tok = json.loads(subprocess.run(["curl", "-s", "-X", "POST", "https://oauth2.googleapis.com/token", "-d",
    "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer", "-d", "assertion=" + unsigned + "." + b64(sig)], capture_output=True, text=True).stdout)
ok = True
for k in ("SHEET_URL_PRACTICE", "SHEET_URL_MAIN"):
    sid = deploy.sheet_id(env.get(k, ""))
    r = json.loads(subprocess.run(["curl", "-s", f"https://sheets.googleapis.com/v4/spreadsheets/{sid}?fields=properties.title,sheets.properties.title",
                                   "-H", "Authorization: Bearer " + tok.get("access_token", "")], capture_output=True, text=True).stdout)
    if "error" in r:
        ok = False
        print(k, "ERROR", r["error"].get("status"), "-", re.sub(r"project \d+", "the project", r["error"].get("message", ""))[:160])
    else:
        print(k, "OK:", r["properties"]["title"], "| tabs:", [s["properties"]["title"] for s in r["sheets"]])
sys.exit(0 if ok else 1)
