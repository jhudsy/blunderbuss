# scripts/README

This folder contains administrative helper scripts for the ChessPuzzle project.

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
