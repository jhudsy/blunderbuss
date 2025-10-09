#!/usr/bin/env bash
# Remove the test sqlite DB used during local pytest runs.
# Usage: ./scripts/cleanup_test_db.sh

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DB_DIR="$HERE/../.run"
DB_FILE="$DB_DIR/pytest_db.sqlite"

if [ -f "$DB_FILE" ]; then
  echo "Removing test DB: $DB_FILE"
  rm -f "$DB_FILE"
else
  echo "No test DB found at $DB_FILE"
fi

exit 0
