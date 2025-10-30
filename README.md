````markdown
Blunderbuss — lightweight puzzle trainer
======================================

What this repo is
-----------------
A small Flask web app for practicing tactical chess puzzles extracted from PGN files. It includes:

- Flask backend with Lichess OAuth login
- Puzzle extraction from PGN (now in `pgn_parser.py`)
- Simple front-end using chessboard.js and chess.js, vendored under `static/vendor`
- Local chess piece images in `static/img/chesspieces/`
- Spaced-repetition bookkeeping using PonyORM (SQLite by default)

Quick start (development)
-------------------------
1. Create a Python virtualenv and install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
```

2. Initialize the database and run the dev server:

```bash
# The project includes a helper script run_server.sh. For a quick run:
./run_server.sh restart web
# or
FLASK_APP=backend.py FLASK_ENV=development python3 backend.py
```

3. Seed demo puzzles (optional)

You can import the sample PGN into a mock user with:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"username":"test","pgn":"'"$(sed -e ':a;N;$!ba;s/"/\"/g' examples/samples.pgn)'"'}' \
  http://127.0.0.1:5000/load_games
```

4. Configure Lichess OAuth (required for login)

Create a Lichess OAuth application at https://lichess.org/account/oauth/app/create and add the credentials to your `.env` file:

```bash
LICHESS_CLIENT_ID=your_client_id
LICHESS_CLIENT_SECRET=your_client_secret
```

5. Open the UI

- Go to http://127.0.0.1:5000/login to sign in with Lichess
- Then open http://127.0.0.1:5000/puzzle

What changed recently (important)
---------------------------------
- `parser.py` was renamed to `pgn_parser.py` to avoid shadowing the Python stdlib module `parser`.
* Notes:
  - Logging: you can control app logging with the `LOG_LEVEL` or `BLUNDERBUSS_LOG_LEVEL` environment variable (e.g. `LOG_LEVEL=DEBUG`). This is respected at app startup.
  - Settings/perf types: perftypes are stored as a JSON array in the DB (e.g. `["blitz","rapid"]`) and the settings page posts/accepts JSON lists.
  - Migration: the repository includes `scripts/migrate_perftypes.py` to convert legacy CSV perftype values to JSON arrays in `db.sqlite` (it backs up your DB before modifying it).
- Frontend highlights are animated and configurable via CSS variables in `static/css/site.css`:
  - `--highlight-green`, `--highlight-red`, `--highlight-duration` (e.g. `1.2s` or `1200ms`).
- Chessboard and Bootstrap assets have been vendored to `static/vendor/` and piece images live in `static/img/chesspieces/`.
- `requirements.txt` now lists dependencies pinned to conservative ranges; the project was validated with Flask 3.1 in a `.venv` and tests passed.

Frontend customization
----------------------
- Highlight colors/duration: edit `static/css/site.css` (top of file defines `:root` CSS variables).
- Piece image path: Chessboard is initialized with `pieceTheme: '/static/img/chesspieces/{piece}.png'` in `static/js/puzzle.js`.

Backend notes
-------------
- The SQLite DB file `db.sqlite` is used by default. The `models.init_db()` helper backs up an existing DB when generating mapping.
- `backend.py` returns puzzle metadata fields (white, black, date, time_control, pre_eval, post_eval, tag) from `/get_puzzle` if present.

Testing
-------
Run the unit tests with:

```bash
source .venv/bin/activate
pytest -q
```

Testing note
------------
The test suite historically used SQLite's special `:memory:` value for
`DATABASE_FILE`, which creates a separate in-memory database per connection.
That can cause surprising failures when the Flask test client and test code
open separate connections and cannot see each other's rows. For local pytest
runs this project maps `DATABASE_FILE=':memory:'` to a shared file at
`.run/pytest_db.sqlite` so tests and the app use the same DB file and see the
same data.

If you want to reset the test DB between runs, use the helper script:

```bash
./scripts/cleanup_test_db.sh
```

