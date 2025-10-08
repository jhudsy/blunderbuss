Migration: SQLite -> Postgres (guide)
=====================================

This document outlines a practical way to migrate the app's SQLite database to
Postgres. The project uses PonyORM; migrating the DB files is orthogonal to
changing the ORM connection string.

Recommended approach: use `pgloader` which can move data and attempt type/schema
translation for you. Install pgloader (see your platform packages) and run:

```bash
# Example (local Postgres running on default port):
pgloader sqlite:///path/to/db.sqlite postgresql://pguser:pgpass@pghost:5432/dbname
```

Notes:
- Test the migration on a copy of your DB before touching production.
- Review the generated schema in Postgres for data types and indexes.
- PonyORM connection change: set the DB connection URL in your app (for
  example via `DATABASE_URL` env var) and update `models.init_db()` to use the
  Postgres connection. Example snippet using PonyORM:

```python
from pony.orm import Database
db = Database()
# ... define entities ...

def init_db():
    db.bind(provider='postgres', user=os.environ['PGUSER'], password=os.environ['PGPASS'], host=os.environ.get('PGHOST','localhost'), database=os.environ['PGDB'])
    db.generate_mapping(create_tables=False)
```

After migration:
- Run your test suite against the Postgres DB.
- Back up Postgres regularly (pg_dump / managed snapshots).

If you prefer not to use pgloader, another approach is:
1. Use `sqlite3` to export each table to CSV.
2. Create tables in Postgres (match PonyORM mapping) and `COPY` the CSVs into Postgres.

Troubleshooting
- If you see encoding issues, check PRAGMA encoding in SQLite and client_encoding in Postgres.
- If PonyORM complains about missing indexes/constraints, create them manually in Postgres and re-run tests.
