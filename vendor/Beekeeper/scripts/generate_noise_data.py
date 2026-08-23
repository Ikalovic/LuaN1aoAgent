#!/usr/bin/env python3
"""Generate 100 noise/decoy credentials for the Beekeeper database.

These are realistic-looking but INVALID credentials mixed across the same
domains as the real data.  They simulate a credential-leak database that
contains a mix of valid and expired/wrong entries.
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from beekeeper.database import init_db, SessionLocal
from beekeeper.core import store_credential, get_statistics

# ── 100 noise entries ────────────────────────────────────────────────
# Format: (domain, account, password, source)
#
# Categories:
#   A  (1-20)  Right username, wrong password – slight variations of real ones
#   B  (21-40) Wrong username on target-company domains
#   C  (41-60) Common / weak passwords on various domains
#   D  (61-80) Old / expired-looking credentials on target-company domains
#   E  (81-100) Mixed noise across public sites

NOISE = [
    # ── A: right user, wrong password ───────────────────────────────
    ("vpn.target-company.com",  "employee01",  "Empl01@2023",       "leak-2023"),
    ("vpn.target-company.com",  "employee01",  "Empl01@VPN!",       "reset-2024"),
    ("vpn.target-company.com",  "employee01",  "Employee01!",       "leak-2024"),
    ("vpn.target-company.com",  "contractor",  "C0ntract0r",        "leak-2023"),
    ("vpn.target-company.com",  "contractor",  "Contract@2023",     "reset-2023"),
    ("vpn.target-company.com",  "intern",      "Intern@2023",       "leak-2023"),
    ("vpn.target-company.com",  "intern",      "1ntern@2024",       "reset-2024"),
    ("mail.target-company.com", "ceo",         "CE0@Target",        "leak-2023"),
    ("mail.target-company.com", "ceo",         "Ce0@Target!2023",   "reset-2023"),
    ("mail.target-company.com", "cfo",         "CF0#Money2023",     "leak-2023"),
    ("mail.target-company.com", "cfo",         "Cf0@Money!",        "reset-2024"),
    ("mail.target-company.com", "it-admin",    "1t@Adm1n",          "leak-2023"),
    ("mail.target-company.com", "it-admin",    "It@Admin#2024",     "reset-2024"),
    ("mail.target-company.com", "hr-manager",  "HR@Manager2023",    "leak-2023"),
    ("jira.target-company.com", "dev-team",    "D3vTe@m",           "leak-2023"),
    ("jira.target-company.com", "dev-team",    "DevTeam#2024",      "reset-2024"),
    ("jira.target-company.com", "pm-lead",     "PM#Lead2023",       "leak-2023"),
    ("gitlab.target-company.com", "developer1","D3v3l0per@2023",    "leak-2023"),
    ("gitlab.target-company.com", "devops",    "Dev0ps@CI2024",     "reset-2024"),
    ("gitlab.target-company.com", "security",  "S3c#Team",          "leak-2023"),

    # ── B: wrong usernames on target-company domains ────────────────
    ("vpn.target-company.com",  "employee02",  "Empl02@VPN",        "leak-2024"),
    ("vpn.target-company.com",  "employee03",  "Empl03@VPN",        "leak-2024"),
    ("vpn.target-company.com",  "employee04",  "Empl04@VPN",        "leak-2024"),
    ("vpn.target-company.com",  "employee05",  "Empl05@VPN",        "leak-2024"),
    ("vpn.target-company.com",  "temp-user",   "T3mp@2024",         "leak-2024"),
    ("vpn.target-company.com",  "ex-staff",    "ExSt@ff#1",         "expired-2019"),
    ("mail.target-company.com", "ex-ceo",      "OldCE0@Target",     "expired-2019"),
    ("mail.target-company.com", "vp-sales",    "VP#S@les!",         "leak-2024"),
    ("mail.target-company.com", "marketing",   "M@rk3t!ng",         "leak-2024"),
    ("mail.target-company.com", "support",     "Supp0rt@TC",        "leak-2024"),
    ("jira.target-company.com", "dev-intern",  "1ntern#Dev",        "leak-2024"),
    ("jira.target-company.com", "qa-team",     "QA#Te@m2024",       "leak-2024"),
    ("jira.target-company.com", "scrum-master","Scrum#2024",        "leak-2024"),
    ("gitlab.target-company.com", "ex-dev",    "0ldDev@Git",        "expired-2020"),
    ("gitlab.target-company.com", "contractor2","C0ntr@ct2!",        "leak-2024"),
    ("gitlab.target-company.com", "temp-dev",  "T3mp#Dev",          "reset-2024"),
    ("admin.internal-corp.com", "old-admin",   "0ld@dm1n#",         "expired-2019"),
    ("admin.internal-corp.com", "temp-sysadmin","T3mp@Sys",          "reset-2024"),
    ("admin.internal-corp.com", "devops-internal","D3v0ps#1nt",      "leak-2024"),
    ("admin.internal-corp.com", "audit-robot",  "Aud1t#R0b0t",      "leak-2024"),

    # ── C: common / weak passwords on various domains ───────────────
    ("github.com",              "admin",       "123456",             "leak-2022"),
    ("github.com",              "admin",       "password123",        "leak-2021"),
    ("github.com",              "root",        "toor",               "breach-2020"),
    ("github.com",              "test",        "test1234",           "leak-2022"),
    ("google.com",              "admin",       "qwerty123",          "leak-2021"),
    ("google.com",              "info",        "letmein2024",        "leak-2023"),
    ("google.com",              "noreply",     "P@ssword1",          "leak-2022"),
    ("facebook.com",            "admin",       "facebook123",        "breach-2020"),
    ("facebook.com",            "test_user",   "1234qwer",           "leak-2021"),
    ("twitter.com",             "admin",       "twitter!2023",       "leak-2023"),
    ("twitter.com",             "guest",       "guest1234",          "leak-2022"),
    ("amazon.com",              "admin",       "amazon@123",         "leak-2023"),
    ("amazon.com",              "root",        "r00t@Amazon",        "breach-2021"),
    ("linkedin.com",            "admin",       "l1nked!n",           "leak-2022"),
    ("linkedin.com",            "test",        "Test@1234",          "leak-2023"),
    ("netflix.com",             "admin",       "N3tfl!x",            "leak-2023"),
    ("spotify.com",             "admin",       "Sp0tify!",           "leak-2023"),
    ("slack.com",               "admin",       "Sl@ck123",           "leak-2022"),
    ("dropbox.com",             "admin",       "Dr0pb0x!",           "leak-2023"),
    ("zoom.com",                "admin",       "Z00m1234",           "leak-2023"),

    # ── D: old / expired-looking credentials on target-company ──────
    ("vpn.target-company.com",  "old-employee","Old@VPN2018",        "expired-2018"),
    ("vpn.target-company.com",  "former-dev",  "F0rmer#VPN",        "expired-2019"),
    ("vpn.target-company.com",  "temp2020",    "T3mp@2020!",         "expired-2020"),
    ("vpn.target-company.com",  "consultant",  "C0nsult@nt#",       "expired-2021"),
    ("mail.target-company.com", "old-ceo",     "0ldCE0!",            "expired-2018"),
    ("mail.target-company.com", "legacy-admin","L3g@cy@dm1n",        "expired-2019"),
    ("mail.target-company.com", "dept-head",   "D3pt#H3@d",          "expired-2020"),
    ("jira.target-company.com", "old-dev",     "0ld#D3v",            "expired-2019"),
    ("jira.target-company.com", "retired-pm",  "R3t1r3d#",           "expired-2020"),
    ("gitlab.target-company.com","old-sec",    "0ldS3c!",            "expired-2019"),
    ("gitlab.target-company.com","deprecated", "D3pr3c@ted#",        "expired-2020"),
    ("admin.internal-corp.com", "legacy-sys",  "L3g@cy#Sys",         "expired-2018"),
    ("admin.internal-corp.com", "old-backup",  "0ldB@ckup",          "expired-2019"),
    ("vpn.target-company.com",  "vendor-acme", "V3nd0r@Acm3",        "expired-2021"),
    ("vpn.target-company.com",  "partner-xyz", "P@rtner#XYZ",        "expired-2021"),
    ("mail.target-company.com", "newsletter",  "N3ws#L3tter",        "reset-2022"),
    ("mail.target-company.com", "alerts",      "Al3rt@TC!",          "reset-2022"),
    ("jira.target-company.com", "bot-jira",    "J1r@#B0t",           "reset-2023"),
    ("gitlab.target-company.com","ci-bot",     "C1#B0t!",            "reset-2023"),
    ("admin.internal-corp.com", "monitoring",  "M0n1t0r#",           "reset-2022"),

    # ── E: mixed noise across public sites ──────────────────────────
    ("github.com",              "devops-ci",   "C1@GitHub2024",      "leak-2024"),
    ("github.com",              "bot-runner",  "B0t#Run!",           "leak-2024"),
    ("google.com",              "service-acct","S3rv!ce@2024",       "leak-2024"),
    ("google.com",              "cloud-user",  "Cl0ud#G00gle",       "breach-2024"),
    ("facebook.com",            "page-bot",    "P@ge#B0t",           "leak-2024"),
    ("twitter.com",             "auto-tweet",  "Aut0#Tw33t",         "leak-2024"),
    ("amazon.com",              "aws-admin",   "AWS@Adm1n!2024",     "breach-2024"),
    ("amazon.com",              "seller-pro",  "S3ller#Pr0",         "leak-2024"),
    ("linkedin.com",            "recruiter-bot","R3cr!t#B0t",         "leak-2024"),
    ("netflix.com",             "shared-acct", "Sh@red#2024",        "leak-2024"),
    ("slack.com",               "hook-bot",    "H00k#B0t!",          "leak-2024"),
    ("dropbox.com",             "shared-folder","Sh@r3d#F",          "leak-2024"),
    ("zoom.com",                "meeting-bot", "M33t#B0t!",          "leak-2024"),
    ("spotify.com",             "family-plan", "F@m1ly#2024",        "leak-2024"),
    ("example.com",             "test-admin",  "T3st@Adm!",          "leak-2024"),
    ("example.com",             "demo-user",   "D3m0#Us3r",          "leak-2024"),
    ("github.com",              "security-scan","S3c#Sc@n",           "breach-2024"),
    ("google.com",              "api-user",    "AP1#Us3r!",          "leak-2024"),
    ("facebook.com",            "ad-bot",      "Ad#B0t!2024",        "leak-2024"),
    ("twitter.com",             "trend-bot",   "Tr3nd#B0t",          "breach-2024"),
]

assert len(NOISE) == 100, f"Expected 100 entries, got {len(NOISE)}"


def main() -> None:
    init_db()
    db = SessionLocal()

    added = 0
    skipped = 0
    for domain, account, password, source in NOISE:
        result = store_credential(db, domain, account, password, source)
        if result is not None:
            added += 1
        else:
            skipped += 1

    print(f"✅ Noise import complete: {added} added, {skipped} skipped (duplicates)")

    stats = get_statistics(db)
    print(f"\n📊 Database totals:")
    print(f"   Total credentials : {stats['total_credentials']}")
    print(f"   Total domains     : {stats['total_domains']}")

    db.close()


if __name__ == "__main__":
    main()
