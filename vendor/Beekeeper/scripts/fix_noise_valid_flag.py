"""Fix the is_valid flag for noise data entries."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Import the NOISE list from generate_noise_data
from generate_noise_data import NOISE

from beekeeper.database import init_db, SessionLocal
from beekeeper.models import Credential

init_db()
db = SessionLocal()

fixed = 0
not_found = 0

for domain, account, password, source in NOISE:
    domain_lower = domain.strip().lower()
    cred = (
        db.query(Credential)
        .filter(
            Credential.domain.ilike(domain_lower),
            Credential.account.ilike(account),
            Credential.password.ilike(password),
        )
        .first()
    )
    if cred:
        cred.is_valid = False
        fixed += 1
    else:
        not_found += 1
        print(f"  NOT FOUND: {domain} / {account}")

db.commit()

# Verify
valid = db.query(Credential).filter(Credential.is_valid == True).count()
invalid = db.query(Credential).filter(Credential.is_valid == False).count()
print(f"\nFixed {fixed} entries, {not_found} not found")
print(f"Valid: {valid}, Invalid: {invalid}")

db.close()
