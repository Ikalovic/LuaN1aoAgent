"""Generate demo credential data for Beekeeper demonstration."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from beekeeper.database import init_db, SessionLocal
from beekeeper.core import store_credential

DEMO_DATA = [
    # github.com
    ("github.com", "admin", "admin123", "leak-2023"),
    ("github.com", "testuser", "P@ssw0rd!", "leak-2023"),
    ("github.com", "developer", "gitHub2024", "leak-2024"),
    ("github.com", "john.doe", "John@1234", "breach-2023"),
    ("github.com", "alice_dev", "Al1ce#Git", "breach-2023"),
    ("github.com", "bob_coder", "r00tB0b!", "leak-2024"),
    ("github.com", "charlie99", "Ch@rlie99", "leak-2024"),
    # google.com
    ("google.com", "user@gmail.com", "google123", "leak-2022"),
    ("google.com", "admin@company.com", "Adm!n2024", "breach-2023"),
    ("google.com", "test.account", "Test@Google", "leak-2023"),
    ("google.com", "john.doe@gmail.com", "J0hnD0e!", "leak-2024"),
    ("google.com", "alice.wonder", "W0nderl@nd", "breach-2024"),
    ("google.com", "bob.smith", "B0bSm1th#", "leak-2024"),
    # example.com
    ("example.com", "admin", "admin", "leak-2021"),
    ("example.com", "webmaster", "W3bm@ster", "leak-2021"),
    ("example.com", "info", "info12345", "breach-2022"),
    ("example.com", "support", "Supp0rt!", "leak-2022"),
    ("example.com", "contact", "C0ntact@2023", "leak-2023"),
    # linkedin.com
    ("linkedin.com", "professional1", "L1nked!n", "breach-2021"),
    ("linkedin.com", "john.career", "C@reer2023", "breach-2021"),
    ("linkedin.com", "alice.hr", "HR@lice123", "leak-2022"),
    ("linkedin.com", "bob.manager", "M@nager#1", "breach-2022"),
    ("linkedin.com", "charlie.recruit", "Recru1t!", "leak-2023"),
    ("linkedin.com", "diana.sales", "S@les2024", "leak-2024"),
    # twitter.com
    ("twitter.com", "tweet_user", "Tw33t!ng", "leak-2023"),
    ("twitter.com", "bird_watcher", "B1rd#Watch", "breach-2023"),
    ("twitter.com", "social_media", "S0cial@2024", "leak-2024"),
    ("twitter.com", "news_fan", "News@Fan123", "leak-2024"),
    ("twitter.com", "tech_guru", "T3chGuru!", "breach-2024"),
    # amazon.com
    ("amazon.com", "shopaholic", "Sh0p@2024", "leak-2023"),
    ("amazon.com", "prime_user", "Pr1me#User", "breach-2023"),
    ("amazon.com", "seller01", "S3ller01!", "leak-2024"),
    ("amazon.com", "buyer123", "Buy3r@123", "leak-2024"),
    # facebook.com
    ("facebook.com", "social_user", "F@ceb00k", "breach-2021"),
    ("facebook.com", "mark_fan", "Zuck2024!", "leak-2022"),
    ("facebook.com", "alice.social", "S0cial@Alice", "breach-2022"),
    ("facebook.com", "bob.network", "N3tw0rk#Bob", "leak-2023"),
    ("facebook.com", "charlie.page", "P@ge#2024", "leak-2024"),
    ("facebook.com", "diana.ads", "Ad$Manager", "breach-2024"),
    ("facebook.com", "eve.group", "Gr0up@Admin", "leak-2024"),
    # internal corporate sites (realistic for pentest context)
    ("admin.internal-corp.com", "administrator", "Admin@2024!", "internal-audit"),
    ("admin.internal-corp.com", "sysadmin", "Sys@dm1n#1", "internal-audit"),
    ("admin.internal-corp.com", "backup", "B@ckup2023", "internal-audit"),
    ("vpn.target-company.com", "employee01", "Empl01@VPN", "leak-2024"),
    ("vpn.target-company.com", "contractor", "C0ntract!", "leak-2024"),
    ("vpn.target-company.com", "intern", "Intern@2024", "leak-2024"),
    ("mail.target-company.com", "ceo", "CE0@Target!", "breach-2024"),
    ("mail.target-company.com", "cfo", "CF0#Money", "breach-2024"),
    ("mail.target-company.com", "it-admin", "1t@Adm1n#", "leak-2024"),
    ("mail.target-company.com", "hr-manager", "HR@M@nager", "leak-2024"),
    ("jira.target-company.com", "dev-team", "D3vTe@m#1", "leak-2024"),
    ("jira.target-company.com", "pm-lead", "PM#Le@d2024", "breach-2024"),
    ("gitlab.target-company.com", "developer1", "D3v3l0per!", "leak-2024"),
    ("gitlab.target-company.com", "devops", "Dev0ps@CI", "leak-2024"),
    ("gitlab.target-company.com", "security", "S3c#Team!", "breach-2024"),
    # misc sites
    ("netflix.com", "stream_fan", "N3tfl!x2024", "leak-2024"),
    ("netflix.com", "movie_buff", "M0v!e#Buff", "leak-2024"),
    ("spotify.com", "music_lover", "Sp0tify@2024", "leak-2024"),
    ("spotify.com", "podcast_fan", "P0dc@st!", "breach-2024"),
    ("slack.com", "team_user", "Sl@ck#Team", "leak-2024"),
    ("slack.com", "workspace_admin", "Adm1n@WS", "breach-2024"),
    ("dropbox.com", "cloud_user", "Dr0pb0x!2024", "leak-2024"),
    ("zoom.com", "meeting_host", "Z00m#Host", "leak-2024"),
    ("zoom.com", "webinar_admin", "W3b1n@r!", "breach-2024"),
]


def main():
    print("Initializing database...")
    init_db()
    db = SessionLocal()
    imported = 0
    skipped = 0
    for domain, account, password, source in DEMO_DATA:
        result = store_credential(db, domain, account, password, source)
        if result:
            imported += 1
        else:
            skipped += 1
    db.close()
    print(f"\nDemo data generation complete!")
    print(f"  Imported: {imported}")
    print(f"  Skipped (duplicates): {skipped}")
    print(f"  Total in DEMO_DATA: {len(DEMO_DATA)}")
    from collections import Counter
    domains = Counter(d[0] for d in DEMO_DATA)
    print(f"\nDomains: {len(domains)}")
    for domain, count in sorted(domains.items(), key=lambda x: -x[1]):
        print(f"  {domain}: {count} credentials")


if __name__ == "__main__":
    main()
