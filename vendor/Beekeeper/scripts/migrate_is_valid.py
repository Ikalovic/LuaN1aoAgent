"""Add is_valid column and mark existing noise data as invalid."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from beekeeper.database import init_db, engine
from sqlalchemy import text

# First ensure tables exist
init_db()

# Add is_valid column if it doesn't exist
with engine.connect() as conn:
    # Check if column exists
    result = conn.execute(text("PRAGMA table_info(credentials)"))
    columns = [row[1] for row in result]

    if "is_valid" not in columns:
        conn.execute(text("ALTER TABLE credentials ADD COLUMN is_valid BOOLEAN DEFAULT 1"))
        conn.commit()
        print("Added is_valid column")
    else:
        print("is_valid column already exists")

    # Mark the noise entries as invalid
    result = conn.execute(text("SELECT source, COUNT(*) FROM credentials GROUP BY source"))
    sources = {row[0]: row[1] for row in result}
    print("Current sources:", sources)

    # Mark noise entries as invalid (all entries with noise-related sources)
    noise_sources = [s for s in sources.keys() if "noise" in s.lower()]
    if noise_sources:
        placeholders = ",".join(f"'{s}'" for s in noise_sources)
        conn.execute(text(f"UPDATE credentials SET is_valid = 0 WHERE source IN ({placeholders})"))
        conn.commit()
        print(f"Marked noise entries as invalid: {noise_sources}")

    # Verify
    result = conn.execute(text("SELECT is_valid, COUNT(*) FROM credentials GROUP BY is_valid"))
    for row in result:
        print(f"  is_valid={row[0]}: {row[1]} entries")
