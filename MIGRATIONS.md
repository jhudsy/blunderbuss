DB migration notes

This project uses PonyORM with a simple `init_db()` helper that binds to a local
SQLite file `db.sqlite` for development. `init_db()` will back up an existing file
before re-generating the schema. For development this is convenient, but for
production you should use a proper migration tool (Alembic or similar).

If you change a nullable/optional field to be nullable (or vice-versa), consider:

- Backup db.sqlite (the repository's init behavior may not back up by default; set `BACKUP_DB_ON_INIT=1` to enable the old behavior that moves the file aside).
- If you don't need to preserve data, delete `db.sqlite` and re-run the app to create a fresh database.
- For preserving data or production systems, use a migration tool (Alembic) and generate appropriate ALTER TABLE statements.

Important recent changes that affect migrations and operations:

- Encrypted token storage: access and refresh tokens are now optionally encrypted into `access_token_encrypted` and `refresh_token_encrypted` when `ENCRYPTION_KEY` is set. If you enable encryption for an existing DB, tokens stored previously in plaintext will continue to be readable until you explicitly re-save them (or rotate them). Consider a migration that re-saves tokens under the encryption key or rotate tokens by revoking and re-authenticating users.

- Deterministic DB path: workers and web processes now use the same absolute DB path by default (based on the repository location) or `DATABASE_FILE` env var. This avoids the common issue where a worker appears not to find users because it opened a different sqlite file.

- Task signature change: the import task no longer accepts access tokens as arguments. If you previously serialized tokens to your broker, rotate those tokens (revoke and re-auth) because broker messages may have contained tokens.

Suggested migration steps when enabling encryption on an existing DB:

1. Back up your current DB file (copy it to a safe location).
2. Ensure `ENCRYPTION_KEY` is set in the environment for both web and worker processes.
3. Restart the web process so new tokens will be written encrypted.
4. For existing tokens, you can either:
  - Revoke existing tokens in the upstream OAuth provider and force users to re-authenticate (recommended), or
  - Write a small migration script that reads each user's plaintext token and re-saves it so the property's setter encrypts it. Be careful: only perform this when you know encryption key is set and workers can decrypt.

If you want, I can add an example migration script that re-saves tokens in-place (it should be run with the encryption key available and a DB backup present).

If you need help scaffolding Alembic migrations for this project, I can add a
basic Alembic setup and an example migration.

## Recent schema changes

### Weekly XP tracking (xp_this_week, week_start_date)

**Date**: October 2025

**Change**: Added `xp_this_week` and `week_start_date` columns to User table for weekly leaderboard support.

**Migration**:
```bash
docker compose run --rm web python scripts/migrate_add_weekly_xp.py
```

**Details**:
- `xp_this_week` (Optional int, default 0): Tracks XP accumulated during the current week
- `week_start_date` (Optional str): ISO date string (YYYY-MM-DD) of the Monday that started the week
- Weekly XP resets every Monday at midnight UTC
- The backend automatically manages resetting and tracking via `update_user_xp()`
- Enables dual leaderboards: "All Time" (using `xp`) and "Weekly" (using `xp_this_week`)
- The migration is idempotent and will skip if the columns already exist

**Compatibility**: 
- Existing users without these fields will have `NULL` initially
- Backend treats `NULL` xp_this_week as 0 and will populate week_start_date on next XP gain
- The migration adds columns with DEFAULT values, so all users automatically get 0 for xp_this_week

### Multiple attempts feature (settings_max_attempts)

**Date**: October 2025

**Change**: Added `settings_max_attempts` column to User table (Optional int, default 3, range 1-3).

**Migration**:
```bash
docker compose run --rm web python scripts/migrate_add_max_attempts.py
```

**Details**:
- This field controls the maximum number of incorrect attempts allowed per puzzle
- Each incorrect attempt halves the XP reward
- Default value is 3 (new users automatically get this default)
- The migration is idempotent and will skip if the column already exists
- For a clean slate (destructive), you can use `python scripts/create_tables.py --drop`

**Compatibility**: 
- Existing users without this field will have `NULL` initially, which will be treated as 3 (the default) by the backend
- The migration adds the column with a DEFAULT value, so all users get 3 automatically
