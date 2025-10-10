"""Create DB mappings/tables for the ChessPuzzle app.

This script binds the PonyORM models using the same environment variables
that the application uses and calls `init_db(create_tables=True)` to
create any missing tables.

Usage (recommended):
  docker compose run --rm web python scripts/create_tables.py

Or (when running directly in a container):
  python scripts/create_tables.py

The script is idempotent: it will not re-bind an already-initialized DB
and will simply return if models are already bound.
"""

from models import init_db, db

if __name__ == '__main__':
    print('Binding DB and generating mappings (create_tables=True)')
    init_db(create_tables=True)
    print('Done. Pony provider:', getattr(db, 'provider', None))
