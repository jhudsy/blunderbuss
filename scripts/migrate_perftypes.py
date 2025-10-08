#!/usr/bin/env python3
"""Migration helper: convert User.settings_perftypes to JSON arrays.

This script updates the SQLite `db.sqlite` file in the repository root by
ensuring the `settings_perftypes` column on the `user` table contains a
JSON-encoded array (stored as TEXT). It backs up the existing DB file before
modifying it.

Usage:
  python scripts/migrate_perftypes.py

The script is idempotent: entries already containing a JSON list are left
unchanged.
"""
import sqlite3
import json
import os
import shutil
import time


def migrate(db_path):
    if not os.path.exists(db_path):
        print(f"DB not found at {db_path}")
        return 1
    # backup
    bak = f"{db_path}.bak.{int(time.time())}"
    shutil.copy2(db_path, bak)
    print(f"Backed up {db_path} -> {bak}")

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Ensure the user table exists
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='user'")
    if not cur.fetchone():
        print("No 'user' table found in DB; nothing to do.")
        conn.close()
        return 0

    cur.execute("SELECT id, settings_perftypes FROM user")
    rows = cur.fetchall()
    updated = 0
    for uid, raw in rows:
        raw = raw or ''
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                # already JSON list, normalize and re-serialize to ensure consistent casing
                norm = [str(x).strip().lower() for x in parsed if str(x).strip()]
                new = json.dumps(norm)
            else:
                # Not a list -> treat as CSV fallback
                parts = [p.strip().lower() for p in str(raw).split(',') if p.strip()]
                new = json.dumps(parts)
        except Exception:
            # parse as CSV-style
            parts = [p.strip().lower() for p in str(raw).split(',') if p.strip()]
            new = json.dumps(parts)

        if new != (raw or '[]'):
            cur.execute("UPDATE user SET settings_perftypes = ? WHERE id = ?", (new, uid))
            updated += 1

    conn.commit()
    conn.close()
    print(f"Migration complete. Updated {updated} rows.")
    return 0


if __name__ == '__main__':
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    db_path = os.path.join(repo_root, 'db.sqlite')
    exit(migrate(db_path))
