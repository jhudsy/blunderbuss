# scripts/README

This folder contains administrative helper scripts for the ChessPuzzle project.

create_tables.py
----------------
Purpose:
- Initialize database tables for the ChessPuzzle application.
- Optionally drop all existing tables before recreating them (brute-force migration).

Flags:
- `--drop` : Drop all existing tables before creating new ones (DESTRUCTIVE, requires confirmation).

Usage:

- Create tables (idempotent, won't recreate existing tables):

```bash
docker compose run --rm web python scripts/create_tables.py
```

- Drop all tables and recreate (requires typing 'yes' to confirm):

```bash
docker compose run --rm web python scripts/create_tables.py --drop
```

Notes:
- The `--drop` option is useful for development or when schema changes require table recreation.
- Always backup your database before using `--drop` in production.
- Supports both PostgreSQL and SQLite.

inject_puzzle.py
----------------
Purpose:
- Manually inject a puzzle for a specific user into the database.
- Useful for testing, adding custom puzzles, or seeding specific scenarios.

Features:
- Interactive mode: prompts for all required values step-by-step.
- Command-line mode: accepts all parameters as arguments for scripting.
- Validates FEN positions and SAN moves using python-chess.
- Supports optional metadata (evaluations, tags, player names, etc.).
- Updates existing puzzles if game_id and move_number match.

Usage:

Interactive mode (recommended for manual use):

```bash
docker compose run --rm web python scripts/inject_puzzle.py
```

Command-line mode (all parameters):

```bash
docker compose run --rm web python scripts/inject_puzzle.py \
  --username alice \
  --fen "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 5" \
  --correct-san "Bxf7+" \
  --game-id "tactics001" \
  --move-number 5 \
  --severity "Blunder" \
  --pre-eval -2.5 \
  --post-eval 1.0
```

Simple puzzle injection:

```bash
docker compose run --rm web python scripts/inject_puzzle.py \
  -u bob \
  -f "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" \
  -s "e4" \
  -g "opening001" \
  -m 1
```

Arguments:
- `-u, --username` : Username to inject puzzle for (required)
- `-f, --fen` : FEN position string (required)
- `-s, --correct-san` : Correct move in SAN notation (required)
- `-g, --game-id` : Unique game identifier (required)
- `-m, --move-number` : Move number in the game (required)
- `--pre-eval` : Pre-move evaluation (optional)
- `--post-eval` : Post-move evaluation (optional)
- `--severity` : Puzzle severity classification: Blunder, Mistake, Inaccuracy (optional)
- `--white` : White player name (optional)
- `--black` : Black player name (optional)
- `--date` : Game date (optional)
- `--time-control` : Time control, e.g., "180+0" (optional)
- `--time-control-type` : Time control type: Bullet, Blitz, Rapid, Classical (optional)
- `--weight` : Initial puzzle weight, default 1.0 (optional)

Notes:
- The script validates FEN and SAN moves before injection.
- If a puzzle with the same game_id and move_number exists, you'll be prompted to update it.
- Newly injected puzzles are immediately available for the user with spaced repetition scheduling.

migrate_add_max_attempts.py
---------------------------
Purpose:
- Add the `settings_max_attempts` column to the User table for existing databases.
- This migration is required when upgrading from a version without the multiple attempts feature.

Usage:

```bash
docker compose run --rm web python scripts/migrate_add_max_attempts.py
```

Notes:
- The migration is idempotent: if the column already exists, it will skip gracefully.
- Default value for new column is 3 (range 1-3).
- This field controls maximum incorrect attempts per puzzle before solution reveal.

migrate_remove_tag_field.py
---------------------------
Purpose:
- Remove the legacy `tag` field from the Puzzle table.
- Copies any existing tag data to the `severity` field before dropping the column.
- This migration is required when upgrading from a version that had both `tag` and `severity` fields.

Usage:

```bash
docker compose run --rm web python scripts/migrate_remove_tag_field.py
```

Notes:
- The migration is idempotent: if the tag column doesn't exist, it will skip gracefully.
- Data from `tag` is copied to `severity` where `severity` is NULL before dropping the column.
- Supports both PostgreSQL and SQLite.
- For SQLite, the entire table must be recreated (no DROP COLUMN support in older versions).
- After migration, ensure your application code no longer references the `tag` field.

clear_puzzles.py
----------------
Purpose:
- Safely inspect and delete `Puzzle` rows from the application's database.
- Optionally remove `Badge` rows and `User` records (and their related puzzles/badges).

Safety guarantees:
- The script supports a `--dry-run` mode which reports how many rows would be deleted without making changes.
- Deletions require explicit confirmation: either pass `--yes` or set the environment variable `FORCE_CLEAR_PUZZLES=1`, or confirm interactively by typing `DELETE` when prompted.

Flags:
- `--dry-run` : show counts and exit without deleting.
- `--user <username>` : restrict operation to a specific user.
- `--delete-user` : delete the specified user and their puzzles/badges (requires `--user`).
- `--delete-all-users` : delete all users and their related puzzles/badges (use with extreme caution).
- `--clear-badges` : delete Badge rows (optionally filtered by `--user`).
- `--yes` : non-interactive confirmation (or set `FORCE_CLEAR_PUZZLES=1` in the environment).

Examples (local / dev):

- Dry-run locally against the default DB configuration:

```bash
PYTHONPATH=. python scripts/clear_puzzles.py --dry-run
```

- Dry-run with an in-memory DB (useful for testing):

```bash
PYTHONPATH=. DATABASE_FILE=':memory:' python scripts/clear_puzzles.py --dry-run
```

- Delete all puzzles (non-interactive):

```bash
FORCE_CLEAR_PUZZLES=1 python scripts/clear_puzzles.py --yes
```

- Delete all puzzles for user `alice` (interactive confirmation):

```bash
PYTHONPATH=. python scripts/clear_puzzles.py --user alice --dry-run
# review then run
PYTHONPATH=. python scripts/clear_puzzles.py --user alice --delete-user
```

Docker usage (recommended for production):

The project provides a `manage` one-off service in both `docker-compose.yml` and `docker-compose.prod.yml` so you can run admin scripts using the same image and environment as the running app.

- Dry-run via docker-compose (local):

```bash
docker compose run --rm manage python3 /app/scripts/clear_puzzles.py --dry-run
```

- Delete a user non-interactively via docker-compose (production):

```bash
docker compose -f docker-compose.prod.yml run --rm -e FORCE_CLEAR_PUZZLES=1 manage python3 /app/scripts/clear_puzzles.py --user alice --delete-user --yes
```

Notes and recommendations:
- Always take a backup of your database before running destructive operations in production.
  For Postgres, consider `pg_dump` or snapshotting your volume.
- Ensure the environment used to run the script (local shell or Docker) has the same `DATABASE_URL` / `DATABASE_FILE` and credentials as your application.
- If you want a preview of exactly which rows will be deleted, open an interactive DB session (or request a `--preview-file` enhancement to the script) and inspect the `puzzles`, `users`, and `badges` tables first.

Contact:
- If you're unsure, ask for a dry-run report and/or request I add a `--preview-file` option to export the list of IDs that would be deleted.
