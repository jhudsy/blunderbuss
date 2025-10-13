Deployment checklist
====================

Use this checklist when preparing a production deployment of ChessPuzzle.

Pre-deploy
---------
- [ ] Generate and securely store `SECRET_KEY` and `ENCRYPTION_KEY`.
- [ ] Choose a persistent location for the DB (Docker volume or Postgres).
- [ ] Configure Redis (separate container or managed service).
- [ ] Create monitoring and logging destinations (EFK/CloudWatch/Datadog).

What's changed (short)
----------------------
- Postgres support: you can provide `DATABASE_URL` or PG_* env vars; a
  Postgres service is included in the compose file for convenience. The app
  will continue to work with SQLite if no DSN is provided.
- Redis password: pass `REDIS_PASSWORD`; compose starts Redis with
  `--requirepass ${REDIS_PASSWORD}` when set and Celery will authenticate.
 - Health & validation: image HEALTHCHECK targets the readiness endpoint
   `/ready` which performs lightweight DB and Redis checks; `scripts/validate_env.sh`
   aborts startup in production if required env vars are missing. A CI workflow
   runs the same validation.
- Host volume preparation helper `scripts/prepare_host_volume.sh` is provided
  for systemd pre-start steps to avoid permission issues with host bind mounts.

Deploy
------
- [ ] Build images: `docker compose build --pull`.
- [ ] Start services: `docker compose up -d`.
- [ ] Verify healthchecks: `docker compose ps` and `docker compose logs`.
- [ ] Check web UI at the configured host/port.

Post-deploy
-----------
- [ ] Validate user logins and token encryption (if `ENCRYPTION_KEY` set).
- [ ] Run smoke tests for puzzle load, check_puzzle, and badge awarding.
- [ ] Configure automated backups for DB (and test restore).
- [ ] Configure alerting for high Celery queue length, worker failures, or Redis memory pressure.

Maintenance
-----------
- Rotate secrets (SECRET_KEY, ENCRYPTION_KEY) with care — rotating
  encryption keys requires re-encrypting stored tokens or a forced re-login.
- Monitor DB growth and migrate to Postgres if SQLite becomes a bottleneck.
- Periodically run `pytest` against an environment copy after upgrades.

Operational tips
----------------
- Gunicorn worker formula: `GUNICORN_WORKERS = 2 * CPU + 1` is a good starting point.
- Scale Celery worker count separately from web workers.
- Use a TLS-terminating proxy in front of the web container.

Running on a Linux host and configuring automatic start (systemd)
--------------------------------------------------------------

This section describes a straightforward way to run ChessPuzzle using Docker Compose
on a Linux server and have the stack start automatically on boot using systemd.

1) Prepare an environment file

  - Copy `.env.example` to `.env` and update secrets (SECRET_KEY, ENCRYPTION_KEY) and Postgres/Redis settings.

2) Build and test the stack locally

  ```bash
  # from the repository root
  docker compose build --pull
  docker compose up -d
  docker compose ps
  docker compose logs -f web
  ```

Healthchecks and readiness
-------------------------

 - The image includes a Docker HEALTHCHECK that calls `GET /ready` on the app.
   The `/ready` endpoint performs lightweight checks against the DB and Redis
   (when configured). The app still exposes `GET /health` as a very fast
   liveness probe. For additional readiness guarantees the container entrypoint
   waits for Postgres when `DATABASE_URL` or PG* env vars are configured.

- Deeper readiness: CI or deployment pipelines can call `/ready?full=1` to run
  a slightly deeper readiness check (materialize a user row via the ORM and
  fetch `INFO` from Redis) to increase confidence before routing live traffic.

Initialize the database (first-time setup)
-----------------------------------------

When deploying to a fresh Postgres instance you must create the database
tables before the app can operate. The repository provides a small helper
script that calls the same `init_db(create_tables=True)` used by the
application:

  ```bash
  # Run the helper using the compose environment so the same PG env vars are used
  docker compose run --rm web python scripts/create_tables.py
  ```

This command is idempotent and will create any missing tables. After it
completes the application's readiness checks should report the DB as
available.

Admin scripts and the `manage` one-off service
----------------------------------------------
The compose setup includes a `manage` service intended for running one-off
admin tasks from the same image and environment as the `web` service. It's
handy for running scripts that need the app's code and the same environment
variables (DB URL, secrets, etc.). The `manage` service mounts the same
project volume so scripts can access the repository's `scripts/` directory.

Common usage examples:

```bash
# Dry-run the clear_puzzles script
docker compose run --rm manage python3 /app/clear_puzzles.py --dry-run

# Force non-interactive delete (use with care)
docker compose run --rm -e FORCE_CLEAR_PUZZLES=1 manage python3 /app/clear_puzzles.py --yes
```

Note: during image build a convenience symlink `/app/clear_puzzles.py` is
created that points at `/app/scripts/clear_puzzles.py`. If you do not rebuild
the image you can still call the script at `/app/scripts/clear_puzzles.py`.

