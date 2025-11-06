"""Migration: Add previous_fen field to Puzzle table.

This migration adds the previous_fen column to the Puzzle table. This field
stores the board position BEFORE the opponent's move that led to the current
puzzle position, enabling the frontend to:
1. Display the position before the blunder
2. Animate the opponent's move
3. Let the user solve from the resulting position

The field is nullable for backwards compatibility with existing puzzles.

Note: This migration only adds the column with NULL values. Existing puzzles
cannot be backfilled without access to their original PGN game data. The
previous_fen field will be populated automatically for newly imported puzzles.

Usage:
  docker compose run --rm web python scripts/migrate_add_previous_fen.py

Or when running directly:
  python scripts/migrate_add_previous_fen.py

The migration is idempotent: if the column already exists, it will skip
the migration gracefully.
"""

import os
import sys

# Ensure project root is on sys.path
_HERE = os.path.dirname(__file__)
_PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from models import db

def get_db_connection():
    """Get a raw database connection without binding PonyORM models."""
    # Read database configuration from environment
    database_url = os.environ.get('DATABASE_URL')
    
    if database_url:
        # Parse DATABASE_URL (postgres:// or postgresql://)
        if database_url.startswith('postgres://') or database_url.startswith('postgresql://'):
            import psycopg2
            return psycopg2.connect(database_url), 'postgres'
        else:
            raise ValueError(f'Unsupported DATABASE_URL: {database_url}')
    
    # Check for individual PostgreSQL environment variables
    pg_host = os.environ.get('PGHOST') or os.environ.get('POSTGRES_HOST')
    pg_db = os.environ.get('PGDATABASE') or os.environ.get('POSTGRES_DB')
    pg_user = os.environ.get('PGUSER') or os.environ.get('POSTGRES_USER')
    pg_password = os.environ.get('PGPASSWORD') or os.environ.get('POSTGRES_PASSWORD')
    pg_port = os.environ.get('PGPORT') or os.environ.get('POSTGRES_PORT') or '5432'
    
    if pg_host and pg_db:
        # Build PostgreSQL connection
        import psycopg2
        print(f'Connecting to PostgreSQL: host={pg_host}, database={pg_db}, user={pg_user}, port={pg_port}')
        conn_params = {
            'host': pg_host,
            'database': pg_db,
            'port': pg_port
        }
        if pg_user:
            conn_params['user'] = pg_user
        if pg_password:
            conn_params['password'] = pg_password
        
        return psycopg2.connect(**conn_params), 'postgres'
    
    # Fall back to SQLite
    import sqlite3
    db_file = os.environ.get('DATABASE_FILE', 'db.sqlite')
    print(f'No PostgreSQL configuration found, using SQLite: {db_file}')
    return sqlite3.connect(db_file), 'sqlite'

def check_column_exists(cursor, provider_type, table_name, column_name):
    """Check if a column exists in a table."""
    if provider_type == 'postgres':
        # PostgreSQL - check with lowercase table name (PonyORM default)
        cursor.execute("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = %s 
            AND column_name = %s
        """, (table_name.lower(), column_name))
        return cursor.fetchone() is not None
    elif provider_type == 'sqlite':
        # SQLite
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns = [row[1] for row in cursor.fetchall()]
        return column_name in columns
    else:
        print(f'Warning: Unknown provider {provider_type}, cannot check column existence')
        return False

def migrate():
    """Add previous_fen column to Puzzle table."""
    print('Starting migration: Add previous_fen to Puzzle table')
    
    # Get raw database connection without binding PonyORM models
    try:
        connection, provider_type = get_db_connection()
        cursor = connection.cursor()
    except Exception as e:
        print(f'Error connecting to database: {e}')
        import traceback
        traceback.print_exc()
        return False
    
    print(f'Database provider: {provider_type}')
    
    # Check if column already exists
    if check_column_exists(cursor, provider_type, 'Puzzle', 'previous_fen'):
        print('Column previous_fen already exists, skipping migration')
        cursor.close()
        connection.close()
        return True
    
    print('Adding previous_fen column...')
    
    try:
        if provider_type == 'postgres':
            # PostgreSQL - use lowercase unquoted table name (PonyORM default)
            cursor.execute("""
                ALTER TABLE "puzzle" 
                ADD COLUMN previous_fen TEXT
            """)
            print('Added column to PostgreSQL table')
        elif provider_type == 'sqlite':
            # SQLite
            cursor.execute("""
                ALTER TABLE "Puzzle" 
                ADD COLUMN previous_fen TEXT
            """)
            print('Added column to SQLite table')
        else:
            print(f'Error: Unsupported database provider {provider_type}')
            cursor.close()
            connection.close()
            return False
        
        connection.commit()
        cursor.close()
        connection.close()
        
        print('Migration completed successfully')
        print('')
        print('Note: Existing puzzles will have NULL previous_fen values.')
        print('The frontend will gracefully handle this by skipping the opponent')
        print('move animation and displaying the puzzle position directly.')
        print('')
        print('New puzzles imported via PGN will automatically have previous_fen populated.')
        return True
        
    except Exception as e:
        print(f'Error during migration: {e}')
        import traceback
        traceback.print_exc()
        try:
            connection.rollback()
            cursor.close()
            connection.close()
        except:
            pass
        return False

if __name__ == '__main__':
    print('=' * 60)
    print('Migration: Add previous_fen field')
    print('=' * 60)
    print('')
    
    success = migrate()
    
    if success:
        print('\n✓ Migration completed successfully')
        sys.exit(0)
    else:
        print('\n✗ Migration failed')
        sys.exit(1)
