"""Migration: Add settings_max_attempts field to User table.

This migration adds the settings_max_attempts column to the User table
with a default value of 3 (range 1-3).

This field controls the maximum number of incorrect attempts allowed per
puzzle before the solution is automatically revealed. Each incorrect attempt
halves the XP reward.

Usage:
  docker compose run --rm web python scripts/migrate_add_max_attempts.py

Or when running directly:
  python scripts/migrate_add_max_attempts.py

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
    else:
        # Fall back to SQLite
        import sqlite3
        db_file = os.environ.get('DATABASE_FILE', 'db.sqlite')
        return sqlite3.connect(db_file), 'sqlite'

def check_column_exists(cursor, provider_type, table_name, column_name):
    """Check if a column exists in a table."""
    if provider_type == 'postgres':
        # PostgreSQL
        cursor.execute("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = %s 
            AND column_name = %s
        """, (table_name, column_name))
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
    """Add settings_max_attempts column to User table."""
    print('Starting migration: Add settings_max_attempts to User table')
    
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
    if check_column_exists(cursor, provider_type, 'User', 'settings_max_attempts'):
        print('Column settings_max_attempts already exists, skipping migration')
        cursor.close()
        connection.close()
        return True
    
    print('Adding settings_max_attempts column...')
    
    try:
        if provider_type == 'postgres':
            # PostgreSQL
            cursor.execute("""
                ALTER TABLE "User" 
                ADD COLUMN settings_max_attempts INTEGER DEFAULT 3
            """)
            print('Added column to PostgreSQL table')
        elif provider_type == 'sqlite':
            # SQLite
            cursor.execute("""
                ALTER TABLE "User" 
                ADD COLUMN settings_max_attempts INTEGER DEFAULT 3
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
    print('Migration: Add settings_max_attempts field')
    print('=' * 60)
    
    success = migrate()
    
    if success:
        print('\n✓ Migration completed successfully')
        sys.exit(0)
    else:
        print('\n✗ Migration failed')
        sys.exit(1)
