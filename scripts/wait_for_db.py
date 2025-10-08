#!/usr/bin/env python3
"""Small helper that waits for Postgres (or SQLite) to be ready.

Usage: called by container entrypoint. It checks for DATABASE_URL or
PG* env vars and attempts to connect with psycopg2. If no Postgres
config is present, it quickly returns (sqlite fallback).

The script exits with code 0 on success, non-zero on failure/timeouts.
"""
import os
import time
import sys

# Timeout and interval (seconds)
TIMEOUT = int(os.environ.get('DB_WAIT_TIMEOUT', '30'))
INTERVAL = float(os.environ.get('DB_WAIT_INTERVAL', '1.0'))

# Determine whether a Postgres DSN is configured
dsn = os.environ.get('DATABASE_URL')
if not dsn:
    pg_host = os.environ.get('PGHOST') or os.environ.get('POSTGRES_HOST')
    pg_db = os.environ.get('PGDATABASE') or os.environ.get('POSTGRES_DB')
    if pg_host and pg_db:
        pg_port = os.environ.get('PGPORT', os.environ.get('POSTGRES_PORT', '5432'))
        pg_user = os.environ.get('PGUSER', os.environ.get('POSTGRES_USER', 'postgres'))
        pg_password = os.environ.get('PGPASSWORD', os.environ.get('POSTGRES_PASSWORD', ''))
        dsn = f"postgresql://{pg_user}:{pg_password}@{pg_host}:{pg_port}/{pg_db}"

# If no DSN is configured, assume sqlite or in-memory DB; nothing to wait for.
if not dsn:
    print('No Postgres configuration detected; skipping DB wait (sqlite fallback)')
    sys.exit(0)

print(f"Detected Postgres DSN; will wait up to {TIMEOUT}s for DB readiness")

# Try to import psycopg2 and attempt connections
try:
    import psycopg2
    from psycopg2 import OperationalError
except Exception as e:
    print('psycopg2 not available in environment; cannot verify Postgres readiness:', e)
    # Exit success so container can still start; user may have other connectivity means.
    sys.exit(0)

start = time.time()
while True:
    try:
        conn = psycopg2.connect(dsn, connect_timeout=3)
        conn.close()
        print('Postgres is available')
        sys.exit(0)
    except OperationalError as e:
        now = time.time()
        if now - start > TIMEOUT:
            print(f'Postgres did not become ready after {TIMEOUT} seconds: {e}')
            sys.exit(2)
        # retry
        time.sleep(INTERVAL)
    except Exception as e:
        print('Unexpected error while checking Postgres readiness:', e)
        sys.exit(3)