When to use `--force-recreate` with `docker compose up`
-------------------------------------------------------
`docker compose up` attempts to reuse existing containers when possible to
preserve state and reduce downtime. The `--force-recreate` flag forces Docker
to recreate containers even if their configuration appears unchanged. Use
`--force-recreate` in these situations:

- You built a new image locally (or pulled an updated image) and want to be
  certain the running containers use the new image and fresh filesystem.
- You changed mounted-volume initialization scripts or altered files that are
  only copied into the image at build time (for example, the Dockerfile creates
  convenience symlinks). In that case recreating the container ensures the
  container's filesystem matches the built image.
- You changed the compose service definition in ways that cannot be applied to
  the running container (for example, adding/removing ports or changing
  restart policies).

Examples:

```bash
# Rebuild images and start fresh containers (recreate even if names match)
docker compose build --pull
docker compose up -d --force-recreate

# Recreate only the web service containers explicitly
docker compose up -d --force-recreate web
```

Warning: `--force-recreate` will restart containers and may cause short
downtime. If you have attached volumes with state, ensure you understand the
impact to those volumes before forcing recreation.

Pre-start host volume preparation
--------------------------------

- If you plan to use a host bind-mount for the sqlite DB directory, ensure the
  directory exists and is writable by the container user before enabling the
  systemd service. The repository includes `scripts/prepare_host_volume.sh` and
  the example systemd unit demonstrates using `ExecStartPre` to call it.

Environment validation & CI
---------------------------

- The container runs `scripts/validate_env.sh` when starting in production mode
  (FLASK_ENV=production) and will abort startup if required env vars are missing.
- A GitHub Actions workflow (`.github/workflows/env-check.yml`) runs the same
  validation in CI to catch missing secrets early.

3) Create a systemd unit that brings up the compose stack on boot

  Create `/etc/systemd/system/chesspuzzle.service` with contents similar to:

  ```ini
  [Unit]
  Description=ChessPuzzle Docker Compose stack
  Requires=docker.service
  After=docker.service

  [Service]
  Type=oneshot
  RemainAfterExit=yes
  WorkingDirectory=/path/to/chesspuzzle
  EnvironmentFile=/path/to/chesspuzzle/.env
  # Optional pre-start hook: ensure host volume directory exists and has correct ownership
  # Replace /var/lib/chesspuzzle/data and 1000:1000 with appropriate host path and uid:gid
  ExecStartPre=/usr/bin/env sh -c '/path/to/chesspuzzle/scripts/prepare_host_volume.sh /var/lib/chesspuzzle/data 1000 1000'
  ExecStart=/usr/bin/docker compose up -d
  ExecStop=/usr/bin/docker compose down

  [Install]
  WantedBy=multi-user.target
  ```

  Replace `/path/to/chesspuzzle` with the absolute path to the checked-out repository.

  4) Enable and start the systemd service

  ```bash
  sudo systemctl daemon-reload
  sudo systemctl enable --now chesspuzzle.service
  sudo systemctl status chesspuzzle.service

Using the included production compose (nginx + Let's Encrypt)
-----------------------------------------------------------

This repository includes `docker-compose.prod.yml`, which runs `web`, `worker`,
`redis`, `postgres`, an `nginx` reverse proxy, and a `certbot` renewal service.
To use it:

1. Edit `.env` and set `DOMAIN` and `LETSENCRYPT_EMAIL` (and other secrets).
2. Obtain initial certificates (one-time):
  ```bash
  docker compose -f docker-compose.prod.yml run --rm --entrypoint "" certbot \
    certbot certonly --webroot -w /var/www/certbot \
    --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email -d "$DOMAIN"
  ```
3. Start the production stack:
  ```bash
  docker compose -f docker-compose.prod.yml up -d
  ```

The nginx config is templated at `deploy/nginx/conf.d/chesspuzzle.template` and
is expanded at container start to produce the active nginx config.

Quick production setup checklist
-------------------------------
- Copy the example secrets file and edit or generate real values:
  ```bash
  cp deploy/secrets.env.example deploy/secrets.env
  # OR use the interactive generator shipped with the repo:
  deploy/generate_secrets.sh /home/deploy/chesspuzzle/secrets.env
  ```
- Ensure `secrets.env` is readable only by the deploy user (chmod 600) and not committed.
- Prepare host volumes (see `scripts/prepare_host_volume.sh`) and ensure ownership matches container UID.
- Obtain initial certificates (see above) then start the stack:
  ```bash
  docker compose -f docker-compose.prod.yml up -d
  ```
  ```

Notes and considerations
 - The systemd service above uses `docker compose` and relies on the system's Docker installation.
 - Ensure the `.env` file is owned by root and has correct permissions (do not make secrets world-readable).
 - For more advanced deployments consider using a process manager like Portainer, Kubernetes, or Docker Swarm.

