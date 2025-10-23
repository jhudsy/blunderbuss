"""Migration: Add weekly XP tracking fields to User table.

This migration adds the xp_this_week and week_start_date columns to the User
table to support weekly leaderboards.

- xp_this_week: INTEGER DEFAULT 0 - Tracks XP accumulated during the current week
- week_start_date: TEXT/VARCHAR - ISO date string (YYYY-MM-DD) of the Monday that started the week

Weekly XP tracking resets every Monday at midnight UTC. The backend
automatically manages resetting xp_this_week and updating week_start_date
when a new week begins.

Usage:
  docker compose run --rm web python scripts/migrate_add_weekly_xp.py

Or when running directly:
  python scripts/migrate_add_weekly_xp.py

The migration is idempotent: if the columns already exist, it will skip
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
import os

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
    """Add xp_this_week and week_start_date columns to User table."""
    print('Starting migration: Add weekly XP tracking fields to User table')
    
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
    
    # Check if columns already exist
    xp_exists = check_column_exists(cursor, provider_type, 'User', 'xp_this_week')
    week_exists = check_column_exists(cursor, provider_type, 'User', 'week_start_date')
    
    if xp_exists and week_exists:
        print('Both xp_this_week and week_start_date columns already exist, skipping migration')
        cursor.close()
        connection.close()
        return True
    
    try:
        if provider_type == 'postgres':
            # PostgreSQL - use lowercase unquoted table name (PonyORM default)
            if not xp_exists:
                print('Adding xp_this_week column...')
                cursor.execute("""
                    ALTER TABLE "user" 
                    ADD COLUMN xp_this_week INTEGER DEFAULT 0
                """)
                print('Added xp_this_week column to PostgreSQL table')
            else:
                print('xp_this_week column already exists, skipping')
            
            if not week_exists:
                print('Adding week_start_date column...')
                cursor.execute("""
                    ALTER TABLE "user" 
                    ADD COLUMN week_start_date VARCHAR
                """)
                print('Added week_start_date column to PostgreSQL table')
            else:
                print('week_start_date column already exists, skipping')
                
        elif provider_type == 'sqlite':
            # SQLite
            if not xp_exists:
                print('Adding xp_this_week column...')
                cursor.execute("""
                    ALTER TABLE "User" 
                    ADD COLUMN xp_this_week INTEGER DEFAULT 0
                """)
                print('Added xp_this_week column to SQLite table')
            else:
                print('xp_this_week column already exists, skipping')
            
            if not week_exists:
                print('Adding week_start_date column...')
                cursor.execute("""
                    ALTER TABLE "User" 
                    ADD COLUMN week_start_date TEXT
                """)
                print('Added week_start_date column to SQLite table')
            else:
                print('week_start_date column already exists, skipping')
        else:
            print(f'Error: Unsupported database provider {provider_type}')
            cursor.close()
            connection.close()
            return False
        
        connection.commit()
        cursor.close()
        connection.close()
        
        print('Migration completed successfully')
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
    print('Migration: Add weekly XP tracking fields')
    print('=' * 60)
    
    success = migrate()
    
    if success:
        print('\n✓ Migration completed successfully')
        sys.exit(0)
    else:
        print('\n✗ Migration failed')
        sys.exit(1)