Troubleshooting
---------------
- If you see import errors for `chess` or `chess.pgn`, install `python-chess` via `pip install python-chess` (it is in `requirements.txt`).
- If you change vendor files and the browser caches them, do a hard refresh (Ctrl/Cmd+Shift+R) or remove cached static files.
- urllib3 may warn about LibreSSL vs OpenSSL when running tests in some macOS environments — it’s informational unless you need specific OpenSSL features.

Admin scripts
-------------
This repository includes a set of admin scripts under the `scripts/` directory for maintenance tasks. The primary script is `scripts/clear_puzzles.py`, which safely deletes Puzzle rows (and can optionally delete users and badges).

Usage notes:
- The script supports `--dry-run` to show counts without performing deletions.
- Deletion requires explicit confirmation: either pass `--yes` or set the env var `FORCE_CLEAR_PUZZLES=1`.
- To restrict operations to a specific user use `--user <username>` and combine with `--delete-user` to remove the user and their related rows.

Running inside Docker
---------------------
When using Docker the repository image exposes the `scripts/` directory at `/app/scripts/` inside the container. For convenience a lightweight symlink `/app/clear_puzzles.py` is created during image build so the script can also be invoked at `/app/clear_puzzles.py`.

Examples (using the `manage` one-off service defined in `docker-compose.yml`):

```bash
# Dry run: show how many puzzles would be removed
docker compose run --rm manage python3 /app/clear_puzzles.py --dry-run

# Non-interactive delete all puzzles (force via env)
docker compose run --rm -e FORCE_CLEAR_PUZZLES=1 manage python3 /app/clear_puzzles.py --yes

# Delete puzzles for a specific user (interactive confirmation)
docker compose run --rm manage python3 /app/clear_puzzles.py --user jhudsy
```

If you prefer not to rebuild the image you may also call the script at its full path inside the container:

```bash
docker compose run --rm manage python3 /app/scripts/clear_puzzles.py --dry-run
```

Backup reminder: always make a DB backup (copy the SQLite file or run `pg_dump`) before running destructive operations in production.

