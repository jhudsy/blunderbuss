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

import os
import sys

# When this script is executed as `python scripts/create_tables.py` the
# interpreter places the `scripts` directory at sys.path[0], which means
# Python won't automatically find sibling modules at the project root
# (for example `models.py` at /app/models.py). Ensure the project root
# (parent of the scripts directory) is on sys.path so `from models import ...`
# works regardless of how the script is invoked.
_HERE = os.path.dirname(__file__)
_PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, '..'))
if _PROJECT_ROOT not in sys.path:
  sys.path.insert(0, _PROJECT_ROOT)

from models import init_db, db

if __name__ == '__main__':
    print('Binding DB and generating mappings (create_tables=True)')
    init_db(create_tables=True)
    print('Done. Pony provider:', getattr(db, 'provider', None))
