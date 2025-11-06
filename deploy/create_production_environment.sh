#!/usr/bin/env sh
# Interactive environment generator for ChessPuzzle production deployments.
# Usage: deploy/create_production_environment.sh [/path/to/.env]
# 
# This script creates a .env file for use with docker compose. By default it
# creates the file at the repository root (./.env) which docker compose will
# automatically read. You can specify an alternate path if needed.
#
# After creating the .env file:
# 1. Build images: docker compose -f docker-compose.prod.yml build --pull
# 2. Obtain Let's Encrypt certificates (first time):
#    docker compose -f docker-compose.prod.yml run --rm --entrypoint "" certbot \
#      certbot certonly --webroot -w /var/www/certbot \
#      --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email -d "$DOMAIN"
# 3. Start the stack: docker compose -f docker-compose.prod.yml up -d
# 4. Initialize database: docker compose -f docker-compose.prod.yml run --rm web python scripts/create_tables.py
#
# The generated .env file will be used by docker compose to configure all services
# (web, worker, redis, postgres, nginx, certbot).

set -e
out=${1:-./.env}
if [ -f "$out" ]; then
  echo "File $out already exists. Move it aside or pass a different path." >&2
  exit 1
fi

echo "Generating production environment file at $out"

echo "# Production environment for ChessPuzzle" > "$out"
echo "# Generated on $(date)" >> "$out"
echo "" >> "$out"

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
    enc_key=$(python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
)
    echo "ENCRYPTION_KEY=$enc_key" >> "$out"
  else
    echo "ENCRYPTION_KEY=$(random_secret)" >> "$out"
  fi
else
  echo "ENCRYPTION_KEY=" >> "$out"
fi
echo "" >> "$out"

# Domain / TLS
echo "# Domain / TLS" >> "$out"
read -p "Domain for this deployment (e.g. example.com): " DOMAIN
DOMAIN=${DOMAIN:-your.domain.example}
echo "DOMAIN=$DOMAIN" >> "$out"
read -p "Let's Encrypt contact email: " LE_EMAIL
LE_EMAIL=${LE_EMAIL:-ops@example.com}
echo "LETSENCRYPT_EMAIL=$LE_EMAIL" >> "$out"
echo "" >> "$out"

# Lichess OAuth
echo "# Lichess OAuth (required for login)" >> "$out"
read -p "Lichess OAuth Client ID: " lichess_id
lichess_id=${lichess_id:-your_lichess_client_id}
echo "LICHESS_CLIENT_ID=$lichess_id" >> "$out"
read -p "Lichess OAuth Client Secret: " lichess_secret
lichess_secret=${lichess_secret:-your_lichess_client_secret}
echo "LICHESS_CLIENT_SECRET=$lichess_secret" >> "$out"
echo "" >> "$out"

# Redis
echo "# Redis" >> "$out"
read -p "Use local redis service? (Y/n): " use_redis
if [ "${use_redis:-y}" = "y" ] || [ "${use_redis:-y}" = "Y" ]; then
  read -p "Redis host [redis]: " rhost
  rhost=${rhost:-redis}
  read -p "Redis port [6379]: " rport
  rport=${rport:-6379}
  echo "REDIS_HOST=$rhost" >> "$out"
  echo "REDIS_PORT=$rport" >> "$out"
  read -p "Generate REDIS_PASSWORD? (Y/n): " gen_pw
  if [ "${gen_pw:-y}" = "y" ] || [ "${gen_pw:-y}" = "Y" ]; then
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
echo "" >> "$out"

# Postgres
echo "# Postgres" >> "$out"
read -p "Use Postgres? (Y/n): " use_pg
if [ "${use_pg:-y}" = "y" ] || [ "${use_pg:-y}" = "Y" ]; then
  read -p "Provide DATABASE_URL (leave blank to use POSTGRES_* vars): " dburl
  if [ -n "$dburl" ]; then
    echo "DATABASE_URL=$dburl" >> "$out"
  else
    read -p "POSTGRES_USER [postgres]: " pguser
    pguser=${pguser:-postgres}
    read -p "POSTGRES_PASSWORD: " pgpw
    if [ -z "$pgpw" ]; then
      pgpw=$(random_secret)
      echo "Generated POSTGRES_PASSWORD: $pgpw"
    fi
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
echo "" >> "$out"

# Celery
echo "# Celery" >> "$out"
echo "CELERY_BROKER_URL=redis://:\${REDIS_PASSWORD}@\${REDIS_HOST}:\${REDIS_PORT}/0" >> "$out"
echo "CELERY_RESULT_BACKEND=redis://:\${REDIS_PASSWORD}@\${REDIS_HOST}:\${REDIS_PORT}/0" >> "$out"
echo "" >> "$out"

# Flask environment
echo "# Flask / Gunicorn runtime" >> "$out"
echo "FLASK_ENV=production" >> "$out"
echo "FLASK_HOST=0.0.0.0" >> "$out"
echo "FLASK_PORT=5000" >> "$out"
read -p "GUNICORN_WORKERS [2]: " gw
gw=${gw:-2}
echo "GUNICORN_WORKERS=$gw" >> "$out"
echo "" >> "$out"

# ProxyFix for reverse proxy
echo "# Reverse proxy configuration" >> "$out"
echo "# Set to 1 when running behind nginx with X-Forwarded-* headers" >> "$out"
echo "USE_PROXY_FIX=1" >> "$out"
echo "" >> "$out"

# DB wait helper
echo "# Database connection helper" >> "$out"
echo "DB_WAIT_TIMEOUT=60" >> "$out"
echo "DB_WAIT_INTERVAL=1.0" >> "$out"

# Set secure permissions
chmod 600 "$out"

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ Created $out (permissions set to 600)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "KEEP THIS FILE SECRET - Do not commit it to source control!"
echo ""
echo "Next steps:"
echo "  1. Review and edit $out if needed"
echo "  2. Build images:"
echo "     docker compose -f docker-compose.prod.yml build --pull"
echo ""
echo "  3. Obtain Let's Encrypt certificates (first time only):"
echo "     docker compose -f docker-compose.prod.yml run --rm --entrypoint \"\" certbot \\"
echo "       certbot certonly --webroot -w /var/www/certbot \\"
echo "       --email \"\$LETSENCRYPT_EMAIL\" --agree-tos --no-eff-email -d \"\$DOMAIN\""
echo ""
echo "  4. Start the production stack:"
echo "     docker compose -f docker-compose.prod.yml up -d"
echo ""
echo "  5. Initialize the database (first time only):"
echo "     docker compose -f docker-compose.prod.yml run --rm web python scripts/create_tables.py"
echo ""
echo "  6. Check status:"
echo "     docker compose -f docker-compose.prod.yml ps"
echo "     docker compose -f docker-compose.prod.yml logs -f web"
echo ""
echo "For more information, see docs/DEPLOYMENT.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exit 0
