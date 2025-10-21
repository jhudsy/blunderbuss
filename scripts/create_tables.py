"""Create DB mappings/tables for the ChessPuzzle app.

This script binds the PonyORM models using the same environment variables
that the application uses and calls `init_db(create_tables=True)` to
create any missing tables.

Usage (recommended):
  docker compose run --rm web python scripts/create_tables.py

With --drop flag (DESTRUCTIVE - drops all tables before creating):
  docker compose run --rm web python scripts/create_tables.py --drop

Or (when running directly in a container):
  python scripts/create_tables.py
  python scripts/create_tables.py --drop

The script is idempotent: it will not re-bind an already-initialized DB
and will simply return if models are already bound.

The --drop flag provides a brute-force migration path by dropping all
existing tables before recreating them. USE WITH CAUTION: all data will
be lost.
"""

import os
import sys
import argparse

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

def drop_all_tables():
    """Drop all tables from the database.
    
    This is a destructive operation that will delete all data.
    Works with both PostgreSQL and SQLite.
    """
    print('WARNING: Dropping all tables...')
    
    # First, bind the database without creating tables
    init_db(create_tables=False)
    
    # Get the provider to determine database type
    provider = getattr(db, 'provider', None)
    if not provider:
        print('Error: Database provider not initialized')
        return False
    
    provider_name = provider.dialect if hasattr(provider, 'dialect') else str(provider)
    print(f'Database provider: {provider_name}')
    
    try:
        # Use PonyORM's drop_all_tables method if available
        if hasattr(db, 'drop_all_tables'):
            db.drop_all_tables(with_all_data=True)
            print('Dropped all tables using PonyORM method')
        else:
            # Fallback: use raw SQL
            # Get connection from provider
            connection = provider.pool.connect()
            cursor = connection.cursor()
            
            if 'postgres' in provider_name.lower():
                # PostgreSQL: Drop all tables in public schema
                cursor.execute("""
                    DO $$ DECLARE
                        r RECORD;
                    BEGIN
                        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
                            EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
                        END LOOP;
                    END $$;
                """)
                print('Dropped all PostgreSQL tables')
            elif 'sqlite' in provider_name.lower():
                # SQLite: Get all tables and drop them
                cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
                tables = cursor.fetchall()
                for table in tables:
                    table_name = table[0]
                    if table_name != 'sqlite_sequence':  # Skip internal table
                        cursor.execute(f'DROP TABLE IF EXISTS "{table_name}"')
                print(f'Dropped {len(tables)} SQLite tables')
            else:
                print(f'Warning: Unknown database type {provider_name}, attempting generic drop')
                # Try generic approach
                db.drop_all_tables(with_all_data=True)
            
            connection.commit()
            cursor.close()
            connection.close()
        
        return True
    except Exception as e:
        print(f'Error dropping tables: {e}')
        import traceback
        traceback.print_exc()
        return False

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Create database tables for ChessPuzzle',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        '--drop',
        action='store_true',
        help='Drop all existing tables before creating new ones (DESTRUCTIVE)'
    )
    
    args = parser.parse_args()
    
    if args.drop:
        print('=' * 60)
        print('WARNING: --drop flag specified')
        print('This will DELETE ALL DATA from the database!')
        print('=' * 60)
        response = input('Are you sure you want to continue? (yes/no): ')
        if response.lower() != 'yes':
            print('Aborted.')
            sys.exit(0)
        
        if drop_all_tables():
            print('Successfully dropped all tables')
        else:
            print('Failed to drop tables')
            sys.exit(1)
    
    print('Binding DB and generating mappings (create_tables=True)')
    init_db(create_tables=True)
    print('Done. Pony provider:', getattr(db, 'provider', None))
