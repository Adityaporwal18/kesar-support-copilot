#!/usr/bin/env python3
"""One-time local setup: create the n8n owner account and an API key.
The login is saved to private/n8n_login.txt and the key to .env. Nothing secret is printed."""
import http.cookiejar, json, re, secrets, string, sys, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
BASE = "http://localhost:5678"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(method, path, body=None):
    headers = {"Content-Type": "application/json", "browser-id": "kesar-bootstrap"}
    cookies = "; ".join(f"{c.name}={c.value}" for c in jar)  # the auth cookie is flagged Secure; send it by hand over http://localhost
    if cookies:
        headers["Cookie"] = cookies
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with opener.open(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"message": e.read().decode(errors="replace")[:400]}

login_file = ROOT / "private" / "n8n_login.txt"
if login_file.exists():
    email, password = [l.split(": ", 1)[1] for l in login_file.read_text().splitlines()[:2]]
    s, r = call("POST", "/rest/login", {"emailOrLdapLoginId": email, "password": password})
    print("login:", s)
else:
    email = "owner@kesar.local"
    password = "Ks" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(14)) + "7a"
    s, r = call("POST", "/rest/owner/setup", {"email": email, "firstName": "Kesar", "lastName": "Owner", "password": password})
    print("owner setup:", s, "" if s == 200 else r.get("message"))
    if s != 200:
        sys.exit(1)
    login_file.write_text(f"email: {email}\npassword: {password}\nurl: {BASE}\n")
    login_file.chmod(0o600)

s, scopes = call("GET", "/rest/api-keys/scopes")
scope_list = scopes.get("data") if isinstance(scopes.get("data"), list) else None
body = {"label": "kesar-worker", "expiresAt": None}
if scope_list:
    body["scopes"] = scope_list
s, r = call("POST", "/rest/api-keys", body)
key = (r.get("data") or {}).get("rawApiKey")
print("api key:", s, "created" if key else r.get("message"), f"(scopes: {len(scope_list) if scope_list else 'n/a'})")
if not key:
    sys.exit(1)
env = ROOT / ".env"
text = env.read_text()
text = re.sub(r"^N8N_API_KEY=.*$", "N8N_API_KEY=" + key, text, flags=re.M) if re.search(r"^N8N_API_KEY=", text, flags=re.M) else text + "\nN8N_API_KEY=" + key + "\n"
env.write_text(text)
print("saved: login -> private/n8n_login.txt, key -> .env")
