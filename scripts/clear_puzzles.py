#!/usr/bin/env python3
"""Safe script to clear Puzzle rows from the database.

Usage:
  # show how many puzzles would be removed (dry-run)
  python scripts/clear_puzzles.py --dry-run

  # remove all puzzles (requires explicit confirmation)
  FORCE_CLEAR_PUZZLES=1 python scripts/clear_puzzles.py --yes

  # remove puzzles for a specific user
  python scripts/clear_puzzles.py --user jhudsy --yes

This script intentionally requires an explicit confirmation flag (--yes) or
an environment variable FORCE_CLEAR_PUZZLES=1 to avoid accidental data loss.
"""
import argparse
import os
import sys
from pony.orm import db_session

# Import app models lazily so this script can be executed from the project root
from models import init_db, Puzzle, User


def parse_args():
    p = argparse.ArgumentParser(description='Safely clear Puzzle rows from the DB')
    p.add_argument('--user', help='Optional username to restrict deletion to that user')
    p.add_argument('--dry-run', action='store_true', help='Show counts but do not delete')
    p.add_argument('--yes', action='store_true', help='Confirm deletion (or set FORCE_CLEAR_PUZZLES=1)')
    return p.parse_args()


def confirm_proceed(args):
    if args.yes or os.environ.get('FORCE_CLEAR_PUZZLES') == '1':
        return True
    print('\nThis operation will PERMANENTLY DELETE puzzles from the database.')
    print('To proceed non-interactively pass --yes or set FORCE_CLEAR_PUZZLES=1')
    ans = input('Type "DELETE" to confirm, or anything else to abort: ')
    return ans.strip() == 'DELETE'


def main():
    args = parse_args()
    # initialize DB mapping using default settings (models.init_db will bind to DATABASE_URL or sqlite)
    init_db()
    with db_session:
        if args.user:
            u = User.get(username=args.user)
            if not u:
                print(f'User "{args.user}" not found; nothing to delete')
                return 0
            total = list(Puzzle.select(lambda p: p.user == u))
            print(f'Found {len(total)} puzzles for user "{args.user}"')
        else:
            total = list(Puzzle.select())
            print(f'Found {len(total)} total puzzles')

        if args.dry_run:
            print('Dry-run mode: no changes made')
            return 0

        if not confirm_proceed(args):
            print('Aborted by user')
            return 1

        deleted = 0
        for p in total:
            try:
                p.delete()
                deleted += 1
            except Exception as e:
                print(f'Failed to delete puzzle id={getattr(p, "id", None)}: {e}')
        print(f'Deleted {deleted} puzzles')
    return 0


if __name__ == '__main__':
    sys.exit(main())
