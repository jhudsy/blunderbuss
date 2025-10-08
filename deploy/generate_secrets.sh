#!/usr/bin/env sh
# Interactive secrets generator for ChessPuzzle production deployments.
# Usage: deploy/generate_secrets.sh /path/to/secrets.env
# Creates the file and sets permissions to 600 by default.

set -e
out=${1:-./deploy/secrets.env}
if [ -f "$out" ]; then
  echo "File $out already exists. Move it aside or pass a different path." >&2
  exit 1
fi

echo "Generating secrets file at $out"

echo "# Generated secrets file for ChessPuzzle" > "$out"

prompt() {
  varname=$1
  prompt_text=$2
  default=$3
  read -p "$prompt_text [$default]: " v
  if [ -z "$v" ]; then v="$default"; fi
  echo "$varname=$v" >> "$out"
}

random_secret() {
  # Use openssl if present, else fallback to /dev/urandom
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64
  fi
}

# Application secrets
echo "# Application secrets" >> "$out"
sk=$(random_secret)
echo "SECRET_KEY=$sk" >> "$out"

# ENCRYPTION_KEY (optional)
read -p "Generate an ENCRYPTION_KEY for Fernet token encryption? (y/N): " gen_enc
if [ "${gen_enc:-n}" = "y" ] || [ "${gen_enc:-n}" = "Y" ]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
from cryptography.fernet import Fernet
print('ENCRYPTION_KEY=' + Fernet.generate_key().decode())
PY
  else
    echo "ENCRYPTION_KEY=$(random_secret)" >> "$out"
  fi
else
  echo "ENCRYPTION_KEY=" >> "$out"
fi

# Domain / TLS
echo "# Domain / TLS" >> "$out"
read -p "Domain for this deployment (e.g. example.com): " DOMAIN
DOMAIN=${DOMAIN:-your.domain.example}
echo "DOMAIN=$DOMAIN" >> "$out"
read -p "Let's Encrypt contact email: " LE_EMAIL
LE_EMAIL=${LE_EMAIL:-ops@example.com}
echo "LETSENCRYPT_EMAIL=$LE_EMAIL" >> "$out"

# Redis
echo "# Redis" >> "$out"
read -p "Use local redis service? (y/N): " use_redis
if [ "${use_redis:-n}" = "y" ] || [ "${use_redis:-n}" = "Y" ]; then
  read -p "Redis host [redis]: " rhost
  rhost=${rhost:-redis}
  read -p "Redis port [6379]: " rport
  rport=${rport:-6379}
  echo "REDIS_HOST=$rhost" >> "$out"
  echo "REDIS_PORT=$rport" >> "$out"
  read -p "Generate REDIS_PASSWORD? (y/N): " gen_pw
  if [ "${gen_pw:-n}" = "y" ] || [ "${gen_pw:-n}" = "Y" ]; then
    rp=$(random_secret)
    echo "REDIS_PASSWORD=$rp" >> "$out"
  else
    echo "REDIS_PASSWORD=replace_with_strong_password" >> "$out"
  fi
else
  echo "REDIS_HOST=redis" >> "$out"
  echo "REDIS_PORT=6379" >> "$out"
  echo "REDIS_PASSWORD=replace_with_strong_password" >> "$out"
fi

# Postgres
echo "# Postgres" >> "$out"
read -p "Use Postgres? (y/N): " use_pg
if [ "${use_pg:-n}" = "y" ] || [ "${use_pg:-n}" = "Y" ]; then
  read -p "Provide DATABASE_URL (leave blank to use POSTGRES_* vars): " dburl
  if [ -n "$dburl" ]; then
    echo "DATABASE_URL=$dburl" >> "$out"
  else
    read -p "POSTGRES_USER [postgres]: " pguser
    pguser=${pguser:-postgres}
    read -p "POSTGRES_PASSWORD [postgres]: " pgpw
    pgpw=${pgpw:-postgres}
    read -p "POSTGRES_DB [chesspuzzle]: " pgdb
    pgdb=${pgdb:-chesspuzzle}
    read -p "POSTGRES_HOST [postgres]: " pghost
    pghost=${pghost:-postgres}
    read -p "POSTGRES_PORT [5432]: " pgport
    pgport=${pgport:-5432}
    echo "POSTGRES_USER=$pguser" >> "$out"
    echo "POSTGRES_PASSWORD=$pgpw" >> "$out"
    echo "POSTGRES_DB=$pgdb" >> "$out"
    echo "POSTGRES_HOST=$pghost" >> "$out"
    echo "POSTGRES_PORT=$pgport" >> "$out"
  fi
else
  echo "DATABASE_FILE=/var/lib/chesspuzzle/data/db.sqlite" >> "$out"
fi

# Celery defaults
echo "# Celery" >> "$out"
echo "CELERY_BROKER_URL=redis://:\${REDIS_PASSWORD}@\${REDIS_HOST}:\${REDIS_PORT}/0" >> "$out"
echo "CELERY_RESULT_BACKEND=redis://:\${REDIS_PASSWORD}@\${REDIS_HOST}:\${REDIS_PORT}/0" >> "$out"

# runtime
echo "GUNICORN_WORKERS=${GUNICORN_WORKERS:-2}" >> "$out"

# Set secure permissions
chmod 600 "$out"

# Summary
echo "Wrote $out (permissions set to 600). Keep this file secret and do not commit it."

exit 0
