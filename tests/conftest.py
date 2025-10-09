import os
import shutil
import pytest


@pytest.fixture(scope='session', autouse=True)
def ensure_clean_test_db():
    """Ensure the test SQLite DB is removed before and after the test session.

    This keeps tests deterministic: tests that map DATABASE_FILE=':memory:' are
    routed to a shared file at .run/pytest_db.sqlite; remove that file so each
    test run starts with a fresh DB.
    """
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    run_dir = os.path.join(repo_root, '.run')
    os.makedirs(run_dir, exist_ok=True)
    db_file = os.path.join(run_dir, 'pytest_db.sqlite')

    # If no DATABASE_FILE provided, default to the shared file used in CI/local runs
    os.environ.setdefault('DATABASE_FILE', db_file)

    # remove stale DB before starting tests
    if os.path.exists(db_file):
        try:
            os.remove(db_file)
        except Exception:
            # best-effort; continue even if removal fails
            pass

    yield

    # teardown: remove DB file to avoid leaking between runs
    try:
        if os.path.exists(db_file):
            os.remove(db_file)
    except Exception:
        pass
import os
import sys

# Prepend repository root to sys.path so tests import local modules before stdlib
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
