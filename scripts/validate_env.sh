#!/bin/sh
# Validate required environment variables for production deployments.
# Exits with non-zero if a required variable is missing.

missing=0

check() {
  name="$1"
  val="$(/usr/bin/env bash -c "printf '%s' \"\${${name}:-}\"")"
  if [ -z "$val" ]; then
    echo "ERROR: required environment variable $name is not set"
    missing=1
  fi
}

echo "Validating environment for production..."

# SECRET_KEY is required in all production runs
if [ "${FLASK_ENV:-production}" = "production" ]; then
  check SECRET_KEY

  # Require either DATABASE_URL or both POSTGRES_HOST and POSTGRES_DB
  if [ -z "${DATABASE_URL:-}" ]; then
    if [ -z "${POSTGRES_HOST:-}" ] || [ -z "${POSTGRES_DB:-}" ]; then
      echo "ERROR: In production you must set DATABASE_URL or both POSTGRES_HOST and POSTGRES_DB"
      missing=1
    fi
  fi

  # Recommend REDIS_PASSWORD for production (but not strictly required)
  if [ -z "${REDIS_PASSWORD:-}" ]; then
    echo "WARNING: REDIS_PASSWORD is not set. It's recommended to require a Redis password in production."
  fi
fi

if [ "$missing" -ne 0 ]; then
  echo "One or more required environment variables are missing. Aborting startup."
  exit 1
fi

echo "Environment validation passed."
exit 0
