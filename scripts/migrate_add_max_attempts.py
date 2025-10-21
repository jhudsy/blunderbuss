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

from models import init_db, db
from pony.orm import db_session

def check_column_exists(table_name, column_name):
    """Check if a column exists in a table."""
    provider = db.provider
    provider_name = provider.dialect if hasattr(provider, 'dialect') else str(provider)
    
    with db_session:
        if 'postgres' in provider_name.lower():
            # PostgreSQL
            result = db.select("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = $table_name 
                AND column_name = $column_name
            """)
            return len(list(result)) > 0
        elif 'sqlite' in provider_name.lower():
            # SQLite
            cursor = provider.pool.connect().cursor()
            cursor.execute(f"PRAGMA table_info({table_name})")
            columns = [row[1] for row in cursor.fetchall()]
            cursor.close()
            return column_name in columns
        else:
            print(f'Warning: Unknown provider {provider_name}, cannot check column existence')
            return False

def migrate():
    """Add settings_max_attempts column to User table."""
    print('Starting migration: Add settings_max_attempts to User table')
    
    # Bind database
    init_db(create_tables=False)
    
    provider = db.provider
    if not provider:
        print('Error: Database provider not initialized')
        return False
    
    provider_name = provider.dialect if hasattr(provider, 'dialect') else str(provider)
    print(f'Database provider: {provider_name}')
    
    # Check if column already exists
    if check_column_exists('User', 'settings_max_attempts'):
        print('Column settings_max_attempts already exists, skipping migration')
        return True
    
    print('Adding settings_max_attempts column...')
    
    try:
        connection = provider.pool.connect()
        cursor = connection.cursor()
        
        if 'postgres' in provider_name.lower():
            # PostgreSQL
            cursor.execute("""
                ALTER TABLE "User" 
                ADD COLUMN settings_max_attempts INTEGER DEFAULT 3
            """)
            print('Added column to PostgreSQL table')
        elif 'sqlite' in provider_name.lower():
            # SQLite
            cursor.execute("""
                ALTER TABLE "User" 
                ADD COLUMN settings_max_attempts INTEGER DEFAULT 3
            """)
            print('Added column to SQLite table')
        else:
            print(f'Error: Unsupported database provider {provider_name}')
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