CI / reproducible installs
--------------------------
If you want a pinned lockfile, run inside a fresh venv and create a freeze output:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip freeze > requirements-lock.txt
```

I can add a Dockerfile or CI YAML for GitHub Actions if you want reproducible builds.

Credits & license
-----------------
- The frontend uses chessboard.js (MIT) and chess.js (MIT).
- This project is MIT-licensed (see LICENSE if present).

If you want, I can:
- Add a pinned `requirements-lock.txt` and a small `README` section documenting `.venv` usage in CI.
- Add a Dockerfile and GitHub Actions workflow for CI/deploy.

Which would you like next? 

Production deployment (Docker + Redis)
-------------------------------------
This section outlines practical steps to run Blunderbuss in a production-like
environment using Docker. It assumes Redis is run as a separate container and
that you will mount a persistent volume for the SQLite database (or switch to
Postgres for higher concurrency).

Environment variables
- `SECRET_KEY` (required): a long random string for Flask session signing.
- `ENCRYPTION_KEY` (recommended): Fernet key used to encrypt OAuth tokens at rest.
- `DATABASE_FILE` (optional): path to the SQLite DB inside the container (mount
  a volume to persist it).
- `REDIS_PASSWORD` (optional): if Redis is password-protected; prefer using a
  Docker secret or secret store.
 - Note: The compose configuration now starts Redis with `--requirepass ${REDIS_PASSWORD}`
   when `REDIS_PASSWORD` is set. Set a strong password in `.env` for production.
 - Health endpoint: the app exposes `GET /health` which returns HTTP 200 and is
   used by the Docker HEALTHCHECK configured in the image.
 - Environment validation: the container entrypoint runs a small validation
   script in production (`scripts/validate_env.sh`) that ensures required
   environment variables (e.g. SECRET_KEY and DB settings) are present and
   will abort startup if they are missing. A GitHub Actions workflow is included
   to run this validation on CI.

Quick summary of recent production-ready changes
------------------------------------------------
- Postgres support: the stack can use `DATABASE_URL` or PG_* env vars (Postgres
  service added to `docker-compose.yml`). The app falls back to SQLite when no
  DSN is provided.
- Redis password support: `REDIS_PASSWORD` is respected; compose starts Redis
  with `--requirepass` when configured and Celery broker URLs include the
  password.
- Health & readiness: lightweight `GET /health` endpoint and Docker HEALTHCHECK
  are included. When Postgres is used the entrypoint waits for DB readiness.
  - New: `GET /ready` is a readiness probe that performs lightweight checks of
    the DB and Redis (when configured). The image HEALTHCHECK calls `/ready` so
    orchestration systems can detect when the app is fully ready to serve
    traffic.
  - For CI or deployment pipelines you can call `/ready?full=1` which performs
    slightly deeper checks (touches a user row via the ORM and reads Redis
    INFO) to gain higher confidence the app and its dependencies are ready.
- Startup validation & CI: `scripts/validate_env.sh` runs in production and a
  GitHub Actions workflow runs the same check on CI to catch missing env vars.
- Host volume prep: `scripts/prepare_host_volume.sh` helps ensure host bind
  mounts for the SQLite file are created with correct ownership before startup.
- `GUNICORN_WORKERS` (optional): number of Gunicorn workers, default 2 in
  the `Dockerfile`.

Recommended docker-compose layout

Create a minimal `docker-compose.yml` with three services: `redis`, `web`,
and `worker`. Keep the SQLite DB on a named volume so it persists between
restarts. Example:

```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data

  web:
    build: .
    environment:
      - SECRET_KEY=${SECRET_KEY}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - DATABASE_FILE=/data/db.sqlite
      - REDIS_PASSWORD=${REDIS_PASSWORD}
      - GUNICORN_WORKERS=${GUNICORN_WORKERS:-2}
    volumes:
      - blunderbuss-data:/data
    ports:
      - "5000:5000"
    depends_on:
      - redis

  worker:
    build: .
    command: sh -c "celery -A tasks worker --loglevel=info"
    environment:
      - SECRET_KEY=${SECRET_KEY}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - DATABASE_FILE=/data/db.sqlite
      - REDIS_PASSWORD=${REDIS_PASSWORD}
    volumes:
      - blunderbuss-data:/data
    depends_on:
      - redis

volumes:
  blunderbuss-data:
  redis-data:
```

Notes and operational guidance
- Persistence: SQLite is fine for low throughput, but if you plan to run many
  concurrent workers or heavy imports, switch to Postgres. For SQLite, mount
  a Docker volume at `/data` and set `DATABASE_FILE=/data/db.sqlite`.
- Secrets: Use Docker secrets or an external secret manager for `SECRET_KEY`
  and `ENCRYPTION_KEY`. Avoid putting secrets in source-controlled `.env` files.
- Token encryption: set `ENCRYPTION_KEY` to enable transparent encryption of
  stored OAuth tokens. Plan key rotation carefully; rotating the key requires
  re-encryption of stored tokens or forcing re-authentication.
- Redis: the worker and web process expect Redis as a separate service; if
  Redis requires a password you can pass `REDIS_PASSWORD` and set the broker
  URL appropriately (e.g. `redis://:password@redis:6379/0`).
- Backups & migrations: schedule regular DB backups (copy the SQLite file or
  use `pg_dump` if you migrate to Postgres). Test any schema migration on a
  copy of production data first.
- Monitoring: collect logs from Gunicorn and Celery, monitor Redis memory and
  queue lengths, and set up alerts for high error rates or long-running tasks.

Build & run

```bash
docker compose build --pull
docker compose up -d

# view logs
docker compose logs -f web
docker compose logs -f worker
```

When to use managed services
- For larger deployments, move the DB to a managed Postgres and use a
  managed Redis (e.g., AWS Elasticache, Azure Cache) to improve reliability
  and simplify operational overhead.
