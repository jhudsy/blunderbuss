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

# Ensure the repository root is on sys.path so `import models` works whether
# the script is invoked as `/app/clear_puzzles.py` (a symlink created in the
# image) or `/app/scripts/clear_puzzles.py`. Use realpath to resolve symlinks
# so we compute the correct repo root even when __file__ points at a symlink.
_this_dir = os.path.dirname(os.path.realpath(__file__))
_repo_root = os.path.abspath(os.path.join(_this_dir, '..'))
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

# Import app models lazily so this script can be executed from the project root
from models import init_db, Puzzle, User


def parse_args():
    p = argparse.ArgumentParser(description='Safely clear Puzzle rows from the DB')
    p.add_argument('--user', help='Optional username to restrict deletion to that user')
    p.add_argument('--dry-run', action='store_true', help='Show counts but do not delete')
    p.add_argument('--yes', action='store_true', help='Confirm deletion (or set FORCE_CLEAR_PUZZLES=1)')
    p.add_argument('--delete-user', action='store_true', help='Delete the specified user (and their puzzles/badges). Requires --user')
    p.add_argument('--delete-all-users', action='store_true', help='Delete ALL users and their related puzzles/badges (use with extreme caution)')
    p.add_argument('--clear-badges', action='store_true', help='Only delete Badge rows (optionally restricted to --user)')
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
        # Determine targets based on flags
        target_user = None
        if args.user:
            target_user = User.get(username=args.user)
            if not target_user:
                print(f'User "{args.user}" not found; nothing to delete')
                return 0

        if args.clear_badges:
            # badges only
            if target_user:
                from models import Badge
                to_delete = list(Badge.select(lambda b: b.user == target_user))
                print(f'Found {len(to_delete)} badges for user "{args.user}"')
            else:
                from models import Badge
                to_delete = list(Badge.select())
                print(f'Found {len(to_delete)} total badges')
            if args.dry_run:
                print('Dry-run mode: no changes made')
                return 0
            if not confirm_proceed(args):
                print('Aborted by user')
                return 1
            deleted = 0
            for b in to_delete:
                try:
                    b.delete()
                    deleted += 1
                except Exception as e:
                    print(f'Failed to delete badge id={getattr(b, "id", None)}: {e}')
            print(f'Deleted {deleted} badges')
            return 0

        if args.delete_all_users:
            users = list(User.select())
            print(f'Found {len(users)} users (will delete users, their puzzles and badges)')
            if args.dry_run:
                print('Dry-run mode: no changes made')
                return 0
            if not confirm_proceed(args):
                print('Aborted by user')
                return 1
            deleted_users = 0
            for uu in users:
                try:
                    # delete related puzzles and badges via cascading or explicit deletes
                    # PonyORM will handle FK cascades if set; to be safe, delete related rows explicitly
                    for p in list(Puzzle.select(lambda p: p.user == uu)):
                        p.delete()
                    from models import Badge
                    for b in list(Badge.select(lambda b: b.user == uu)):
                        b.delete()
                    uu.delete()
                    deleted_users += 1
                except Exception as e:
                    print(f'Failed to delete user {getattr(uu, "username", None)}: {e}')
            print(f'Deleted {deleted_users} users')
            return 0

        # normal puzzle deletion path
        if target_user:
            total = list(Puzzle.select(lambda p: p.user == target_user))
            print(f'Found {len(total)} puzzles for user "{args.user}"')
        else:
            total = list(Puzzle.select())
            print(f'Found {len(total)} total puzzles')

        # delete user only (with their puzzles/badges) when requested
        if args.delete_user:
            if not target_user:
                print('--delete-user requires --user')
                return 1
            print(f'User deletion requested for "{args.user}" (will remove puzzles and badges)')
            if args.dry_run:
                print('Dry-run mode: no changes made')
                return 0
            if not confirm_proceed(args):
                print('Aborted by user')
                return 1
            deleted = 0
            try:
                for p in list(Puzzle.select(lambda p: p.user == target_user)):
                    p.delete()
                    deleted += 1
                from models import Badge
                for b in list(Badge.select(lambda b: b.user == target_user)):
                    b.delete()
                target_user.delete()
                print(f'Deleted user "{args.user}" and {deleted} puzzles')
            except Exception as e:
                print(f'Failed to delete user "{args.user}": {e}')
            return 0

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
