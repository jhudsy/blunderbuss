#!/usr/bin/env python3
"""
Migration script to remove the 'tag' field from the Puzzle model.

This script:
1. Copies data from Puzzle.tag to Puzzle.severity where severity is NULL
2. Drops the tag column from the puzzle table

The script is idempotent and can be safely re-run. It checks if the tag column
exists before attempting migration.

Usage:
    python scripts/migrate_remove_tag_field.py

Environment Variables:
    DATABASE_FILE: Path to the database file (for SQLite)
    DATABASE_URL: PostgreSQL connection string (for PostgreSQL)

Example:
    # SQLite
    DATABASE_FILE=db.sqlite python scripts/migrate_remove_tag_field.py
    
    # PostgreSQL
    DATABASE_URL=postgresql://user:pass@localhost/dbname python scripts/migrate_remove_tag_field.py
"""

import os
import sys
from pathlib import Path

# Add parent directory to path to import models
sys.path.insert(0, str(Path(__file__).parent.parent))

from pony.orm import db_session, sql_debug
from models import db


def get_db_provider():
    """Determine which database provider is being used."""
    return db.provider.dialect


def column_exists_sqlite(table_name, column_name):
    """Check if a column exists in SQLite. Must be called within db_session."""
    result = db.execute(f"PRAGMA table_info({table_name})")
    columns = [row[1] for row in result]
    return column_name in columns


def column_exists_postgres(table_name, column_name):
    """Check if a column exists in PostgreSQL. Must be called within db_session."""
    # Use string formatting since PonyORM's execute doesn't support parameterized queries
    # for information_schema queries. Table and column names are safe since they're hardcoded.
    result = db.execute(f"""
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = '{table_name}' AND column_name = '{column_name}'
    """)
    return len(list(result)) > 0


def column_exists(table_name, column_name):
    """
    Check if a column exists in a table. Must be called within db_session.
    
    Returns True if the column exists, False otherwise.
    """
    provider = get_db_provider()
    
    if provider == 'SQLite':
        return column_exists_sqlite(table_name, column_name)
    elif provider == 'PostgreSQL':
        return column_exists_postgres(table_name, column_name)
    else:
        raise ValueError(f"Unsupported database provider: {provider}")


def migrate_tag_to_severity():
    """
    Migrate data from tag column to severity column and drop tag.
    """
    print("Starting migration: Remove tag field from Puzzle model")
    print(f"Database provider: {get_db_provider()}")
    
    # Check if tag column exists (must be done inside db_session)
    with db_session:
        if not column_exists('puzzle', 'tag'):
            print("✓ Tag column does not exist - migration already completed or not needed")
            return
    
    print("✓ Tag column exists - proceeding with migration")
    
    with db_session:
        # Step 1: Copy tag to severity where severity is NULL
        print("Step 1: Copying tag data to severity where severity is NULL...")
        
        provider = get_db_provider()
        
        if provider == 'SQLite':
            result = db.execute("""
                UPDATE Puzzle 
                SET severity = tag 
                WHERE severity IS NULL AND tag IS NOT NULL
            """)
            print(f"  Updated {result} rows")
        
        elif provider == 'PostgreSQL':
            result = db.execute("""
                UPDATE puzzle 
                SET severity = tag 
                WHERE severity IS NULL AND tag IS NOT NULL
            """)
            print(f"  Updated rows")
        
        # Step 2: Drop the tag column
        print("Step 2: Dropping tag column...")
        
        if provider == 'SQLite':
            # SQLite doesn't support DROP COLUMN directly before version 3.35.0
            # We need to recreate the table without the tag column
            print("  Note: SQLite requires table recreation to drop column")
            
            # Get current table schema
            cursor = db.get_connection().cursor()
            cursor.execute("PRAGMA table_info(Puzzle)")
            columns = cursor.fetchall()
            
            # Build new column list (excluding tag)
            new_columns = [f"{col[1]} {col[2]}" for col in columns if col[1] != 'tag']
            column_names = [col[1] for col in columns if col[1] != 'tag']
            
            # Create new table
            db.execute(f"""
                CREATE TABLE Puzzle_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user INTEGER NOT NULL,
                    game_id TEXT NOT NULL,
                    fen TEXT NOT NULL,
                    moves TEXT NOT NULL,
                    rating INTEGER,
                    rating_deviation INTEGER,
                    popularity INTEGER,
                    nb_plays INTEGER,
                    themes TEXT,
                    game_url TEXT,
                    opened_at DATETIME,
                    next_review DATETIME,
                    interval_days REAL,
                    ease_factor REAL,
                    repetitions INTEGER,
                    severity TEXT,
                    perf_type TEXT,
                    pre_fen TEXT,
                    pre_eval TEXT,
                    uci TEXT,
                    san TEXT
                )
            """)
            
            # Copy data
            column_list = ', '.join(column_names)
            db.execute(f"""
                INSERT INTO Puzzle_new ({column_list})
                SELECT {column_list} FROM Puzzle
            """)
            
            # Drop old table and rename new one
            db.execute("DROP TABLE Puzzle")
            db.execute("ALTER TABLE Puzzle_new RENAME TO Puzzle")
            
            # Note: This will lose indexes and foreign keys
            # They need to be recreated if they existed
            print("  ⚠ Warning: Indexes and foreign keys need to be recreated")
            print("  Please run models.py generate_mapping to recreate schema properly")
        
        elif provider == 'PostgreSQL':
            # PostgreSQL supports DROP COLUMN
            db.execute("ALTER TABLE puzzle DROP COLUMN tag")
            print("  ✓ Tag column dropped")
        
        db.commit()
    
    print("✓ Migration completed successfully")
    print("\nNext steps:")
    print("1. Ensure your application code no longer references the 'tag' field")
    print("2. If using SQLite, consider regenerating the database schema")
    print("3. Test puzzle import, selection, and API responses")


def main():
    """Main entry point for the migration script."""
    # Enable SQL debugging if requested
    if os.getenv('SQL_DEBUG', '').lower() in ('1', 'true', 'yes'):
        sql_debug(True)
    
    try:
        # Initialize database connection
        # The models.py init_db() will be called on import if not already initialized
        from models import init_db
        
        # Determine database path/URL
        db_url = os.getenv('DATABASE_URL')
        db_file = os.getenv('DATABASE_FILE')
        
        if db_url:
            print(f"Using PostgreSQL: {db_url.split('@')[1] if '@' in db_url else 'configured'}")
            init_db(db_url, create_tables=False)
        elif db_file:
            print(f"Using SQLite: {db_file}")
            init_db(f'sqlite:///{db_file}', create_tables=False)
        else:
            # Use default from models.py
            print("Using default database configuration")
            init_db(create_tables=False)
        
        # Run migration
        migrate_tag_to_severity()
        
        print("\n✓ All done!")
        return 0
    
    except Exception as e:
        print(f"\n✗ Migration failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    sys.exit(main())
