#!/bin/sh
set -e
# Compute a sensible default for Gunicorn workers if not provided.
if [ -z "${GUNICORN_WORKERS:-}" ]; then
  if command -v nproc >/dev/null 2>&1; then
    CPU=$(nproc)
  else
    # fallback reasonable default
    CPU=1
  fi
  GUNICORN_WORKERS=$((2 * CPU + 1))
fi

# If DEBUG mode is requested, run Flask dev server (not for production)
if [ "${FLASK_ENV:-production}" = "development" ]; then
  echo "Starting Flask development server (not for production)"
  # If a database is configured, wait for it to become available before starting
  if [ -f /app/scripts/wait_for_db.py ]; then
    echo "Waiting for database readiness (development)..."
    python3 /app/scripts/wait_for_db.py || {
      echo "Database did not become ready in time; exiting"
      exit 1
    }
  fi
  exec python3 backend.py
fi

# Exec Gunicorn as the final process so signals are forwarded
if [ "${FLASK_ENV:-production}" = "production" ]; then
  if [ -f /app/scripts/validate_env.sh ]; then
    echo "Validating environment variables for production..."
    sh /app/scripts/validate_env.sh || exit 1
  fi
fi
if [ -f /app/scripts/wait_for_db.py ]; then
  echo "Waiting for database readiness..."
  python3 /app/scripts/wait_for_db.py || {
    echo "Database did not become ready in time; exiting"
    exit 1
  }
fi

exec gunicorn -b 0.0.0.0:5000 --workers "${GUNICORN_WORKERS}" pre_import:app
